import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAddonDraft, validateAddonManifestUrl, validateAddonOrdering, validateAddonStatus, type AddonDraft } from '$lib/server/streaming/addon-validation';
import { mapAddonRow, mapAddonToInsert } from '$lib/server/streaming/addons';
import type { StreamingAddonRow } from '$lib/server/streaming/addons';
import { parseProviderForm, parseSourceForm, StreamingValidationError } from '$lib/server/streaming/validation';
import { addonStatuses, isStreamingAddonStatus, type StreamingAddon } from '$lib/shared/streaming-addons';

// Phase 1: Stremio HTTP addon FOUNDATION contract tests.
//
// Scope: database/model contract only — types, validation, DB<->domain
// mapping, migration security posture. NO resolution, NO manifest fetching,
// NO playback, NO torrent/P2P configuration. Existing streaming
// provider/source behavior must remain untouched.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

function throwsStreamingValidation(action: () => unknown, label: string) {
  assert.throws(action, StreamingValidationError, label);
  passed += 1;
}

function form(values: Record<string, string | boolean>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, String(value));
  return form;
}

const VALID_DRAFT = {
  name: 'Example Stremio Addon',
  slug: 'example-stremio-addon',
  manifestUrl: 'https://example-stremio-addon.example/manifest.json',
  enabled: true,
  status: 'active',
  ordering: 3,
  supportedTypes: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['stream'],
  capabilities: { streams: true },
  notes: 'Phase 1 fixture'
};

// ---------------------------------------------------------------------------
// 1. Valid addon model
// ---------------------------------------------------------------------------
{
  const draft: AddonDraft = validateAddonDraft(VALID_DRAFT);
  ok(draft.name === 'Example Stremio Addon', 'valid draft keeps name');
  ok(draft.slug === 'example-stremio-addon', 'valid draft keeps slug');
  ok(draft.manifestUrl === 'https://example-stremio-addon.example/manifest.json', 'valid draft keeps manifest URL');
  ok(draft.enabled === true, 'valid draft keeps enabled flag');
  ok(draft.status === 'active', 'valid draft keeps status');
  ok(draft.ordering === 3, 'valid draft keeps ordering');
  ok(Array.isArray(draft.supportedTypes) && draft.supportedTypes.length === 2, 'valid draft keeps supportedTypes');
  ok(draft.capabilities.streams === true, 'valid draft keeps capabilities object');
}

// ---------------------------------------------------------------------------
// 2. Invalid slug (same contract as streaming_providers)
// ---------------------------------------------------------------------------
{
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, slug: 'Invalid_Slug' }), 'uppercase/underscore slug rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, slug: '-leading-hyphen' }), 'leading-hyphen slug rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, slug: 'double--hyphen' }), 'double-hyphen slug rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, slug: '' }), 'empty slug rejected');
}

// ---------------------------------------------------------------------------
// 3. Invalid status
// ---------------------------------------------------------------------------
{
  throwsStreamingValidation(() => validateAddonStatus('beta'), 'unknown status rejected');
  throwsStreamingValidation(() => validateAddonStatus('ACTIVE'), 'status is case-sensitive');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, status: 'retired' }), 'invalid draft status rejected');
  for (const status of addonStatuses) ok(isStreamingAddonStatus(status), `status "${status}" is a valid addon status`);
  ok(validateAddonStatus(undefined) === 'experimental', 'status defaults to experimental');
}

