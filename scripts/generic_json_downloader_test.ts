import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDownloadUrl } from '$lib/shared/downloader';
import { parseDownloadProviderForm, DownloaderValidationError } from '$lib/server/downloader/validation';
import { builtinMaveroDownloaderProvider } from '$lib/server/downloader/public-config';
import { PUBLIC_PROVIDER_FIELDS } from '$lib/server/downloader/types';
import {
  normalizeJsonDownloadPayload,
  isUsableDownloadUrl,
  JSON_NORMALIZE_MAX_LINKS,
} from '$lib/server/downloader/json-normalize';
import {
  resolveJsonDownloadLinks,
  loadJsonDownloadProvider,
  JSON_DOWNLOADER_TITLE_MAX_CHARS,
  type JsonDownloaderProvider,
} from '$lib/server/downloader/json-service';
import { RATE_LIMIT_RULES } from '$lib/server/http/rate-limit';

// MAVERO — Generic downloader "type" (embed | json) regression suite.
//
// Covers the full task contract for DB-backed JSON API downloaders:
//   §1  type enum validation (admin form parser)
//   §2  DB migration + database.types.ts type column
//   §3  public config includes type (projection + select + shared type)
//   §4  admin form persists type through the existing action path
//   §5  JSON URL construction (shared template builder + exact fetch URL;
//       every allowed placeholder incl. {titleSlug} + {season2}/{episode2})
//   §6  JSON normalizer (containers, URL fields, metadata, dedupe, bounds)
//   §7  JSON endpoint/service security (provider load, type/capability,
//       rate limit wiring, adult guard wiring, timeout, oversized response,
//       redirect safety, SSRF protection)
//   §8  DownloadSheet dispatch (json never iframes; embed unchanged;
//       Mavero/4K special cases intact)
//   §9  Pantyflix-shaped fixture normalization (regression fixture — the
//       generic normalizer handles the real response shape; NO adapter)
//
// Pure/deterministic: no network, no Supabase. Fetch + DNS are injected.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// Shared fixtures
// ============================================================

// The real Pantyflix templates — used as REGRESSION FIXTURES ONLY (the task
// explicitly provides them for this purpose). No Pantyflix-specific adapter
// exists anywhere in src/; these strings only drive the GENERIC builder +
// normalizer through the real-world shapes.
const PANTYFLIX_MOVIE_TEMPLATE = 'https://pantyflix.org/api/streamrip/download?type=movie&id={tmdbId}';
const PANTYFLIX_TV_TEMPLATE = 'https://pantyflix.org/api/streamrip/download?type=tv&id={tmdbId}&season={season}&episode={episode}';

const VALID_BTIH = 'deadbeef0123456789abcdef0123456789abcdef'; // 40 hex
const VALID_MAGNET = `magnet:?xt=urn:btih:${VALID_BTIH}&dn=Test`;

function jsonProvider(overrides: Partial<JsonDownloaderProvider> = {}): JsonDownloaderProvider {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'JSON Downloader',
    slug: 'json-dl',
    type: 'json',
    supportsMovie: true,
    supportsTv: true,
    movieUrlTemplate: PANTYFLIX_MOVIE_TEMPLATE,
    tvUrlTemplate: PANTYFLIX_TV_TEMPLATE,
    ...overrides,
  };
}

/** A fake DNS resolver that answers every hostname with one public address. */
const publicDns = async (hostname: string): Promise<Array<{ address: string; family: number }>> => [
  { address: '93.184.216.34', family: 4 },
];