// ---------------------------------------------------------------------------
// 4. Invalid ordering
// ---------------------------------------------------------------------------
{
  throwsStreamingValidation(() => validateAddonOrdering(-1), 'negative ordering rejected');
  throwsStreamingValidation(() => validateAddonOrdering(1.5), 'fractional ordering rejected');
  throwsStreamingValidation(() => validateAddonOrdering('abc'), 'non-numeric ordering rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, ordering: -10 }), 'invalid draft ordering rejected');
  ok(validateAddonOrdering(undefined) === 0, 'ordering defaults to 0');
  ok(validateAddonOrdering('12') === 12, 'numeric-string ordering accepted');
}

// ---------------------------------------------------------------------------
// 5. Invalid manifest URL (syntactic only — Phase 1 NEVER fetches)
// ---------------------------------------------------------------------------
{
  throwsStreamingValidation(() => validateAddonManifestUrl('not-a-url'), 'relative/non-URL manifest rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl('ftp://example.com/manifest.json'), 'ftp scheme rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl('javascript:alert(1)'), 'javascript scheme rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl('https://user:pass@example.com/manifest.json'), 'credentials in manifest URL rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl('https://example.com/manifest.json with space'), 'whitespace in manifest URL rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl(''), 'empty manifest URL rejected');
  throwsStreamingValidation(() => validateAddonManifestUrl(`https://example.com/${'a'.repeat(2100)}`), 'overlong manifest URL rejected');
  // Syntactic validation accepts http (Stremio dev addons) — fetching is Phase 2.
  ok(validateAddonManifestUrl('http://127.0.0.1:11465/manifest.json') === 'http://127.0.0.1:11465/manifest.json', 'http manifest URL accepted syntactically');
  ok(validateAddonManifestUrl('https://example.com/manifest.json') === 'https://example.com/manifest.json', 'https manifest URL accepted');
}

// ---------------------------------------------------------------------------
// 6. Valid optional metadata + normalization defaults
// ---------------------------------------------------------------------------
{
  const draft = validateAddonDraft({ name: '  Minimal Addon  ', slug: 'minimal-addon', manifestUrl: 'https://minimal.example/manifest.json' });
  ok(draft.name === 'Minimal Addon', 'name is trimmed');
  ok(draft.enabled === false, 'enabled defaults to false');
  ok(draft.status === 'experimental', 'status defaults to experimental');
  ok(draft.ordering === 0, 'ordering defaults to 0');
  ok(draft.description === undefined, 'description is optional');
  ok(draft.logo === undefined, 'logo is optional');
  ok(draft.version === undefined, 'version is optional');
  ok(draft.idProperty === undefined, 'idProperty is optional');
  ok(draft.supportedTypes.length === 0 && draft.idPrefixes.length === 0 && draft.resources.length === 0, 'metadata arrays default to empty');
  ok(Object.keys(draft.capabilities).length === 0, 'capabilities default to empty object');
  const deduped = validateAddonDraft({ ...VALID_DRAFT, supportedTypes: ['movie', 'movie', 'series'], idPrefixes: [] });
  ok(deduped.supportedTypes.length === 2, 'array values are deduplicated');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, supportedTypes: [42] }), 'non-string array item rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, capabilities: [1, 2] }), 'array capabilities rejected');
  throwsStreamingValidation(() => validateAddonDraft({ ...VALID_DRAFT, capabilities: 'nope' }), 'string capabilities rejected');
  throwsStreamingValidation(() => validateAddonDraft('nope'), 'non-object draft rejected');
}

// ---------------------------------------------------------------------------
// 7. Torrent-related configuration is NOT introduced in the DB schema
//    (Phase 20: addon VALIDATION no longer rejects P2P/torrent terminology —
//    a valid stream addon is accepted regardless of transport concepts.
//    The DB schema still carries no torrent-specific columns.)
// ---------------------------------------------------------------------------
{
  const draft: AddonDraft = validateAddonDraft(VALID_DRAFT);
  const modelKeys = Object.keys(draft);
  // Phase 20: the model KEYS themselves still don't carry torrent concepts
  // (the model fields are name/slug/manifestUrl/etc. — none are torrent-specific).
  const forbidden = ['torrent', 'p2p', 'magnet', 'tracker', 'peer', 'debrid', 'rtorrent', 'announce', 'infohash'];
  for (const key of modelKeys) ok(!forbidden.some((token) => key.toLowerCase().includes(token)), `model field "${key}" carries no torrent/P2P concept`);
  // Phase 20: capabilities with torrent/P2P keys are NOW ACCEPTED (not rejected).
  // A valid stream addon with P2P/torrent capabilities must pass validation.
  const p2pDraft = validateAddonDraft({ ...VALID_DRAFT, capabilities: { torrent: true, p2pSupport: true } });
  ok(p2pDraft.capabilities.torrent === true, 'Phase 20: torrent capability key is ACCEPTED (not rejected)');
  ok(p2pDraft.capabilities.p2pSupport === true, 'Phase 20: p2pSupport capability key is ACCEPTED');
  const debridDraft = validateAddonDraft({ ...VALID_DRAFT, capabilities: { debridProvider: 'x' } });
  ok(debridDraft.capabilities.debridProvider === 'x', 'Phase 20: debridProvider capability key is ACCEPTED');

  const migration = readFileSync(new URL('../supabase/migrations/20260918000000_phase1_stremio_addons.sql', import.meta.url), 'utf8');
  // Scan the executable DDL (SQL comments stripped) — the header documents
  // scope in prose, the CONTRACT is what the database actually enforces.
  const ddl = migration.replace(/--[^\n]*/g, '');
  for (const token of forbidden) ok(!new RegExp(`\\b${token}`, 'i').test(ddl), `migration DDL contains no "${token}" configuration`);
  ok(migration.includes('create table if not exists public.streaming_addons'), 'migration creates streaming_addons');
  ok(migration.includes("manifest_url ~ '^https?://[^[:space:]]+$'"), 'migration enforces syntactic http(s) manifest URLs');
  ok(migration.includes("status in ('active', 'disabled', 'maintenance', 'experimental', 'unavailable')"), 'migration constrains addon status values');
  ok(migration.includes('ordering integer not null default 0 check (ordering >= 0)'), 'migration constrains ordering >= 0');
  ok(migration.includes("jsonb_typeof(capabilities) = 'object'"), 'migration requires capabilities to be a JSON object');
}

// ---------------------------------------------------------------------------
// 8. Existing streaming provider/source types remain unchanged
// ---------------------------------------------------------------------------
{
  const provider = parseProviderForm(form({ name: 'Fixture Provider', slug: 'fixture-provider', status: 'experimental', integration_type: 'template', capabilities: '{"movies":true}', enabled: false }));
  assert.deepEqual(provider.capabilities, { movies: true, sandbox_policy: 'required' });
  passed += 1;
  ok(provider.slug === 'fixture-provider', 'provider form contract unchanged');

  const source = parseSourceForm(form({ provider_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', name: 'Fixture Source', slug: 'fixture-source', identifier_mode: 'tmdb_id', status: 'experimental', visibility: 'public', ordering: '2' }));
  ok(source.identifier_mode === 'tmdb_id', 'source form contract unchanged');
  throwsStreamingValidation(() => parseProviderForm(form({ name: 'Bad', slug: 'BAD_SLUG', status: 'experimental', integration_type: 'template' })), 'provider slug contract unchanged');

  const dbTypes = readFileSync(new URL('../src/lib/server/supabase/database.types.ts', import.meta.url), 'utf8');
  for (const table of ['streaming_providers', 'streaming_sources', 'streaming_categories', 'streaming_default_sources', 'streaming_config_meta']) {
    ok(dbTypes.includes(`      ${table}: {`), `database.types.ts still declares ${table}`);
  }
  ok(!dbTypes.includes('torrent'), 'database.types.ts introduces no torrent fields');
}

// ---------------------------------------------------------------------------
// 9. Addon fields map correctly between DB and domain representations
// ---------------------------------------------------------------------------
{
  const row: StreamingAddonRow = {
    id: '00000000-0000-4000-8000-00000000a001',
    name: 'Mapping Addon',
    slug: 'mapping-addon',
    description: 'DB to domain mapping fixture',
    manifest_url: 'https://mapping.example/manifest.json',
    enabled: true,
    status: 'maintenance',
    ordering: 7,
    logo: 'https://mapping.example/logo.png',
    version: '1.2.3',
    id_property: 'tt',
    supported_types: ['movie', 'series'],
    id_prefixes: ['tt'],
    resources: ['stream'],
    last_checked_at: '2026-01-01T00:00:00.000Z',
    last_success_at: '2026-01-02T00:00:00.000Z',
    last_error: 'upstream timeout',
    capabilities: { streams: true },
    notes: 'mapping fixture',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z'
  };
  const addon: StreamingAddon = mapAddonRow(row);
  ok(addon.manifestUrl === row.manifest_url, 'manifest_url maps to manifestUrl');
  ok(addon.idProperty === 'tt', 'id_property maps to idProperty');
  ok(addon.supportedTypes[0] === 'movie' && addon.idPrefixes[0] === 'tt' && addon.resources[0] === 'stream', 'manifest arrays map to camelCase fields');
  ok(addon.lastCheckedAt === row.last_checked_at && addon.lastSuccessAt === row.last_success_at && addon.lastError === 'upstream timeout', 'health fields map to camelCase');
  ok(addon.status === 'maintenance', 'status maps to the closed union');
  ok(addon.capabilities.streams === true, 'capabilities map as an object');
  ok(addon.createdAt === row.created_at && addon.updatedAt === row.updated_at, 'timestamps map to camelCase');
  ok(addon.description === 'DB to domain mapping fixture' && addon.logo !== undefined && addon.version === '1.2.3', 'optional metadata maps with undefined-for-null');

  const insert = mapAddonToInsert(addon);
  ok(insert.manifest_url === addon.manifestUrl, 'domain manifestUrl maps back to manifest_url');
  ok(insert.id_property === addon.idProperty, 'domain idProperty maps back to id_property');
  assert.deepEqual(insert.supported_types, ['movie', 'series']);
  passed += 1;
  ok(insert.last_checked_at === addon.lastCheckedAt && insert.last_error === addon.lastError, 'health fields map back to snake_case');
  ok(insert.description === addon.description && insert.notes === addon.notes, 'optional strings map back as null-safe values');

  // Defensive coercions for malformed DB payloads (RLS/admin data only).
  const degraded = mapAddonRow({ ...row, status: 'unknown-status' as StreamingAddonRow['status'], capabilities: 'broken' as unknown as StreamingAddonRow['capabilities'], supported_types: null as unknown as string[] });
  ok(degraded.status === 'experimental', 'malformed status coerces to the secure default');
  ok(Object.keys(degraded.capabilities).length === 0, 'malformed capabilities coerce to an empty object');
  ok(degraded.supportedTypes.length === 0, 'malformed arrays coerce to empty arrays');

  // Optional DB columns map to absent domain fields (undefined, not null).
  const sparse = mapAddonRow({ ...row, description: null, logo: null, version: null, id_property: null, notes: null, last_checked_at: null, last_success_at: null, last_error: null });
  ok(sparse.description === undefined && sparse.logo === undefined && sparse.version === undefined, 'null optional columns map to undefined domain fields');
  ok(sparse.idProperty === undefined && sparse.notes === undefined, 'null metadata columns map to undefined domain fields');
  ok(sparse.lastCheckedAt === undefined && sparse.lastSuccessAt === undefined && sparse.lastError === undefined, 'null health columns map to undefined domain fields');
}

console.log(`Stremio addon Phase 1 foundation tests passed: ${passed} checks (model contract, validation, no torrent/P2P, migration security posture, existing registry untouched, DB<->domain mapping).`);