/** Records every fetch call and delegates to a handler by URL. */
function fetchRecorder(
  handler: (url: string, init: RequestInit | undefined, index: number) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init, calls.length - 1);
  }) as typeof fetch;
  return { fetcher, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function baseDeps(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  return { fetcher, dnsResolver: publicDns, timeoutMs: 5_000, ...overrides };
}

// A valid admin form payload (all required fields).
function validForm(entries: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('name', 'JSON Downloader');
  form.set('slug', 'json-dl');
  form.set('ordering', '10');
  form.set('supports_movie', 'on');
  form.set('supports_tv', 'on');
  form.set('movie_url_template', PANTYFLIX_MOVIE_TEMPLATE);
  form.set('tv_url_template', PANTYFLIX_TV_TEMPLATE);
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
}

// ============================================================
// §1 — type enum validation (admin form parser)
// ============================================================
console.log('\n1. Type enum validation');

{
  assert.equal(parseDownloadProviderForm(validForm({ type: 'embed' })).type, 'embed', 'type embed accepted');
  assert.equal(parseDownloadProviderForm(validForm({ type: 'json' })).type, 'json', 'type json accepted');
  ok(true, '1a. form type embed/json accepted');
}
{
  // Missing/absent type defaults to 'embed' (backward-compatible with any
  // pre-type form post — every existing row remains embed).
  const form = validForm();
  form.delete('type');
  assert.equal(parseDownloadProviderForm(form).type, 'embed', 'missing type defaults to embed');
  assert.equal(parseDownloadProviderForm(validForm({ type: '' })).type, 'embed', 'empty type defaults to embed');
  ok(true, '1b. missing/empty type defaults to embed (existing rows remain embed)');
}
{
  const rejected = ['iframe', 'JSON', 'Embed', 'html', 'api', '0', 'true'];
  for (const value of rejected) {
    assert.throws(
      () => parseDownloadProviderForm(validForm({ type: value })),
      (error: unknown) => error instanceof DownloaderValidationError,
      `type "${value}" rejected`,
    );
  }
  ok(true, '1c. anything other than embed/json is rejected (iframe/JSON/Embed/html/api/0/true)');
}
{
  // The DB CHECK emulation: constraint is exactly type in ('embed','json').
  const migration = read('supabase/migrations/20261007000000_download_provider_type.sql');
  assert.match(migration, /check \(type in \('embed', 'json'\)\)/, 'DB CHECK is the exact two-value enum');
  ok(true, '1d. DB CHECK constraint matches the two-value enum exactly');
}

// ============================================================
// §2 — DB migration + database.types.ts type column
// ============================================================
console.log('\n2. DB migration + type column');

{
  const migration = read('supabase/migrations/20261007000000_download_provider_type.sql');
  assert.match(migration, /add column if not exists type text not null default 'embed'/, 'column added with not null default embed');
  assert.match(migration, /alter table public\.download_providers\s+add constraint download_providers_type_check/, 'named CHECK constraint added');
  assert.match(migration, /update public\.download_providers\s+set type = 'json'\s+where slug = '4k-downloader'/, '4K Downloader row backfilled to json');
  // Exactly ONE update statement in the migration — the 4K backfill. No
  // other row is touched (every other row keeps the 'embed' default).
  const updateCount = (migration.match(/update public\.download_providers\b/g) ?? []).length;
  assert.equal(updateCount, 1, 'exactly one UPDATE (the 4K backfill) — no other row touched');
  assert.match(migration, /create or replace view public\.download_providers_public/, 'public view recreated');
  assert.match(migration, /movie_url_template,\s+tv_url_template,\s+type\s+from public\.download_providers/, 'view exposes type after tv_url_template');
  assert.match(migration, /where enabled = true/, 'view still filters enabled-only');
  assert.match(migration, /security_invoker = true/, 'view stays security_invoker');
  assert.match(migration, /grant select on public\.download_providers_public to anon, authenticated/, 'view grant re-issued');
  assert.match(migration, /grant select \(type\) on public\.download_providers to anon/, 'anon column grant includes type');
  // Forward-only hygiene: no streaming table touched, existing rows not reverted.
  assert.doesNotMatch(migration, /streaming_/, 'migration touches no streaming_* table');
  ok(true, '2a. migration: type column + CHECK + 4K backfill + view + grants, no streaming table');
}
{
  const dbTypes = read('src/lib/server/supabase/database.types.ts');
  // download_providers Row/Insert/Update each carry type.
  const tableSection = dbTypes.split('download_providers: {')[1]?.split('download_providers_config_meta')[0] ?? '';
  assert.match(tableSection, /type: string/, 'table Row includes type');
  const insertSection = tableSection.split('Insert: {')[1] ?? '';
  assert.match(insertSection, /type\?: string/, 'table Insert includes optional type');
  const updateSection = tableSection.split('Update: {')[1] ?? '';
  assert.match(updateSection, /type\?: string/, 'table Update includes optional type');
  // The public view Row carries type too.
  const viewSection = dbTypes.split('download_providers_public: {')[1]?.split(' Functions')[0] ?? '';
  assert.match(viewSection, /type: string/, 'view Row includes type');
  ok(true, '2b. database.types.ts: type present in table Row/Insert/Update + public view Row');
}

// ============================================================
// §3 — public config includes type
// ============================================================
console.log('\n3. Public config includes type');

{
  const shared = read('src/lib/shared/downloader.ts');
  assert.match(shared, /export type DownloadProviderType = 'embed' \| 'json';/, 'DownloadProviderType exported');
  assert.match(shared, /type: DownloadProviderType;/, 'PublicDownloadProvider carries required type');
  ok(true, '3a. PublicDownloadProvider.type: required embed|json (shared contract)');
}
{
  const publicConfig = read('src/lib/server/downloader/public-config.ts');
  assert.match(publicConfig, /movie_url_template,tv_url_template,type'/, 'public select projects the type column');
  assert.match(publicConfig, /type: row\.type === 'json' \? 'json' : 'embed',/, 'toPublic maps the type defensively');
  ok(true, '3b. public-config: select + toPublic map the type column');
}
{
  assert.ok(PUBLIC_PROVIDER_FIELDS.includes('type' as never), 'PUBLIC_PROVIDER_FIELDS includes type');
  ok(true, '3c. PUBLIC_PROVIDER_FIELDS includes type (admin preview projection)');
}
{
  assert.equal(builtinMaveroDownloaderProvider('https://x.example').type, 'embed', 'builtin shim stays embed');
  ok(true, '3d. builtin Mavero shim keeps type embed');
}

// ============================================================
// §4 — admin form persists type (existing form/action/service path)
// ============================================================
console.log('\n4. Admin form persists type');

{
  const page = read('src/routes/admin/downloaders/+page.svelte');
  assert.match(page, /<select name="type"/, 'TYPE select present in the form');
  assert.match(page, /<option value="embed">Embed<\/option>/, 'Embed option present');
  assert.match(page, /<option value="json">JSON<\/option>/, 'JSON option present');
  assert.match(page, /value=\{editingProvider\?\.type \?\? 'embed'\}/, 'edit preselects the stored type, create defaults embed');
  ok(true, '4a. admin form has the TYPE select (Embed/JSON) with edit preselect');
}
{
  const server = read('src/routes/admin/downloaders/+page.server.ts');
  // The existing path persists whatever parseDownloadProviderForm returns —
  // type now flows through it unchanged (create insert + update spread).
  assert.match(server, /createDownloadProvider\(locals\.supabase, parseDownloadProviderForm\(await request\.formData\(\)\)\)/, 'create path parses the form (type included)');
  assert.match(server, /const \{ id: _ignored, \.\.\.input \} = \{ id, \.\.\.parseDownloadProviderForm\(form\) \};/, 'update path spreads the parsed form (type included)');
  ok(true, '4b. type persists through the existing create/update action path');
}
{
  // The parsed form object is insert/update-shaped: snake_case columns match
  // the registry, with the exact embed|json value.
  const parsed = parseDownloadProviderForm(validForm({ type: 'json' }));
  assert.equal(parsed.type, 'json');
  assert.ok('movie_url_template' in parsed && 'tv_url_template' in parsed, 'template fields still parsed');
  ok(true, '4c. parsed form object carries type=json alongside the existing fields');
}
{
  // URL-template validation is NOT removed (regression guard for the task
  // requirement "do not remove existing URL-template validation").
  assert.throws(
    () => parseDownloadProviderForm(validForm({ movie_url_template: 'http://insecure.example/movie/{tmdbId}' })),
    (error: unknown) => error instanceof DownloaderValidationError,
    'http template still rejected',
  );
  assert.throws(
    () => parseDownloadProviderForm(validForm({ movie_url_template: 'https://example.com/movie/{evilPlaceholder}' })),
    (error: unknown) => error instanceof DownloaderValidationError,
    'unknown placeholder still rejected',
  );
  ok(true, '4d. existing URL-template validation intact (HTTPS-only + placeholder allowlist)');
}

// ============================================================
// §5 — JSON URL construction (shared template builder)
// ============================================================
console.log('\n5. JSON URL construction');

{
  const provider = jsonProvider();
  const movieUrl = buildDownloadUrl(provider, { mediaType: 'movie', tmdbId: '6263850' });
  assert.equal(movieUrl, 'https://pantyflix.org/api/streamrip/download?type=movie&id=6263850', 'movie URL exact');
  const tvUrl = buildDownloadUrl(provider, { mediaType: 'tv', tmdbId: '94605', season: 1, episode: 2 });
  assert.equal(tvUrl, 'https://pantyflix.org/api/streamrip/download?type=tv&id=94605&season=1&episode=2', 'tv URL exact');
  ok(true, '5a. the real Pantyflix templates resolve to the exact expected URLs (movie + tv)');
}
{
  // The service fetches the EXACT built URL server-side.
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ ok: true, downloads: [{ url: 'https://cdn.example/file.mkv' }] }));
  const outcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(fetcher));
  assert.equal(outcome.status, 'ok', 'resolution ok');
  assert.equal(calls.length, 1, 'exactly one fetch');
  assert.equal(calls[0], 'https://pantyflix.org/api/streamrip/download?type=movie&id=6263850', 'fetched the exact built URL');
  ok(true, '5b. the server fetches the exact template-built URL (no client URL is ever accepted)');
}
{
  // TV without season/episode cannot build a URL → typed failure, NO fetch.
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ ok: true, downloads: [] }));
  const missingSeason = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'tv', tmdbId: '94605' }, baseDeps(fetcher));
  assert.equal(missingSeason.status, 'failed', 'typed failure');
  assert.equal(missingSeason.status === 'failed' && missingSeason.reason, 'url-not-buildable', 'reason url-not-buildable');
  assert.equal(calls.length, 0, 'no upstream fetch happened');
  ok(true, '5c. unbuildable URL (missing season) → typed failure with zero fetches');
}
{
  // 5d. {titleSlug} JSON templates — the audited gap: the title must flow
  // client → endpoint → service → the SHARED builder, which slugifies it
  // SERVER-SIDE. A JSON provider using
  // https://example.test/download/{titleSlug} must fetch the slugified URL.
  const TITLESLUG_MOVIE = 'https://example.test/download/{titleSlug}';
  const provider = jsonProvider({ movieUrlTemplate: TITLESLUG_MOVIE });

  // Shared builder, direct: the deterministic slug algorithm (same one the
  // embed/Cineverse flow uses — single source of truth, no second slugifier).
  assert.equal(
    buildDownloadUrl(provider, { mediaType: 'movie', tmdbId: '6263850', title: 'Deadpool & Wolverine' }),
    'https://example.test/download/deadpool-wolverine',
    'builder slugifies "Deadpool & Wolverine"',
  );
  assert.equal(
    buildDownloadUrl(provider, { mediaType: 'movie', tmdbId: '6263850', title: 'Dune: Part Two' }),
    'https://example.test/download/dune-part-two',
    'builder slugifies "Dune: Part Two" (punctuation stripped)',
  );
  assert.equal(
    buildDownloadUrl(provider, { mediaType: 'movie', tmdbId: '6263850', title: 'Amélie' }),
    'https://example.test/download/amelie',
    'builder slugifies "Amélie" (NFKD diacritics folded)',
  );

  // Service, end-to-end: the request's title reaches buildDownloadUrl and
  // the fetcher is called with the EXACT slugified URL.
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ ok: true, downloads: [{ url: 'https://cdn.example/dw.mkv', quality: 1080 }] }));
  const outcome = await resolveJsonDownloadLinks(
    provider,
    { mediaType: 'movie', tmdbId: '6263850', title: 'Deadpool & Wolverine' },
    baseDeps(fetcher),
  );
  assert.equal(outcome.status, 'ok', 'resolution ok');
  assert.equal(calls.length, 1, 'exactly one fetch');
  assert.equal(calls[0], 'https://example.test/download/deadpool-wolverine', 'fetched the slugified URL (server-side slug)');
  assert.equal(outcome.status === 'ok' && outcome.links.length, 1, 'links resolved through the titleSlug URL');
  ok(true, '5d. {titleSlug} movie template: title flows through the service and the fetched URL is correctly slugified');
}
{
  // 5e. {titleSlug} + {season2}/{episode2} TV template — completes the
  // placeholder audit: ALL SIX allowed placeholders resolve through the
  // JSON path ({tmdbId}/{season}/{episode} via 5a/9b, {titleSlug} via 5d,
  // {season2}/{episode2} here — the zero-padded forms are derived from the
  // same season/episode request fields by the shared builder).
  const TITLESLUG_TV = 'https://example.test/tv/{titleSlug}/s{season2}e{episode2}';
  const provider = jsonProvider({
    movieUrlTemplate: 'https://example.test/download/{titleSlug}',
    tvUrlTemplate: TITLESLUG_TV,
  });
  assert.equal(
    buildDownloadUrl(provider, { mediaType: 'tv', tmdbId: '94605', title: 'Breaking Bad', season: 2, episode: 5 }),
    'https://example.test/tv/breaking-bad/s02e05',
    'tv URL: slug + zero-padded s02e05',
  );
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ ok: true, downloads: [{ url: 'https://cdn.example/bb-s02e05.mkv' }] }));
  const outcome = await resolveJsonDownloadLinks(
    provider,
    { mediaType: 'tv', tmdbId: '94605', title: 'Breaking Bad', season: 2, episode: 5 },
    baseDeps(fetcher),
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(calls[0], 'https://example.test/tv/breaking-bad/s02e05', 'fetched the exact tv URL (slug + season2/episode2)');
  ok(true, '5e. {titleSlug}+{season2}/{episode2} tv template: every allowed placeholder resolves through the JSON path');
}
{
  // 5f. {titleSlug} template with NO usable title → url-not-buildable, zero
  // fetches (graceful failure — never a partial/unslugified URL, never a
  // client-side slug, never an iframe fallback).
  const provider = jsonProvider({ movieUrlTemplate: 'https://example.test/download/{titleSlug}' });
  for (const request of [
    { mediaType: 'movie' as const, tmdbId: '6263850' }, // title absent
    { mediaType: 'movie' as const, tmdbId: '6263850', title: '' }, // empty
    { mediaType: 'movie' as const, tmdbId: '6263850', title: '   ' }, // whitespace-only
    { mediaType: 'movie' as const, tmdbId: '6263850', title: '?!:' }, // slug-strips to empty
  ]) {
    const { fetcher, calls } = fetchRecorder(() => jsonResponse({ downloads: [] }));
    const outcome = await resolveJsonDownloadLinks(provider, request, baseDeps(fetcher));
    assert.equal(outcome.status, 'failed', `typed failure for title=${JSON.stringify(request.title)}`);
    assert.equal(outcome.status === 'failed' && outcome.reason, 'url-not-buildable', 'reason url-not-buildable');
    assert.equal(calls.length, 0, 'no upstream fetch happened');
  }
  // A title on an id-based (no {titleSlug}) template stays inert — the
  // Pantyflix fixtures in §9 already prove the no-title path; here the
  // title is simply ignored, never appended or echoed.
  const inert = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const inertOutcome = await resolveJsonDownloadLinks(
    jsonProvider(),
    { mediaType: 'movie', tmdbId: '6263850', title: 'Deadpool & Wolverine' },
    baseDeps(inert.fetcher),
  );
  assert.equal(inertOutcome.status, 'ok');
  assert.equal(inert.calls[0], 'https://pantyflix.org/api/streamrip/download?type=movie&id=6263850', 'title ignored by id-based template');
  ok(true, '5f. missing/unusable title → url-not-buildable with zero fetches; title inert on id-based templates');
}

// ============================================================
// §6 — JSON normalizer
// ============================================================
console.log('\n6. JSON normalizer');

{
  // 6a. downloads[] — the Pantyflix-shaped response.
  const result = normalizeJsonDownloadPayload({
    ok: true,
    downloads: [
      { server: 'StreamHG', url: 'https://hg.example/file.mkv', quality: 1080, size: '3.4GB', source: 'WEB-DL' },
    ],
  });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]?.url, 'https://hg.example/file.mkv', 'url exact');
  assert.equal(result.links[0]?.server, 'StreamHG', 'server mapped');
  assert.equal(result.links[0]?.source, 'WEB-DL', 'source mapped');
  assert.equal(result.links[0]?.quality, '1080p', 'numeric quality 1080 → "1080p"');
  assert.equal(result.links[0]?.size, '3.4GB', 'size kept verbatim');
  assert.equal(result.upstreamError, false);
  ok(true, '6a. downloads[] container: url/server/source/quality/size all mapped');
}
{
  // 6b. every other supported container key.
  for (const key of ['links', 'results', 'streams', 'files', 'sources']) {
    const result = normalizeJsonDownloadPayload({ [key]: [{ url: `https://cdn.example/${key}.mkv` }] });
    assert.equal(result.links.length, 1, `${key} container yields the link`);
    assert.equal(result.links[0]?.url, `https://cdn.example/${key}.mkv`);
  }
  ok(true, '6b. links[] / results[] / streams[] / files[] / sources[] containers all recognized');
}
{
  // 6c. nested data[] — { data: { downloads: [...] } } (data is an object
  // wrapper, not a top-level array — the bounded fallback walk finds it).
  const result = normalizeJsonDownloadPayload({
    ok: true,
    data: { downloads: [{ url: 'https://cdn.example/nested.mkv', quality: '2160p' }] },
  });
  assert.equal(result.links.length, 1, 'nested link found');
  assert.equal(result.links[0]?.url, 'https://cdn.example/nested.mkv');
  assert.equal(result.links[0]?.quality, '2160p', 'string quality kept verbatim');
  ok(true, '6c. nested data.downloads[] found by the bounded fallback walk');
}
{
  // 6d. every supported URL field name.
  const fields = ['url', 'link', 'href', 'download_url', 'downloadUrl'];
  const entries = fields.map((field, index) => ({ [field]: `https://cdn.example/${index}.mkv` }));
  const result = normalizeJsonDownloadPayload({ downloads: entries });
  assert.equal(result.links.length, fields.length, 'every field name accepted');
  for (let index = 0; index < fields.length; index += 1) {
    assert.ok(result.links.some((link) => link.url === `https://cdn.example/${index}.mkv`), `field ${fields[index]} produced its link`);
  }
  ok(true, '6d. url / link / href / download_url / downloadUrl fields all accepted');
}
{
  // 6e. metadata variants.
  const result = normalizeJsonDownloadPayload({
    downloads: [
      { link: 'https://a.example/1.mkv', name: 'Episode 1', resolution: 720, filesize: '700 MB', host: 'MirrorA' },
      { download_url: 'https://b.example/2.mkv', title: 'Episode 2', fileSize: 1_500_000_000, provider: 'MirrorB' },
    ],
  });
  const first = result.links[0];
  assert.equal(first?.title, 'Episode 1', 'name → title');
  assert.equal(first?.quality, '720p', 'resolution → quality');
  assert.equal(first?.size, '700 MB', 'filesize → size');
  assert.equal(first?.server, 'MirrorA', 'host → server');
  const second = result.links[1];
  assert.equal(second?.title, 'Episode 2', 'title → title');
  assert.equal(second?.source, 'MirrorB', 'provider → source');
  assert.equal(second?.size, '1.5 GB', 'numeric fileSize (bytes) formatted');
  ok(true, '6e. metadata variants: name/title, resolution, filesize/fileSize (bytes), host→server, provider→source');
}
{
  // 6f. quality=0 must NEVER display "0p"; missing metadata gracefully omitted.
  const result = normalizeJsonDownloadPayload({
    downloads: [
      { url: 'https://a.example/zero.mkv', quality: 0 },
      { url: 'https://a.example/zerostr.mkv', quality: '0' },
      { url: 'https://a.example/bare.mkv' },
    ],
  });
  assert.equal(result.links[0]?.quality, undefined, 'quality 0 → omitted');
  assert.equal(result.links[1]?.quality, undefined, 'quality "0" → omitted');
  const bare = result.links[2];
  assert.deepEqual(
    Object.keys(bare ?? {}).sort(),
    ['url'],
    'bare entry exposes ONLY the url — all optional metadata omitted',
  );
  ok(true, '6f. quality 0 never renders "0p"; missing metadata gracefully omitted');
}
{
  // 6g. dedupe: EXACT identical URLs only — different hosts stay.
  const result = normalizeJsonDownloadPayload({
    downloads: [
      { url: 'https://same.example/file.mkv', server: 'A', quality: 1080 },
      { url: 'https://same.example/file.mkv', server: 'B' }, // exact duplicate → deduped
      { url: 'https://other.example/file.mkv', server: 'A', quality: 1080, size: '3.4GB' }, // same metadata, different host → KEPT
    ],
  });
  assert.equal(result.links.length, 2, 'one exact duplicate removed, different host kept');
  assert.ok(result.links.some((l) => l.url === 'https://other.example/file.mkv'), 'different host preserved');
  ok(true, '6g. dedupe is exact-URL only; different hosts never merged');
}
{
  // 6h. empty results — valid JSON, no recognizable links → CLEAN empty.
  for (const body of [
    { ok: true },
    { ok: true, downloads: [] },
    { data: { nothing: true } },
    { message: 'hello' },
    {},
    [],
    'just a string',
    42,
    null,
    true,
  ]) {
    const result = normalizeJsonDownloadPayload(body);
    assert.equal(result.links.length, 0, `empty for ${JSON.stringify(body)}`);
    assert.equal(result.upstreamError, false, `no upstream error for ${JSON.stringify(body)}`);
  }
  ok(true, '6h. valid-but-linkless documents → clean empty result (never an exception)');
}
{
  // 6i. explicit ok=false / error → upstreamError, links never scanned.
  for (const body of [
    { ok: false },
    { ok: false, downloads: [{ url: 'https://x.example/leak.mkv' }] },
    { error: 'Not found' },
    { error: { message: 'upstream broke' } },
  ]) {
    const result = normalizeJsonDownloadPayload(body);
    assert.equal(result.upstreamError, true, `upstreamError for ${JSON.stringify(body)}`);
    assert.equal(result.links.length, 0, 'no links leaked from an error document');
  }
  ok(true, '6i. explicit ok=false / error documents → upstreamError with no links');
}
{
  // 6j. unsafe URL values are rejected (javascript:, data:, ftp:, relative).
  const result = normalizeJsonDownloadPayload({
    downloads: [
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,hi' },
      { url: 'ftp://files.example/file.mkv' },
      { url: '/relative/path/file.mkv' },
      { url: 'https://good.example/ok.mkv' },
    ],
  });
  assert.equal(result.links.length, 1, 'only the http(s) link survives');
  assert.equal(result.links[0]?.url, 'https://good.example/ok.mkv');
  assert.ok(result.malformed >= 4, 'rejected entries counted malformed');
  ok(true, '6j. javascript:/data:/ftp:/relative URLs rejected; http(s) accepted');
}
{
  // 6k. magnet policy — the EXISTING downloader policy permits valid btih
  // magnets; malformed magnets are rejected.
  const result = normalizeJsonDownloadPayload({
    downloads: [
      { url: VALID_MAGNET, name: 'torrent' },
      { url: 'magnet:?xt=urn:btih:deadbeef', name: 'garbage hash' },
      { url: 'magnet:?dn=only-name', name: 'no xt' },
    ],
  });
  assert.equal(result.links.length, 1, 'only the legitimate magnet survives');
  assert.equal(result.links[0]?.url, VALID_MAGNET, 'magnet preserved EXACTLY');
  ok(true, '6k. valid btih magnet accepted + preserved verbatim; malformed magnets rejected');
}
{
  // 6l. bounds — deep nesting and wide arrays are bounded (no unbounded work).
  // 100-level deep nesting: bounded by depth 6; returns quickly + empty.
  let deep: unknown = { url: 'https://deep.example/x.mkv' };
  for (let index = 0; index < 100; index += 1) deep = { nested: deep };
  const deepResult = normalizeJsonDownloadPayload({ ...deep as object, downloads: [{ url: 'https://a.example/1.mkv' }] });
  assert.equal(deepResult.links.length, 1, 'root container still found despite deep junk elsewhere');
  // Wide array: capped at MAX_LINKS.
  const wide = Array.from({ length: 500 }, (_, index) => ({ url: `https://wide.example/${index}.mkv` }));
  const wideResult = normalizeJsonDownloadPayload({ downloads: wide });
  assert.equal(wideResult.links.length, JSON_NORMALIZE_MAX_LINKS, `links capped at ${JSON_NORMALIZE_MAX_LINKS}`);
  ok(true, '6l. strict depth/entry limits: deep junk bounded, wide arrays capped');
}
{
  // 6m. isUsableDownloadUrl unit checks.
  assert.equal(isUsableDownloadUrl('https://a.example/x.mkv'), true, 'https ok');
  assert.equal(isUsableDownloadUrl('http://a.example/x.mkv'), true, 'http ok');
  assert.equal(isUsableDownloadUrl(VALID_MAGNET), true, 'valid magnet ok');
  assert.equal(isUsableDownloadUrl('javascript:alert(1)'), false, 'javascript rejected');
  assert.equal(isUsableDownloadUrl('data:text/html,x'), false, 'data rejected');
  assert.equal(isUsableDownloadUrl(''), false, 'empty rejected');
  assert.equal(isUsableDownloadUrl('https://exa mple.com/x'), false, 'whitespace URL rejected');
  assert.equal(isUsableDownloadUrl(`https://${'a'.repeat(2100)}.example/`), false, 'oversized URL rejected');
  ok(true, '6m. isUsableDownloadUrl: http/https/valid-magnet only, with length + whitespace bounds');
}

// ============================================================
// §7 — JSON endpoint / service security
// ============================================================
console.log('\n7. JSON endpoint / service security');

{
  // 7a. provider must be loaded from the registry (enabled, public view).
  const captured: Array<{ table: string; columns: string; filters: Array<[string, string | boolean]> }> = [];
  const fakeClient = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string | boolean) => ({
          eq: (column2: string, value2: string | boolean) => {
            captured.push({ table, columns, filters: [[column, value], [column2, value2]] });
            return { maybeSingle: async () => ({ data: null, error: null }) };
          },
        }),
      }),
    }),
  };
  const missing = await loadJsonDownloadProvider(fakeClient as never, '11111111-1111-4111-8111-111111111111');
  assert.equal(missing, null, 'missing/disabled provider → null');
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.table, 'download_providers_public', 'reads the enabled-only public view');
  assert.ok(captured[0]?.columns.includes('type'), 'select projects type');
  assert.ok(captured[0]?.filters.some(([c, v]) => c === 'enabled' && v === true), 'enabled=true enforced');
  ok(true, '7a. provider load: enabled-only public view + type projection; missing → null');
}
{
  // 7b. fake registry row → mapped provider.
  const fakeClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'JSON Downloader',
                slug: 'json-dl',
                type: 'json',
                supports_movie: true,
                supports_tv: false,
                movie_url_template: PANTYFLIX_MOVIE_TEMPLATE,
                tv_url_template: null,
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
  const provider = await loadJsonDownloadProvider(fakeClient as never, '11111111-1111-4111-8111-111111111111');
  assert.ok(provider, 'row mapped');
  assert.equal(provider?.type, 'json', 'type mapped');
  assert.equal(provider?.supportsTv, false, 'capability mapped');
  ok(true, '7b. registry row mapped to the service provider shape');
}
{
  // 7c. provider must be type=json — an embed provider is refused with NO fetch.
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const outcome = await resolveJsonDownloadLinks(
    jsonProvider({ type: 'embed' }),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(fetcher),
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.reason, 'not-json');
  assert.equal(calls.length, 0, 'embed provider never fetched');
  ok(true, '7c. type must be json: an embed provider is refused before any fetch');
}
{
  // 7d. media capability must match — a movie-only provider refuses tv.
  const { fetcher, calls } = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const outcome = await resolveJsonDownloadLinks(
    jsonProvider({ supportsTv: false }),
    { mediaType: 'tv', tmdbId: '94605', season: 1, episode: 2 },
    baseDeps(fetcher),
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' && outcome.reason, 'not-capable');
  assert.equal(calls.length, 0);
  ok(true, '7d. media capability enforced (movie-only provider refuses tv)');
}
{
  // 7e. rate limit: the downloaderJson bucket exists with the 20/min rule.
  assert.ok(RATE_LIMIT_RULES.downloaderJson, 'bucket exists');
  assert.equal(RATE_LIMIT_RULES.downloaderJson.limit, 20, '20/min limit');
  assert.equal(RATE_LIMIT_RULES.downloaderJson.windowMs, 60_000, '60s window');
  const endpoint = read('src/routes/api/downloader/json/+server.ts');
  assert.match(endpoint, /checkRateLimit\('downloaderJson', clientIdentity\(request\.headers, locals\.user\?\.id\)\)/, 'endpoint wires the bucket');
  const rateLimitIndex = endpoint.indexOf("checkRateLimit('downloaderJson'");
  const loadIndex = endpoint.indexOf('loadJsonDownloadProvider(locals.supabase');
  assert.ok(rateLimitIndex !== -1 && loadIndex !== -1 && rateLimitIndex < loadIndex, 'rate limit runs BEFORE the registry load');
  ok(true, '7e. downloaderJson rate limit (20/min) wired before any upstream work');
}
{
  // 7f. adult guard wired at the boundary, before resolution, outside the
  // resolution try (its 404 can never be swallowed by a 503 catch).
  const endpoint = read('src/routes/api/downloader/json/+server.ts');
  assert.match(endpoint, /await assertAdultDownloadAllowed\(locals\.supabase, locals\.user, cookies, guardType, downloaderContentId\(guardType, tmdbId\)\)/, 'guard called');
  const guardIndex = endpoint.indexOf('await assertAdultDownloadAllowed');
  const resolveIndex = endpoint.indexOf('await resolveJsonDownloadLinks');
  assert.ok(guardIndex !== -1 && resolveIndex !== -1 && guardIndex < resolveIndex, 'guard runs before resolution');
  // The guard call must sit OUTSIDE the resolution try block (non-swallowed
  // 404): the first `try {` AFTER the guard is the resolution try, so the
  // guard strictly precedes it.
  const tryIndex = endpoint.indexOf('try {', guardIndex);
  assert.ok(tryIndex !== -1 && guardIndex < tryIndex, 'guard runs before (outside) the resolution try');
  ok(true, '7f. adult guard runs before resolution and outside the 503 catch');
}
{
  // 7g. timeout — a hanging upstream is aborted and maps to unavailable.
  const { fetcher } = fetchRecorder((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const outcome = await resolveJsonDownloadLinks(
    jsonProvider(),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(fetcher, { timeoutMs: 60 }),
  );
  assert.equal(outcome.status, 'unavailable', 'timeout → unavailable');
  ok(true, '7g. upstream timeout → aborted + generic unavailable (no upstream details leaked)');
}
{
  // 7h. oversized response — rejected by Content-Length AND while streaming.
  const byHeader = fetchRecorder(() => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }));
  const headerOutcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(byHeader.fetcher, { maxBytes: 1_048_576 }));
  assert.equal(headerOutcome.status, 'unavailable', 'content-length overflow → unavailable');

  const byStream = fetchRecorder(() => new Response('x'.repeat(10_000), { headers: { 'content-type': 'application/json' } }));
  const streamOutcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(byStream.fetcher, { maxBytes: 512 }));
  assert.equal(streamOutcome.status, 'unavailable', 'streamed overflow → unavailable');
  ok(true, '7h. oversized responses rejected (header cap + streamed per-chunk abort)');
}
{
  // 7i. malformed JSON → unavailable (never an exception, never raw body exposure).
  const malformed = fetchRecorder(() => new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }));
  const htmlOutcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(malformed.fetcher));
  assert.equal(htmlOutcome.status, 'unavailable', 'HTML response → unavailable');

  const badJson = fetchRecorder(() => new Response('{not valid json', { headers: { 'content-type': 'application/json' } }));
  const jsonOutcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(badJson.fetcher));
  assert.equal(jsonOutcome.status, 'unavailable', 'invalid JSON → unavailable');
  ok(true, '7i. malformed upstream bodies → generic unavailable (HTML rejected, JSON.parse failures caught)');
}
{
  // 7j. redirect safety — every hop re-validated; a redirect to a private /
  // metadata destination is refused WITHOUT following it.
  const redirector = fetchRecorder((url) => {
    if (url.includes('download?type=movie')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    return jsonResponse({ downloads: [] });
  });
  const blocked = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(redirector.fetcher));
  assert.equal(blocked.status, 'unavailable', 'metadata redirect refused');
  assert.equal(redirector.calls.length, 1, 'the redirect was NEVER followed (single fetch)');

  // A SAFE same-origin redirect IS followed (bounded), each hop re-validated.
  const safeRedirector = fetchRecorder((url) => {
    if (url.includes('download?type=movie')) {
      return new Response(null, { status: 302, headers: { location: 'https://pantyflix.org/api/streamrip/v2?type=movie&id=6263850' } });
    }
    return jsonResponse({ downloads: [{ url: 'https://cdn.example/file.mkv', quality: 720 }] });
  });
  const followed = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(safeRedirector.fetcher));
  assert.equal(followed.status, 'ok', 'safe redirect followed');
  assert.equal(safeRedirector.calls.length, 2, 'two hops, both validated');
  assert.equal(followed.status === 'ok' && followed.links.length, 1, 'links resolved through the redirect');
  ok(true, '7j. redirects: metadata target refused unfollowed; safe target followed with re-validation');
}
{
  // 7k. redirect bound — too many hops is refused.
  const looping = fetchRecorder((url, _init, index) => {
    if (index < 5) return new Response(null, { status: 302, headers: { location: `https://pantyflix.org/hop/${index + 1}` } });
    return jsonResponse({ downloads: [] });
  });
  const outcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(looping.fetcher, { maxRedirects: 3 }));
  assert.equal(outcome.status, 'unavailable', 'loop refused');
  assert.equal(looping.calls.length, 4, 'initial + 3 redirects max');
  ok(true, '7k. bounded redirect count (initial + maxRedirects hops, then refused)');
}
{
  // 7l. SSRF — private IP literal template: blocked BEFORE any fetch.
  const privateIp = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const ipOutcome = await resolveJsonDownloadLinks(
    jsonProvider({ movieUrlTemplate: 'https://192.168.1.5/api?type=movie&id={tmdbId}' }),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(privateIp.fetcher),
  );
  assert.equal(ipOutcome.status, 'unavailable', 'private IP literal blocked');
  assert.equal(privateIp.calls.length, 0, 'blocked before connecting');
  ok(true, '7l. SSRF: private IP-literal destination blocked with zero fetches');
}
{
  // 7m. SSRF — DNS name resolving to a private address: blocked pre-fetch.
  const privateDns = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const dnsOutcome = await resolveJsonDownloadLinks(
    jsonProvider({ movieUrlTemplate: 'https://internal-api.example.com/api?type=movie&id={tmdbId}' }),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(privateDns.fetcher, {
      dnsResolver: async () => [{ address: '10.0.0.5', family: 4 }],
    }),
  );
  assert.equal(dnsOutcome.status, 'unavailable', 'private DNS answer blocked');
  assert.equal(privateDns.calls.length, 0, 'blocked before connecting');
  ok(true, '7m. SSRF: DNS resolving into private space blocked with zero fetches');
}
{
  // 7n. SSRF — credentials in the configured URL are rejected.
  const cred = fetchRecorder(() => jsonResponse({ downloads: [] }));
  const credOutcome = await resolveJsonDownloadLinks(
    jsonProvider({ movieUrlTemplate: 'https://user:secret@pantyflix.org/api?type=movie&id={tmdbId}' }),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(cred.fetcher),
  );
  assert.equal(credOutcome.status, 'unavailable', 'credentialed URL refused');
  assert.equal(cred.calls.length, 0, 'never connected');
  ok(true, '7n. credentialed destination URLs refused (no secrets ever transmitted)');
}
{
  // 7o. the endpoint never accepts a raw URL from the client — only
  // providerId + media context identifiers + the bounded media title.
  const endpoint = read('src/routes/api/downloader/json/+server.ts');
  for (const param of ['url', 'target', 'endpoint', 'api', 'fetch', 'proxy']) {
    assert.doesNotMatch(endpoint, new RegExp(`searchParams\\.get\\('${param}'`), `no ${param} param accepted`);
  }
  for (const param of ['providerId', 'mediaType', 'tmdbId', 'title', 'season', 'episode', 'contentType']) {
    assert.match(endpoint, new RegExp(`searchParams\\.get\\('${param}'`), `${param} param read`);
  }
  // The title is the ONLY new free-text field, so it must be strictly
  // bounded (400 before any work) and handed to the resolver verbatim —
  // the shared builder slugifies it server-side.
  assert.equal(JSON_DOWNLOADER_TITLE_MAX_CHARS, 300, 'title bound is 300 chars');
  assert.match(endpoint, /titleParam !== null && titleParam\.length > JSON_DOWNLOADER_TITLE_MAX_CHARS/, 'oversized title rejected in the validation gate');
  assert.match(endpoint, /\.\.\.\(titleParam \? \{ title: titleParam \} : \{\}\),/, 'bounded title forwarded to the resolver');
  // And it never fetches the returned media URLs — only the configured API.
  assert.doesNotMatch(endpoint, /fetch\(\s*(outcome|link|links)\.?(url|links)?/i, 'never fetches returned media URLs');
  ok(true, '7o. endpoint accepts only identifiers + the bounded title — never a raw URL; title rejected at 300 chars');
}
{
  // 7p. upstream explicit error → generic upstream-error outcome.
  const errored = fetchRecorder(() => jsonResponse({ ok: false, error: 'title not found' }));
  const outcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(errored.fetcher));
  assert.equal(outcome.status, 'upstream-error', 'explicit upstream failure mapped');
  ok(true, '7p. explicit upstream ok=false/error → generic upstream-error (no raw JSON exposed)');
}

// ============================================================
// §8 — DownloadSheet dispatch
// ============================================================
console.log('\n8. DownloadSheet dispatch');

{
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // 8a. json providers render JsonDownload — and that branch NEVER iframes.
  assert.match(sheet, /\$: isJsonDownloader = activeProvider\?\.type === 'json';/, 'json flag derived from the registry type');
  const jsonBranch = sheet.match(/\{:else if isJsonDownloader\}([\s\S]*?)(?=\{:else if iframeUrl === null\})/);
  assert.ok(jsonBranch, 'json branch exists BEFORE the null-URL branch');
  assert.match(jsonBranch![1], /<JsonDownload/, 'json branch renders the JsonDownload component');
  assert.match(jsonBranch![1], /providerId=\{activeProvider\?\.id \?\? ''\}/, 'component receives the provider identity');
  assert.match(jsonBranch![1], /mediaType=\{mediaType\}/, 'component receives the registry media type');
  assert.doesNotMatch(jsonBranch![1], /<iframe/, 'json branch renders NO iframe');
  assert.doesNotMatch(jsonBranch![1], /renderedIframeUrl/, 'json branch never uses the iframe URL');
  ok(true, '8a. type=json renders JsonDownload inline; the branch contains no iframe');
}
{
  // 8b. the reactive skip block keeps the iframe state null for json providers.
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  assert.match(
    sheet,
    /activeProvider\.slug === FOURK_DOWNLOADER_PROVIDER_ID \|\| activeProvider\.type === 'json'/,
    'json providers join the no-URL-building branch',
  );
  ok(true, '8b. json providers never build a client-side iframe URL');
}
{
  // 8c. type=embed still uses the EXACT existing iframe flow. The final
  // `{:else}` (after the null-URL branch) is the embed branch; it runs to
  // the Phase D overlay comment below the body.
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  const nullBranchIndex = sheet.indexOf('{:else if iframeUrl === null}');
  const embedStart = sheet.indexOf('{:else}', nullBranchIndex);
  const embedEnd = sheet.indexOf('<!-- Phase D', embedStart);
  assert.ok(nullBranchIndex !== -1 && embedStart !== -1 && embedEnd !== -1, 'final else (embed) branch found');
  const embedBranch = sheet.slice(embedStart, embedEnd);
  assert.match(embedBranch, /<iframe/, 'embed branch renders the iframe');
  assert.match(embedBranch, /src=\{renderedIframeUrl\}/, 'iframe src is the resolved URL');
  assert.match(embedBranch, /referrerpolicy="no-referrer"/, 'iframe keeps no-referrer');
  assert.match(embedBranch, /Try with year/, 'Cineverse alternate affordance intact');
  assert.match(embedBranch, /Open in new tab/, 'external-open fallback intact');
  ok(true, '8c. type=embed keeps the exact existing iframe flow (src/no-referrer/year-toggle/new-tab)');
}
{
  // 8d. the Mavero + 4K special cases remain intact and take precedence.
  const sheet = read('src/lib/components/DownloadSheet.svelte');
  const maveroIndex = sheet.indexOf('{:else if isMaveroDownloader}');
  const fourkIndex = sheet.indexOf('{:else if is4kDownloader}');
  const jsonIndex = sheet.indexOf('{:else if isJsonDownloader}');
  assert.ok(maveroIndex !== -1, 'Mavero branch present');
  assert.ok(fourkIndex !== -1, '4K branch present');
  assert.ok(jsonIndex !== -1, 'json branch present');
  assert.ok(maveroIndex < fourkIndex && fourkIndex < jsonIndex, 'special cases render BEFORE the type dispatch');
  assert.match(sheet, /<MaveroAddonDownload/, 'MaveroAddonDownload still rendered');
  assert.match(sheet, /<FourKDownload/, 'FourKDownload still rendered');
  // 4K regression: the service + component files still exist untouched.
  const fourkService = read('src/lib/server/downloader/fourk-service.ts');
  assert.match(fourkService, /export async function fetchFourKLinks/, 'fetchFourKLinks still exported');
  assert.ok(readFileSync(path.join(REPO_ROOT, 'src/lib/components/FourKDownload.svelte'), 'utf8').length > 0, 'FourKDownload.svelte present');
  const maveroRoute = read('src/routes/api/downloader/mavero/+server.ts');
  assert.ok(maveroRoute.length > 0, 'mavero endpoint present');
  ok(true, '8d. Mavero + 4K special cases intact and ordered before the type dispatch');
}
{
  // 8e. JsonDownload component contract: identity + context props only.
  const component = read('src/lib/components/JsonDownload.svelte');
  assert.match(component, /export let providerId = '';/, 'providerId prop');
  assert.match(component, /export let mediaType: DownloadMediaType = 'movie';/, 'mediaType prop');
  assert.match(component, /export let tmdbId = '';/, 'tmdbId prop');
  assert.match(component, /export let title = '';/, 'title prop');
  assert.match(component, /\/{2} The title lets the server resolve \{titleSlug\} templates/, 'title documented as {titleSlug} context');
  assert.match(component, /params\.set\('title', title\)/, 'title forwarded to the server endpoint');
  assert.match(component, /\$\{providerId\}\|\$\{mediaType\}\|\$\{tmdbId\}\|\$\{title\}\|/, 'title participates in the reactive request key');
  assert.match(component, /\/api\/downloader\/json\?/, 'fetches the generic server endpoint');
  assert.doesNotMatch(component, /movieUrlTemplate|tvUrlTemplate/, 'never builds a provider URL client-side');
  assert.doesNotMatch(component, /<iframe/, 'renders no iframe');
  assert.doesNotMatch(component, /slugifyTitle/, 'never slugifies client-side — the server owns the slug');
  assert.match(component, /downloadAttributesFor/, 'Download uses the shared anchor helper (exact URL)');
  assert.match(component, /Retry/, 'error state offers Retry');
  assert.match(component, /links\.length === 0/, 'empty state present');
  ok(true, '8e. JsonDownload: identity + media context props (incl. title for {titleSlug}), no client URL building or slugifying, no iframe');
}

// ============================================================
// §9 — Pantyflix-shaped fixture normalization (regression fixture)
// ============================================================
console.log('\n9. Pantyflix fixture normalization');

{
  // The REAL response shape from the task, resolved end-to-end (movie).
  const movieResponse = {
    ok: true,
    downloads: [
      { server: 'StreamHG', url: 'https://streamhg.example/movie-1080.mkv', quality: 1080, size: '3.4GB', source: 'WEB-DL' },
      { server: 'EarnVids', url: 'https://earnvids.example/movie-720.mkv', quality: 720, size: '1.9GB', source: 'WEB-DL' },
      { server: 'SeekStreaming', url: 'https://seek.example/movie-360.mkv', quality: 360, size: '800MB', source: 'CAM' },
    ],
  };
  const movie = fetchRecorder(() => jsonResponse(movieResponse));
  const movieOutcome = await resolveJsonDownloadLinks(
    jsonProvider({ name: 'Pantyflix Fixture', slug: 'pantyflix-fixture' }),
    { mediaType: 'movie', tmdbId: '6263850' },
    baseDeps(movie.fetcher),
  );
  assert.equal(movieOutcome.status, 'ok', 'movie resolution ok');
  if (movieOutcome.status === 'ok') {
    assert.equal(movieOutcome.links.length, 3, 'all three links normalized');
    const first = movieOutcome.links[0];
    assert.equal(first?.url, 'https://streamhg.example/movie-1080.mkv', 'URL exact');
    assert.equal(first?.server, 'StreamHG', 'server');
    assert.equal(first?.source, 'WEB-DL', 'source');
    assert.equal(first?.quality, '1080p', 'quality 1080 → 1080p');
    assert.equal(first?.size, '3.4GB', 'size verbatim');
    assert.equal(first?.title, undefined, 'no title in the response → omitted');
  }
  assert.equal(movie.calls[0], 'https://pantyflix.org/api/streamrip/download?type=movie&id=6263850', 'movie template URL exact');
  ok(true, '9a. Pantyflix movie fixture: 3 downloads normalized (server/url/quality/size/source)');
}
{
  // TV fixture: season/episode substituted into the exact template.
  const tv = fetchRecorder(() => jsonResponse({
    ok: true,
    downloads: [
      { server: 'StreamHG', url: 'https://streamhg.example/s01e02.mkv', quality: 1080, size: '2.1GB', source: 'WEB-DL' },
      { server: 'StreamHG', url: 'https://streamhg.example/s01e02-720.mkv', quality: 720, size: '1.1GB', source: 'WEB-DL' },
    ],
  }));
  const tvOutcome = await resolveJsonDownloadLinks(
    jsonProvider(),
    { mediaType: 'tv', tmdbId: '94605', season: 1, episode: 2 },
    baseDeps(tv.fetcher),
  );
  assert.equal(tvOutcome.status, 'ok');
  assert.equal(tv.calls[0], 'https://pantyflix.org/api/streamrip/download?type=tv&id=94605&season=1&episode=2', 'tv template URL exact (season+episode)');
  if (tvOutcome.status === 'ok') {
    assert.equal(tvOutcome.links.length, 2, 'both entries kept (same server, different URLs)');
    assert.equal(tvOutcome.links[0]?.quality, '1080p');
    assert.equal(tvOutcome.links[1]?.quality, '720p');
  }
  ok(true, '9b. Pantyflix tv fixture: season/episode URL + normalized links');
}
{
  // 9c. no Pantyflix-specific adapter exists anywhere in src/ — the check
  // looks for the actual identifiers (domain + API path); doc comments
  // explaining the genericity are fine.
  const srcFiles = [
    'src/lib/server/downloader/json-normalize.ts',
    'src/lib/server/downloader/json-service.ts',
    'src/lib/components/JsonDownload.svelte',
    'src/lib/components/DownloadSheet.svelte',
    'src/routes/api/downloader/json/+server.ts',
    'src/lib/shared/downloader.ts',
  ];
  for (const file of srcFiles) {
    const src = read(file);
    assert.ok(!/pantyflix\.org/.test(src), `${file} contains no pantyflix.org host`);
    assert.ok(!/streamrip/.test(src), `${file} contains no streamrip API path`);
  }
  ok(true, '9c. no pantyflix.org/streamrip identifier anywhere in src (fully generic)');
}
{
  // 9d. empty Pantyflix-style response → clean empty (never an iframe fallback).
  const empty = fetchRecorder(() => jsonResponse({ ok: true, downloads: [] }));
  const outcome = await resolveJsonDownloadLinks(jsonProvider(), { mediaType: 'movie', tmdbId: '6263850' }, baseDeps(empty.fetcher));
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') assert.equal(outcome.links.length, 0, 'clean empty result');
  ok(true, '9d. empty downloads[] → ok with zero links (clean empty, never an exception)');
}

console.log(`\ngeneric_json_downloader_test: ${passed} checks passed (generic downloader type: migration, projection, admin form, all-placeholder URL construction incl. {titleSlug}, normalizer, endpoint security, sheet dispatch, Pantyflix fixtures)`);
