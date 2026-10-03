import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FOURK_DOWNLOADER_PROVIDER_ID,
  MAVERO_DOWNLOADER_2_PROVIDER_ID,
  MAVERO_DOWNLOADER_PROVIDER_ID,
  filterProvidersByMediaType,
  sortPublicDownloadProviders,
  type PublicDownloadProvider,
} from '$lib/shared/downloader';
import {
  builtinMaveroDownloaderProvider,
  rewriteMaveroOrigin,
  rewriteMaveroOrigins,
} from '$lib/server/downloader/public-config';

/**
 * CS-5 suite: Mavero Downloader 2 registry integration — the
 * download_providers row, the public configuration path, the provider
 * dropdown dispatch, the launch routing, and the movie/series media
 * context, plus existing-provider regression invariants.
 *
 * Deterministic: file/source contracts, pure-function fixtures, and vite
 * SSR mounts only — the suite NEVER hits the network, never opens a
 * browser, and never depends on the live Supabase catalog.
 *
 * Layers:
 *   §A  registry identity + migration (canonical ID, idempotent seed,
 *       no existing-row interference, no duplicates)
 *   §B  public configuration (origin rewrite, ordering, media filtering,
 *       enabled-only exposure, no admin-only fields)
 *   §C  DownloadSheet dispatch source contracts (slug branch, order,
 *       props parity with the Stremio panel, additive-only diff)
 *   §D  deep-link pages (movie/tv prop derivation + adult-guard parity)
 *   §E  runtime mounts — the REAL DownloadSheet through vite's SSR module
 *       graph: mavero-downloader-2 → MaveroCloudStreamDownload,
 *       mavero-downloader → MaveroAddonDownload (regression),
 *       embed/json providers → existing flows, exclusive dispatch, and
 *       movie (no season/episode) vs series (season/episode preserved)
 *       media context through the actual sheet wiring
 *   §F  existing-downloader regression invariants (frozen files,
 *       additive-only diffs, existing migration untouched)
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// The pristine pre-CS-5 commit (CS-4) — the frozen-surface pin for §F.
const PRISTINE_CS4 = '065d153';

// ---------------------------------------------------------------------------
// Fixtures — PublicDownloadProvider rows shaped exactly like the live
// registry (the migration seed values + the existing built-ins).
// ---------------------------------------------------------------------------

const MAVERO2_ROW: PublicDownloadProvider = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Mavero Downloader 2',
  slug: 'mavero-downloader-2',
  enabled: true,
  isDefault: false,
  ordering: 92,
  icon: null,
  description: 'Direct links from enabled CloudStream extensions.',
  supportsMovie: true,
  supportsTv: true,
  movieUrlTemplate: 'https://mavero.local/watch/mavero-downloader-2/movie/{tmdbId}',
  tvUrlTemplate: 'https://mavero.local/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}',
  type: 'embed',
};

const MAVERO_ROW: PublicDownloadProvider = {
  ...builtinMaveroDownloaderProvider('https://mavero.local'),
  id: '00000000-0000-4000-8000-000000000001',
  isDefault: true,
  ordering: 90,
};

const FOURK_ROW: PublicDownloadProvider = {
  ...MAVERO2_ROW,
  id: '00000000-0000-4000-8000-000000000003',
  name: '4K Downloader',
  slug: FOURK_DOWNLOADER_PROVIDER_ID,
  ordering: 95,
  enabled: false,
  movieUrlTemplate: 'https://downloads.shegu.st/movie/{tmdbId}',
  tvUrlTemplate: 'https://downloads.shegu.st/tv/{tmdbId}/{season}/{episode}',
  type: 'json',
};

const CINEVERSE_ROW: PublicDownloadProvider = {
  ...MAVERO2_ROW,
  id: '00000000-0000-4000-8000-000000000004',
  name: 'Cineverse',
  slug: 'cineverse',
  ordering: 50,
  description: 'Cineverse download links.',
  movieUrlTemplate: 'https://cineverse.modiplay.xyz/download/{titleSlug}',
  tvUrlTemplate: 'https://cineverse.modiplay.xyz/download/{titleSlug}-s{season2}e{episode2}',
};

const JSON_ROW: PublicDownloadProvider = {
  ...MAVERO2_ROW,
  id: '00000000-0000-4000-8000-000000000005',
  name: 'Direct_Mirror',
  slug: 'direct',
  ordering: 11,
  description: 'Direct mirror links.',
  movieUrlTemplate: 'https://pantyflix.org/api/streamrip/download?type=movie&id={tmdbId}',
  tvUrlTemplate: 'https://pantyflix.org/api/streamrip/download?type=tv&id={tmdbId}&season={season}&episode={episode}',
  type: 'json',
};

function pristineFile(relative: string): string | null {
  try {
    return execFileSync('git', ['show', `${PRISTINE_CS4}:${relative}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
}

/** Lists the migration filenames as they existed at the pristine commit. */
function pristineMigrationNames(): string[] {
  try {
    return execFileSync('git', ['ls-tree', '--name-only', PRISTINE_CS4, 'supabase/migrations/'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((name) => name.replace('supabase/migrations/', ''));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// §A — Registry identity + migration
// ---------------------------------------------------------------------------

function section_registry(): void {
  // §A1 stable canonical ID.
  ok(MAVERO_DOWNLOADER_2_PROVIDER_ID === 'mavero-downloader-2', '§A1: the canonical registry ID is stable and documented (mavero-downloader-2)');

  // §A2 the slug satisfies the DB CHECK pattern (lowercase-kebab).
  ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(MAVERO_DOWNLOADER_2_PROVIDER_ID), '§A2: the slug matches the download_providers slug CHECK pattern');

  // §A3 no duplicate provider IDs (distinct from every existing built-in).
  ok(
    MAVERO_DOWNLOADER_2_PROVIDER_ID !== MAVERO_DOWNLOADER_PROVIDER_ID
    && MAVERO_DOWNLOADER_2_PROVIDER_ID !== FOURK_DOWNLOADER_PROVIDER_ID,
    '§A3: no duplicate provider IDs — distinct from mavero-downloader and 4k-downloader',
  );
  const sharedSource = read('src/lib/shared/downloader.ts');
  const slugLiterals = sharedSource.match(/PROVIDER_ID = '([^']+)'/g) ?? [];
  const slugValues = slugLiterals.map((entry) => entry.split("'")[1]);
  ok(new Set(slugValues).size === slugValues.length, '§A3: every PROVIDER_ID constant in the shared module is unique');
  ok(slugValues.includes('mavero-downloader-2'), '§A3: the shared module registers the Downloader 2 constant');

  // §A4 the migration exists with the exact planned filename.
  const migrationName = '20261101000001_cloudstream_cs5_downloader2.sql';
  const migration = read(`supabase/migrations/${migrationName}`);
  ok(migration.length > 0, `§A4: the CS-5 migration exists (${migrationName})`);

  // §A5 the migration seeds the exact row.
  ok(migration.includes("'Mavero Downloader 2'"), '§A5: display name seeded (Mavero Downloader 2)');
  ok(migration.includes("'mavero-downloader-2'"), '§A5: canonical slug seeded');
  ok(migration.includes('true, false, 92,'), '§A5: enabled=true, is_default=false, ordering=92 (after mavero-downloader 90, before 4k 95)');
  ok(migration.includes("'Direct links from enabled CloudStream extensions.'"), '§A5: honest description seeded');
  ok(migration.includes('https://mavero.local/watch/mavero-downloader-2/movie/{tmdbId}'), '§A5: movie template = the placeholder-origin deep link');
  ok(migration.includes('https://mavero.local/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}'), '§A5: tv template = the placeholder-origin deep link');
  ok(migration.includes("'embed'"), '§A5: type stays embed (slug dispatch precedes type — no enum extension)');

  // §A6 idempotent.
  ok(migration.includes('on conflict (slug) do nothing;'), '§A6: the migration is idempotent (re-run is a no-op)');

  // §A7 the migration is purely additive — no existing row is touched (SQL
  // only; the docblock legitimately REFERENCES the untouched rows).
  const migrationSql = migration.replace(/--[^\n]*/g, '');
  ok(!/\b(update|delete|alter|drop|truncate)\b/i.test(migrationSql), '§A7: the migration contains no UPDATE/DELETE/ALTER/DROP/TRUNCATE (existing rows untouched)');
  for (const untouched of ["'02movie'", "'vidvault'", "'nxsha'", "'cineverse'", "'mavero-downloader'", "'4k-downloader'"]) {
    ok(!migrationSql.includes(untouched), `§A7: the migration SQL does not reference the existing ${untouched} row`);
  }

  // §A8 no secrets / credentials in the registry surface.
  ok(!/(sbp_|supabase_key|service_role|password|token)/i.test(migration), '§A8: no secrets in the migration');
  ok(!/(sbp_|supabase_key|service_role|password)/i.test(read('src/lib/shared/downloader.ts')), '§A8: no secrets in the shared downloader module');

  // §A9 the existing Phase 19 seed migration is untouched.
  const phase19 = read('supabase/migrations/20260920000000_phase19_mavero_4k_downloaders.sql');
  const pristinePhase19 = pristineFile('supabase/migrations/20260920000000_phase19_mavero_4k_downloaders.sql');
  ok(pristinePhase19 === null || pristinePhase19 === phase19, '§A9: the existing mavero-downloader seed migration is byte-identical to the pre-CS-5 commit');

  // §A10 no OTHER registry migration was added by CS-5 (Phase 2 evolution:
  // the sanctioned unified-adapter migration 20261101000002 is the ONLY other
  // addition — it adds catalog columns and never touches download_providers).
  const migrations = execFileSync('ls', [path.join(REPO_ROOT, 'supabase/migrations')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const pristineMigrations = pristineMigrationNames();
  const phase2Migration = '20261101000002_extension_phase2_unified_adapters.sql';
  const added = migrations.filter((name) => !pristineMigrations.includes(name));
  const phase2Sql = read(`supabase/migrations/${phase2Migration}`);
  const phase2SqlNoComments = phase2Sql.replace(/--[^\n]*/g, '');
  ok(
    added.length === 2
      && added.includes(migrationName)
      && added.includes(phase2Migration),
    `§A10: exactly the CS-5 + Phase 2 migrations were added (${added.join(', ') || 'none'})`,
  );
  ok(
    !/\b(download_providers)\b/i.test(phase2SqlNoComments),
    '§A10: the Phase 2 migration never touches the download_providers registry',
  );
}

// ---------------------------------------------------------------------------
// §B — Public configuration
// ---------------------------------------------------------------------------

function section_publicConfig(): void {
  // §B1 Downloader 2 is exposed with rewritten origin templates.
  const rewritten2 = rewriteMaveroOrigin(MAVERO2_ROW, 'https://mavero.app');
  ok(rewritten2.movieUrlTemplate === 'https://mavero.app/watch/mavero-downloader-2/movie/{tmdbId}', '§B1: Downloader 2 movie template rewritten to the request origin');
  ok(rewritten2.tvUrlTemplate === 'https://mavero.app/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}', '§B1: Downloader 2 tv template rewritten to the request origin');
  ok(rewritten2.slug === 'mavero-downloader-2' && rewritten2.name === 'Mavero Downloader 2' && rewritten2.ordering === 92, '§B1: the rewrite preserves every other field');

  // §B2 null templates fall back to the built-in deep links.
  const nullTemplates = rewriteMaveroOrigin({ ...MAVERO2_ROW, movieUrlTemplate: null, tvUrlTemplate: null }, 'https://mavero.app');
  ok(nullTemplates.movieUrlTemplate === 'https://mavero.app/watch/mavero-downloader-2/movie/{tmdbId}', '§B2: missing movie template falls back to the built-in deep link');
  ok(nullTemplates.tvUrlTemplate === 'https://mavero.app/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}', '§B2: missing tv template falls back to the built-in deep link');

  // §B3 non-built-in providers pass through unchanged.
  const untouched = rewriteMaveroOrigin(CINEVERSE_ROW, 'https://mavero.app');
  ok(untouched.movieUrlTemplate === CINEVERSE_ROW.movieUrlTemplate && untouched.tvUrlTemplate === CINEVERSE_ROW.tvUrlTemplate, '§B3: non-built-in providers are never rewritten');

  // §B4 the EXISTING Mavero Downloader rewrite is preserved verbatim.
  const rewritten1 = rewriteMaveroOrigin(MAVERO_ROW, 'https://mavero.app');
  ok(rewritten1.movieUrlTemplate === 'https://mavero.app/watch/mavero-downloader/movie/{tmdbId}', '§B4 (regression): the existing Mavero Downloader movie template still rewrites');
  ok(rewritten1.tvUrlTemplate === 'https://mavero.app/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}', '§B4 (regression): the existing Mavero Downloader tv template still rewrites');

  // §B5 the batch rewrite covers BOTH built-ins in one config pass.
  const batch = rewriteMaveroOrigins(
    { version: 1, updatedAt: 'now', providers: [CINEVERSE_ROW, MAVERO2_ROW, MAVERO_ROW] },
    'https://mavero.app',
  );
  ok(batch.providers[1]?.movieUrlTemplate?.startsWith('https://mavero.app/watch/mavero-downloader-2/'), '§B5: rewriteMaveroOrigins rewrites the Downloader 2 row');
  ok(batch.providers[2]?.movieUrlTemplate?.startsWith('https://mavero.app/watch/mavero-downloader/'), '§B5: rewriteMaveroOrigins still rewrites the existing Mavero row');
  ok(batch.providers[0]?.movieUrlTemplate === CINEVERSE_ROW.movieUrlTemplate, '§B5: rewriteMaveroOrigins leaves other providers untouched');

  // §B6 ordering — default first, then ordering ascending. The three
  // built-ins land in registry order: Mavero Downloader (90, default-first)
  // → Mavero Downloader 2 (92) → 4K Downloader (95); every other enabled
  // provider keeps its own ordering slot (cineverse 50 sorts before them).
  const sorted = sortPublicDownloadProviders([FOURK_ROW, MAVERO2_ROW, CINEVERSE_ROW, MAVERO_ROW]);
  ok(sorted[0]?.slug === 'mavero-downloader', '§B6: the default (Mavero Downloader) stays first');
  const builtinOrder = sorted.filter((p) => p.slug !== 'cineverse').map((p) => p.slug);
  ok(
    builtinOrder[0] === 'mavero-downloader' && builtinOrder[1] === 'mavero-downloader-2' && builtinOrder[2] === '4k-downloader',
    `§B6: the built-ins keep registry order Mavero → Mavero 2 → 4K (got ${builtinOrder.join(' → ')})`,
  );
  ok(sorted.findIndex((p) => p.slug === 'cineverse') < sorted.findIndex((p) => p.slug === 'mavero-downloader-2'), '§B6: existing providers keep their ordering slots (cineverse 50 before the built-ins 90/92)');

  // §B7 media-type capability filtering keeps Downloader 2 visible for both.
  ok(filterProvidersByMediaType([MAVERO2_ROW], 'movie').length === 1, '§B7: Downloader 2 appears on movie detail pages');
  ok(filterProvidersByMediaType([MAVERO2_ROW], 'tv').length === 1, '§B7: Downloader 2 appears on series detail pages');

  // §B8 enabled/disabled: the public reader still filters enabled-only.
  const publicConfigSource = read('src/lib/server/downloader/public-config.ts');
  ok(publicConfigSource.includes(".eq('enabled', true)"), '§B8: the public reader still filters enabled=true (a disabled Downloader 2 disappears)');
  ok(publicConfigSource.includes("from('download_providers_public')"), '§B8: the public reader still reads the sanitized view');

  // §B9 the enabled-only view + the public reader expose NO admin-only fields.
  const viewMigration = read('supabase/migrations/20261007000000_download_provider_type.sql');
  ok(viewMigration.includes('create or replace view public.download_providers_public'), '§B9: the public view definition is untouched by CS-5 (no new columns leaked)');
  const typeSource = read('src/lib/server/downloader/types.ts');
  ok(!/(api_key|secret|token|password|notes)/i.test(typeSource), '§B9: no secret-bearing fields in the downloader server types');

  // §B10 Downloader 2 carries no credentials — its configuration IS the
  // server-side CloudStream catalog (System → Integrations → Extension).
  ok(!/(apiKey|api_key|credentials|password)/i.test(read('src/lib/components/MaveroCloudStreamDownload.svelte')), '§B10: the Downloader 2 panel references no provider credentials');

  // §B11 the config endpoint path is unchanged.
  const endpoint = read('src/routes/api/downloader/config/+server.ts');
  ok(endpoint.includes('rewriteMaveroOrigins'), '§B11: the config endpoint still calls rewriteMaveroOrigins (both built-ins now)');
  ok(!endpoint.includes('withMaveroDownloaderProvider'), '§B11: no synthetic injection reintroduced');
}

// ---------------------------------------------------------------------------
// §C — DownloadSheet dispatch source contracts
// ---------------------------------------------------------------------------

function section_sheetContracts(): void {
  const sheet = read('src/lib/components/DownloadSheet.svelte');

  // §C1 imports.
  ok(sheet.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID'), '§C1: the sheet imports the Downloader 2 constant');
  ok(sheet.includes("import MaveroCloudStreamDownload from '$components/MaveroCloudStreamDownload.svelte'"), '§C1: the sheet imports the MaveroCloudStreamDownload component');

  // §C2 slug dispatch precedes the type dispatch; Downloader 2 sits between
  // the Stremio panel and the 4K panel (all slug equality — order among the
  // slug branches is semantic-neutral, but the slug checks MUST all precede
  // isJsonDownloader/the iframe else).
  const maveroIndex = sheet.indexOf('{:else if isMaveroDownloader}');
  const mavero2Index = sheet.indexOf('{:else if isMaveroDownloader2}');
  const fourkIndex = sheet.indexOf('{:else if is4kDownloader}');
  const jsonIndex = sheet.indexOf('{:else if isJsonDownloader}');
  ok(maveroIndex !== -1 && mavero2Index !== -1 && fourkIndex !== -1 && jsonIndex !== -1, '§C2: all four dispatch branches exist');
  ok(maveroIndex < fourkIndex && fourkIndex < jsonIndex && mavero2Index < jsonIndex, '§C2: slug dispatch precedes the type dispatch (existing convention preserved)');

  // §C3 the Downloader 2 branch passes the SAME media-context props the
  // Stremio panel receives (the drop-in contract from CS-4).
  const mavero2Branch = sheet.slice(mavero2Index, fourkIndex);
  ok(mavero2Branch.includes('<MaveroCloudStreamDownload'), '§C3: the branch renders MaveroCloudStreamDownload');
  ok(mavero2Branch.includes('contentId={maveroContentId}'), '§C3: contentId uses the shared derived id');
  ok(mavero2Branch.includes('mediaType={maveroMediaType}'), '§C3: mediaType uses the shared content-type mapping (movie/series/anime)');
  ok(mavero2Branch.includes('{tmdbId}'), '§C3: tmdbId forwarded');
  ok(mavero2Branch.includes('{season}') && mavero2Branch.includes('{episode}'), '§C3: season/episode forwarded (undefined for movies — parent-gated)');
  ok(mavero2Branch.includes('onOpenInSheet={openEmbeddedSheet}'), '§C3: the shared embedded-sheet callback is reused (no second sheet)');

  // §C3b props parity with the existing Stremio panel branch.
  const maveroBranch = sheet.slice(maveroIndex, mavero2Index);
  ok(maveroBranch.includes('contentId={maveroContentId}') && maveroBranch.includes('mediaType={maveroMediaType}') && maveroBranch.includes('onOpenInSheet={openEmbeddedSheet}'), '§C3b: the existing MaveroAddonDownload branch keeps its exact props');

  // §C4 the no-URL-building reactive skip includes the new slug.
  ok(
    /MAVERO_DOWNLOADER_2_PROVIDER_ID \|\| activeProvider\.slug === FOURK_DOWNLOADER_PROVIDER_ID \|\| activeProvider\.type === 'json'/.test(sheet)
      || /MAVERO_DOWNLOADER_PROVIDER_ID \|\| activeProvider\.slug === MAVERO_DOWNLOADER_2_PROVIDER_ID/.test(sheet),
    '§C4: the Downloader 2 slug joins the no-iframe-URL branch (no client URL building)',
  );

  // §C5 the existing branches are all still present.
  ok(sheet.includes('<MaveroAddonDownload') && sheet.includes('<FourKDownload') && sheet.includes('<JsonDownload'), '§C5: MaveroAddonDownload / FourKDownload / JsonDownload branches preserved');

  // §C6 additive-only diff vs the pristine CS-4 commit (multiset diff — the
  // exact convention the CS-4 suite used for DownloaderFilterSheet).
  const pristineSheet = pristineFile('src/lib/components/DownloadSheet.svelte');
  if (pristineSheet !== null) {
    const removed = pristineSheet.split('\n').filter((line) => !sheet.includes(line));
    const added = sheet.split('\n').filter((line) => !pristineSheet.includes(line));
    // The ONLY removals are the five no-URL comment lines (rewritten for the
    // fourth panel) + the ONE code line they annotated — the old skip
    // condition, replaced verbatim-plus-one-clause by its extension below.
    const codeRemovals = removed.filter((line) => !line.trim().startsWith('//'));
    ok(removed.length === 6, `§C6: exactly the annotated block was rewritten (removed ${removed.length})`);
    ok(codeRemovals.length === 1, `§C6: exactly ONE code line was removed (the old skip condition — removed ${codeRemovals.length})`);
    ok(
      codeRemovals.length === 1
      && codeRemovals[0].includes("activeProvider.slug === MAVERO_DOWNLOADER_PROVIDER_ID || activeProvider.slug === FOURK_DOWNLOADER_PROVIDER_ID || activeProvider.type === 'json') {")
      && codeRemovals[0].includes('if ('),
      '§C6: the removed code line is the old no-URL skip condition (extended, not weakened)',
    );
    // Every added line belongs to the CS-5 wiring: the two imports, the
    // extended condition, the derived flag, the render branch, or comments.
    const ALLOWED = [
      'MAVERO_DOWNLOADER_2_PROVIDER_ID',
      "import MaveroCloudStreamDownload from '$components/MaveroCloudStreamDownload.svelte'",
      'isMaveroDownloader2',
      '<MaveroCloudStreamDownload',
      'Mavero Downloader + Mavero Downloader 2 + 4K Downloader render their',
      "own inline panels (no iframe, no URL template). Generic type='json'",
      'providers also NEVER build a client-side iframe URL — their API is',
      'resolved server-side by /api/downloader/json and rendered inline by',
      'JsonDownload. The iframe URL state stays null for all four.',
      'CS-5: Mavero Downloader 2 renders the CloudStream extensions panel',
      'INLINE — the same slug-special-casing mechanism as the Stremio downloader',
      'above, but a COMPLETELY SEPARATE resolution path (the CS-3 mavero2 API,',
      'never the Stremio addon resolver). Selecting between the two never',
      'crosses state: the {#if} chain below unmounts one panel before the',
      'other mounts (fresh component state, fresh resolution on open — the',
      'URL-lifetime contract, plan §40.7).',
      'CS-5: Mavero Downloader 2 — the CloudStream extensions panel',
      'rendered INLINE through the SAME slug-special-casing mechanism',
      'as the Stremio downloader above. It receives the IDENTICAL',
      'media-context props (contentId/mediaType/tmdbId/season/',
      'episode/title + the shared embedded-sheet callback) and mounts',
      'its own resolution against the CS-3 mavero2 API — the Stremio',
      'resolver is never involved, and the two panels never share',
      'state (mutually exclusive {#if} branches: switching providers',
      'unmounts this panel, so reopening re-resolves fresh). -->',
    ];
    ok(
      added.length > 0 && added.every((line) => ALLOWED.some((frag) => line.includes(frag))),
      `§C6: every DownloadSheet addition belongs to the CS-5 wiring (added ${added.length})`,
    );
    // C6b hard guarantees: existing behavior lines survive verbatim.
    for (const pinned of [
      "$: isMaveroDownloader = activeProvider?.slug === MAVERO_DOWNLOADER_PROVIDER_ID;",
      "$: is4kDownloader = activeProvider?.slug === FOURK_DOWNLOADER_PROVIDER_ID;",
      "$: isJsonDownloader = activeProvider?.type === 'json';",
    ]) {
      ok(sheet.includes(pinned), `§C6b: the existing derived flags are byte-identical (${pinned.slice(0, 40)}…}`);
    }
    for (const pinnedBranch of [
      'function chooseProvider(provider: PublicDownloadProvider) {',
      'urlCandidates = getDownloadUrlCandidates(activeProvider, { mediaType, tmdbId, title, season, episode, releaseYear });',
    ]) {
      ok(sheet.includes(pinnedBranch), `§C6b: the existing provider-selection + candidate logic is byte-identical (${pinnedBranch.slice(0, 48)}…`);
    }
  }

  // §C7 the dropdown itself is untouched — it renders from the provider
  // list, so the new row appears WITHOUT sheet changes.
  ok(sheet.includes('{#each filteredProviders as provider}'), '§C7: the dropdown still renders from the filtered provider list (registry-driven)');
  ok(!sheet.includes("'Mavero Downloader 2'"), '§C7: the sheet hard-codes NO provider labels (the label comes from the registry row)');

  // §C8 provider selection persistence is unchanged.
  ok(sheet.includes('function chooseProvider(provider: PublicDownloadProvider)'), '§C8: the existing chooseProvider flow is untouched');
  ok(!/:select/.test(sheet), '§C8: no new selection mechanism introduced');
}

// ---------------------------------------------------------------------------
// §D — Deep-link pages
// ---------------------------------------------------------------------------

function section_deepLinks(): void {
  // §D1 movie page: the panel mounts with movie context and NO season/episode.
  const moviePage = read('src/routes/watch/mavero-downloader-2/movie/[tmdbId]/+page.svelte');
  ok(moviePage.includes('MaveroCloudStreamDownload'), '§D1: the movie deep link renders the Downloader 2 panel');
  ok(moviePage.includes('contentId={`movie-${tmdbId}`}') && moviePage.includes('mediaType="movie"'), '§D1: movie content identity derived from the tmdbId param');
  const movieMount = moviePage.slice(moviePage.indexOf('<MaveroCloudStreamDownload'), moviePage.indexOf('</div>', moviePage.indexOf('<MaveroCloudStreamDownload')));
  ok(!movieMount.includes('season') && !movieMount.includes('episode'), '§D1: the movie deep link passes NO season/episode props (the CS-3 movie contract)');

  // §D2 tv page: season/episode preserved from the URL params.
  const tvPage = read('src/routes/watch/mavero-downloader-2/tv/[tmdbId]/[season]/[episode]/+page.svelte');
  ok(tvPage.includes('MaveroCloudStreamDownload'), '§D2: the tv deep link renders the Downloader 2 panel');
  ok(tvPage.includes('contentId={`series-${tmdbId}`}') && tvPage.includes('mediaType="series"'), '§D2: series content identity derived from the tmdbId param');
  ok(tvPage.includes('{season}') && tvPage.includes('{episode}'), '§D2: season/episode are forwarded (the CS-3 series contract)');

  // §D3 adult guards: the exact boundary the existing deep links apply.
  const movieServer = read('src/routes/watch/mavero-downloader-2/movie/[tmdbId]/+page.server.ts');
  const tvServer = read('src/routes/watch/mavero-downloader-2/tv/[tmdbId]/[season]/[episode]/+page.server.ts');
  const pristineMovieServer = read('src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.server.ts');
  const pristineTvServer = read('src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.server.ts');
  ok(movieServer.includes('assertAdultDownloadAllowed'), '§D3: the movie deep link enforces the Adult Mode guard server-side');
  ok(tvServer.includes('assertAdultDownloadAllowed'), '§D3: the tv deep link enforces the Adult Mode guard server-side');
  ok(movieServer.includes("if (!/^\\d{1,12}$/.test(tmdbId)) throw error(404, 'Content not found');"), '§D3: the movie tmdbId is bounded (1..12 digits)');
  ok(tvServer.includes('validEpisodeContext') && tvServer.includes('1 && value <= 10000'), '§D3: the tv season/episode params are bounded (1..10000)');
  ok(!movieServer.includes('getDetail') && !tvServer.includes('cloudstream'), '§D3: the deep-link loads do NO TMDB lookups or CloudStream resolution server-side (the panel fetches the API)');

  // §D4 the URL templates point at exactly these pages.
  ok(MAVERO2_ROW.movieUrlTemplate === 'https://mavero.local/watch/mavero-downloader-2/movie/{tmdbId}', '§D4: the registry movie template matches the deep-link route');
  ok(MAVERO2_ROW.tvUrlTemplate === 'https://mavero.local/watch/mavero-downloader-2/tv/{tmdbId}/{season}/{episode}', '§D4: the registry tv template matches the deep-link route');
  // The existing deep links remain untouched.
  ok(pristineMovieServer.includes('assertAdultDownloadAllowed'), '§D4 (regression): the existing Mavero deep links still exist');
  ok(read('src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.svelte').includes('MaveroAddonDownload'), '§D4 (regression): the existing deep links still render the Stremio panel');
}

// ---------------------------------------------------------------------------
// §E — Runtime mounts: the REAL DownloadSheet through vite's SSR graph
// ---------------------------------------------------------------------------

type MountableComponent = unknown;

type SheetProps = {
  open?: boolean;
  title?: string;
  providers: PublicDownloadProvider[];
  selectedProviderId?: string | null;
  mediaType?: 'movie' | 'tv';
  tmdbId?: string;
  contentId?: string;
  contentType?: 'movie' | 'series' | 'anime' | '';
  season?: number | undefined;
  episode?: number | undefined;
  releaseYear?: number | undefined;
  onClose?: () => void;
};

async function section_runtimeMount(): Promise<void> {
  // The sheet's focus management uses requestAnimationFrame when open=true.
  // In PRODUCTION this only runs client-side (the sheet mounts closed during
  // SSR and opens on user interaction); the test mounts it OPEN directly, so
  // provide a minimal rAF shim for the Node environment (test-harness only).
  const globalAny = globalThis as Record<string, unknown>;
  if (typeof globalAny.requestAnimationFrame !== 'function') {
    globalAny.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0) as unknown as number;
    globalAny.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  }

  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    // Load svelte/server THROUGH vite so the sheet and the render entry
    // share ONE svelte runtime instance (the D-020 dual-instance pitfall).
    const svelteServer = (await server.ssrLoadModule('svelte/server')) as { render: (component: MountableComponent, options: { props: Record<string, unknown> }) => { body: string } };
    const sheetMod = (await server.ssrLoadModule('/src/lib/components/DownloadSheet.svelte')) as { default: MountableComponent };
    const DownloadSheet = sheetMod.default;

    const renderSheet = (props: SheetProps): { html: string; err: unknown } => {
      try {
        const result = svelteServer.render(DownloadSheet, { props: { open: true, onClose: () => {}, ...props } as Record<string, unknown> });
        return { html: result.body, err: null };
      } catch (e) {
        return { html: '', err: e };
      }
    };

    // §E1 Mavero Downloader 2 → MaveroCloudStreamDownload (the launch routing).
    const e1 = renderSheet({ providers: [MAVERO2_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e1.err === null, `§E1: the sheet with the mavero-downloader-2 provider mounts WITHOUT throwing — got: ${e1.err instanceof Error ? e1.err.message : String(e1.err)}`);
    ok(/mcd\b/.test(e1.html) || e1.html.includes('mcd-'), '§E1: the Downloader 2 panel (.mcd) renders INSIDE the sheet');
    ok(!/mad\b/.test(e1.html) && !e1.html.includes('mad-'), '§E1: the Stremio panel (.mad) does NOT render (exclusive dispatch)');
    ok(e1.html.includes('Mavero Downloader 2'), '§E1: the dropdown label shows the registry name');

    // §E2 Mavero Downloader → MaveroAddonDownload (existing behavior unchanged).
    const e2 = renderSheet({ providers: [MAVERO_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e2.err === null, `§E2: the sheet with the mavero-downloader provider still mounts — got: ${e2.err instanceof Error ? e2.err.message : String(e2.err)}`);
    ok(/mad\b/.test(e2.html) || e2.html.includes('mad-'), '§E2: the Stremio panel (.mad) renders (existing launch routing)');
    ok(!/mcd\b/.test(e2.html) && !e2.html.includes('mcd-'), '§E2: the Downloader 2 panel does NOT render for the Stremio provider');

    // §E3 exclusive dispatch with BOTH providers selectable — the selected
    // provider alone mounts; switching remounts the other branch (no state
    // leak between the two panels).
    const e3a = renderSheet({ providers: [MAVERO_ROW, MAVERO2_ROW], selectedProviderId: MAVERO2_ROW.id, title: 'T', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e3a.html.includes('mcd-') && !e3a.html.includes('mad-'), '§E3: selected Downloader 2 → ONLY the Downloader 2 panel mounts');
    const e3b = renderSheet({ providers: [MAVERO_ROW, MAVERO2_ROW], selectedProviderId: MAVERO_ROW.id, title: 'T', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e3b.html.includes('mad-') && !e3b.html.includes('mcd-'), '§E3: selected Mavero Downloader → ONLY the Stremio panel mounts (no stale Downloader 2 state)');
    ok(e3a.html.includes('Mavero Downloader 2') && e3a.html.includes('Mavero Downloader'), '§E3: the dropdown lists BOTH providers with their registry labels');

    // §E4 another provider → the existing iframe flow.
    const e4 = renderSheet({ providers: [CINEVERSE_ROW], title: 'Toxic', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie', releaseYear: 2024 });
    ok(e4.err === null, '§E4: the sheet with an embed provider mounts');
    ok(e4.html.includes('<iframe'), '§E4: an embed provider still renders the iframe branch (existing behavior)');
    ok(!e4.html.includes('mcd-') && !e4.html.includes('mad-'), '§E4: neither built-in panel renders for a third-party provider');

    // §E5 a type=json provider → the JsonDownload branch.
    const e5 = renderSheet({ providers: [JSON_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e5.html.includes('jd-'), '§E5: a json provider still renders the JsonDownload branch (existing behavior)');
    ok(!e5.html.includes('<iframe'), '§E5: the json provider is never iframed');

    // §E6 movie context: NO episode context line reaches the panel.
    const e6 = renderSheet({ providers: [MAVERO2_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie', season: undefined, episode: undefined });
    ok(!e6.html.includes('Season '), '§E6 (movie): no Season/Episode context is displayed — no episode context is sent');

    // §E7 series context: season+episode flow through the sheet into the panel.
    const e7 = renderSheet({ providers: [MAVERO2_ROW], title: 'Arcane', mediaType: 'tv', tmdbId: '94605', contentId: 'series-94605', contentType: 'series', season: 2, episode: 4 });
    ok(e7.html.includes('Season 2 · Episode 4'), '§E7 (series): season/episode are preserved and reach the Downloader 2 panel (episode context line rendered)');

    // §E8 anime context (contentType='anime' rides the series pipeline).
    const e8 = renderSheet({ providers: [MAVERO2_ROW], title: 'Anime', mediaType: 'tv', tmdbId: '12345', contentId: 'anime-12345', contentType: 'anime', season: 1, episode: 1 });
    ok(e8.html.includes('Season 1 · Episode 1'), '§E8 (anime): the anime content type is forwarded with its episode context');
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// §F — Existing-downloader regression invariants (isolation)
// ---------------------------------------------------------------------------

function section_regression(): void {
  // §F1 the Stremio panel + frozen action model + registry surfaces are
  // byte-identical (public-config.ts is covered additively by §F3).
  // NOTE — the two Downloader 2 UI surfaces (cloudstream-download-view.ts,
  // MaveroCloudStreamDownload.svelte) evolved in Permanent Adapter Plan
  // Phase 1 (deadline propagation + loading-state termination); their
  // sanctioned evolution is pinned separately in §F1b below.
  for (const frozen of [
    'src/lib/components/MaveroAddonDownload.svelte',
    'src/lib/components/FourKDownload.svelte',
    'src/lib/components/JsonDownload.svelte',
    'src/lib/shared/stream-actions.ts',
    'src/lib/shared/external-player.ts',
    'src/lib/shared/download-link-types.ts',
    'src/lib/shared/downloader-filters.ts',
    'src/lib/components/DownloaderFilterSheet.svelte',
    'src/lib/components/DetailPage.svelte',
    'src/routes/api/downloader/config/+server.ts',
    'src/lib/server/downloader/admin-service.ts',
    'src/lib/server/downloader/validation.ts',
    'src/lib/server/downloader/types.ts',
  ]) {
    const current = read(frozen);
    const pristine = pristineFile(frozen);
    ok(pristine === null || pristine === current, `§F1: ${frozen} is byte-identical to the pre-CS-5 commit`);
  }

  // §F1b (Permanent Adapter Plan Phase 1): the two Downloader 2 UI surfaces
  // legitimately evolved (client-side fetch deadlines, envelope-error tab
  // settling, the settleCloudStreamLoadingTabs helper). Regression pin: the
  // view model is ADDITIVE-ONLY vs the pre-CS-5 commit; the component may
  // remove ONLY the exact superseded fetch/mapping lines listed below.
  {
    const view = read('src/lib/shared/cloudstream-download-view.ts');
    const pristineView = pristineFile('src/lib/shared/cloudstream-download-view.ts');
    if (pristineView !== null) {
      const removedView = pristineView.split('\n').filter((line) => !view.includes(line));
      ok(removedView.length === 0, `§F1b: cloudstream-download-view.ts removes NOTHING (removed ${removedView.length})`);
      const addedView = view.split('\n').filter((line) => !pristineView.includes(line));
      ok(
        addedView.length > 0 && addedView.every((line) =>
          line.includes('settleCloudStreamLoadingTabs')
          || line.includes('Permanent Adapter')
          || line.includes('Phase 1')
          || line.includes("tab.status === 'loading'")
          || /^\s*(\/\*\*|\*|\/\/|$)/.test(line)),
        `§F1b: cloudstream-download-view.ts additions are ONLY the Phase 1 settle helper (added ${addedView.length})`,
      );
    }

    const component = read('src/lib/components/MaveroCloudStreamDownload.svelte');
    const pristineComponent = pristineFile('src/lib/components/MaveroCloudStreamDownload.svelte');
    if (pristineComponent !== null) {
      const removed = [...new Set(pristineComponent.split('\n').filter((line) => !component.includes(line)))].sort();
      // The EXACT superseded lines: the three raw fetch call heads + their
      // direct-signal lines + the pre-Phase-1 inline NETWORK_ERROR mapping +
      // the superseded envelope comment. NOTHING else may disappear.
      const expectedRemoved = [
        '        // The tabs remain visible; the typed envelope drives the message.',
        '          ? { ...tab, status: \'failed\' as const, links: [], errorCode: \'NETWORK_ERROR\' as const }',
        '        signal: abort.signal,',
        '      tabs = tabs.map((tab) =>',
        '        tab.status === \'loading\'',
        '          : tab,',
        `      const response = await fetch(\`/api/downloader/mavero2/extension?\${params.toString()}\`, {`,
        `      const response = await fetch(\`/api/downloader/mavero2/tabs?\${buildParams().toString()}\`, {`,
        `      const response = await fetch(\`/api/downloader/mavero2?\${buildParams().toString()}\`, {`,
      ].sort();
      ok(
        removed.length === expectedRemoved.length && removed.every((line, i) => line === expectedRemoved[i]),
        `§F1b: MaveroCloudStreamDownload.svelte removes ONLY the superseded fetch/mapping lines (removed ${removed.length}: ${removed.join(' ⏎ ').slice(0, 160)}…)`,
      );
      const added = component.split('\n').filter((line) => !pristineComponent.includes(line));
      ok(
        added.length > 0 && added.every((line) =>
          /^\s*(\/\*\*|\*|\/\/|$)/.test(line)
          || line.includes('settleCloudStreamLoadingTabs')
          || line.includes('fetchWithTimeout')
          || line.includes('timedOut')
          || line.includes('timeoutController')
          || line.includes('TABS_FETCH_TIMEOUT_MS')
          || line.includes('RESOLVE_FETCH_TIMEOUT_MS')
          || line.includes('PROVIDER_TIMEOUT')
          || line.includes('Phase 1')
          || line.includes('Permanent Adapter')
          || line.includes('clearTimeout(timer)')
          || line.includes('signal.removeEventListener')
          || line.includes('signal.addEventListener')
          || line.includes('signal.aborted')
          || line.includes('const response = await fetch(url')
          || line.includes('return { response, timedOut }')
          || line.includes('timeoutMs: number')
          || line.includes('url: string')
          || line.includes('signal: AbortSignal')
          || line.includes('): Promise<{ response: Response; timedOut: boolean }> {')
          || line.includes('let timedOut = false')
          || line.includes('const timer = setTimeout(() => {')
          || line.includes('}, timeoutMs);')
          || line.includes('/api/downloader/mavero2')
          || line.includes('abort.signal,')
          || line.includes('activeTabId = null;')
          || line.includes('tabs = settleCloudStreamLoadingTabs(tabs, \'NETWORK_ERROR\')')
          || line.includes('tabs = settleCloudStreamLoadingTabs(tabs, parsed.code)')
          || line.includes("resolveEnvelope = { code: 'PROVIDER_TIMEOUT' }")),
        `§F1b: MaveroCloudStreamDownload.svelte additions are ONLY the Phase 1 deadline/settle code (added ${added.length})`,
      );
      // The pristine lifecycle contracts survive verbatim (destroy-time
      // cancellation of every in-flight request + stale-response guards).
      ok(component.includes('tabsAbort?.abort();'), '§F1b: destroy-time tabs abort survives');
      ok(component.includes('resolveAbort?.abort();'), '§F1b: destroy-time resolve abort survives');
      ok(component.includes('retryAborts.values()'), '§F1b: destroy-time retry aborts survive');
    }
  }

  // §F2 the shared downloader module diff is ONLY the new constant.
  const sharedSource = read('src/lib/shared/downloader.ts');
  const pristineShared = pristineFile('src/lib/shared/downloader.ts');
  if (pristineShared !== null) {
    const removed = pristineShared.split('\n').filter((line) => !sharedSource.includes(line));
    const added = sharedSource.split('\n').filter((line) => !pristineShared.includes(line));
    ok(removed.length === 0, `§F2: shared/downloader.ts removes NOTHING (removed ${removed.length})`);
    ok(
      added.length > 0 && added.every((line) => line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID') || line.includes('mavero-downloader-2') || line.trim().startsWith('*') || line.trim().startsWith('/*') || line.trim().startsWith('//') || line.trim() === '' || line.includes('migration') || line.includes('CloudStream') || line.includes('MaveroCloudStreamDownload') || line.includes('public config') || line.includes('DownloadSheet') || line.includes('reference ONE constant') || line.includes(' INLINE (') || line.includes('completely separate resolution')),
      `§F2: shared/downloader.ts additions are ONLY the Downloader 2 constant + its docblock (added ${added.length})`,
    );
    ok(pristineShared.includes("export const MAVERO_DOWNLOADER_PROVIDER_ID = 'mavero-downloader';"), '§F2: the existing Mavero Downloader constant is untouched');
  }

  // §F3 the public-config diff is ONLY the additive rewrite branch (the
  // import line gained the new constant; the rewrite docblock was extended;
  // the function gained the mavero-downloader-2 branch BEFORE the untouched
  // mavero-downloader branch).
  const publicConfig = read('src/lib/server/downloader/public-config.ts');
  const pristinePublicConfig = pristineFile('src/lib/server/downloader/public-config.ts');
  if (pristinePublicConfig !== null) {
    const removed = pristinePublicConfig.split('\n').filter((line) => !publicConfig.includes(line));
    const added = publicConfig.split('\n').filter((line) => !pristinePublicConfig.includes(line));
    // Removed: the old import line (extended in place) + 5 docblock lines.
    const codeRemovals = removed.filter((line) => !line.trim().startsWith('*'));
    ok(removed.length === 6, `§F3: exactly the import line + the rewritten docblock lines were replaced (removed ${removed.length})`);
    ok(codeRemovals.length === 1, `§F3: exactly ONE code line was removed (the import — extended, not weakened — removed ${codeRemovals.length})`);
    ok(
      codeRemovals.length === 1
      && codeRemovals[0].includes("import { MAVERO_DOWNLOADER_PROVIDER_ID, sortPublicDownloadProviders } from '$lib/shared/downloader';"),
      '§F3: the removed code line is the OLD import (the new import only ADDS the constant)',
    );
    // Added: the new import, the new export, the extended docblock, and the
    // mavero-downloader-2 rewrite branch (all carry the constant, the
    // deep-link paths, or docblock markers).
    ok(
      added.length > 0
      && added.every((line) =>
        line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID')
        || line.includes('mavero-downloader-2')
        || line.trim().startsWith('*')
        || line.trim().startsWith('/**')
        || line.includes('origin) ?? `${origin}/watch/mavero-downloader')
        || line.trim() === 'return {'
        || line.trim() === '...provider,'
        || line.trim() === '};'
        || line.trim() === 'resolve.'),
      `§F3: public-config.ts additions are ONLY the Downloader 2 rewrite branch + docblock (added ${added.length})`,
    );
    // The existing mavero-downloader branch survives VERBATIM (Phase 19
    // behavior byte-identical).
    for (const pinned of [
      "if (provider.slug !== MAVERO_DOWNLOADER_PROVIDER_ID) return provider;",
      "movieUrlTemplate: provider.movieUrlTemplate?.replace('https://mavero.local', origin) ?? `${origin}/watch/mavero-downloader/movie/{tmdbId}`,",
      "tvUrlTemplate: provider.tvUrlTemplate?.replace('https://mavero.local', origin) ?? `${origin}/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}`,",
    ]) {
      ok(publicConfig.includes(pinned), `§F3: the existing mavero-downloader rewrite branch survives verbatim (${pinned.slice(0, 48)}…`);
    }
  }

  // §F4 no admin surface was modified for the registry integration.
  for (const adminFile of [
    'src/routes/admin/system/downloads/+page.server.ts',
    'src/routes/admin/system/downloads/+page.svelte',
    'src/lib/components/admin2/AdminAppShell.svelte',
  ]) {
    const current = read(adminFile);
    const pristine = pristineFile(adminFile);
    ok(pristine === null || pristine === current, `§F4: ${adminFile} is untouched (the generic admin CRUD lists the new row automatically)`);
  }

  // §F5 the existing mavero2 API + Downloader 2 service evolved ONLY additively.
  // (CS-5 added no backend behavior; Permanent Adapter Plan Phase 1 added ONLY
  // the client-disconnect signal threading; Phase 2 replaced the three legacy
  // registry-lookup call sites + the import + the catalog select with the
  // TYPE-AWARE unified-registry equivalents — the ONLY removed lines are those
  // exact pre-Phase-2 lookup lines, nothing else.)
  {
    const untouched = 'src/routes/api/downloader/mavero2/tabs/+server.ts';
    const currentTabs = read(untouched);
    const pristineTabs = pristineFile(untouched);
    ok(pristineTabs === null || pristineTabs === currentTabs, `§F5: ${untouched} is byte-identical (no provider resolution on the tabs path)`);

    for (const csFile of [
      'src/routes/api/downloader/mavero2/+server.ts',
      'src/routes/api/downloader/mavero2/extension/+server.ts',
      'src/lib/server/cloudstream/downloader/service.ts',
    ]) {
      const current = read(csFile);
      const pristine = pristineFile(csFile);
      if (pristine === null) {
        ok(true, `§F5: ${csFile} present`);
        continue;
      }
      const removed = pristine.split('\n').filter((line) => !current.includes(line));
      const added = current.split('\n').filter((line) => !pristine.includes(line));
      // Phase 2 sanctioned removals: ONLY the legacy untyped registry lookup
      // (import + 3 call sites) and the pre-unification catalog select.
      const sanctionedRemoval = (line: string) =>
        line === "import { lookupCloudStreamAdapterInstance } from '../adapters/registry';"
        || line === '    const adapter = lookupCloudStreamAdapterInstance(row.internal_name);'
        || line === '      const adapter = lookupCloudStreamAdapterInstance(row.internal_name);'
        || line === '  const adapter = lookupCloudStreamAdapterInstance(row.internal_name);'
        || line === "    .select('repository_id, internal_name, name, icon_url, enabled');";
      ok(
        removed.every(sanctionedRemoval),
        `§F5: ${csFile} removes NOTHING except the sanctioned legacy lookup lines (removed ${removed.length})`,
      );
      ok(
        added.length > 0 && added.every((line) =>
          line.includes('Phase 1')
          || line.includes('Permanent Adapter')
          || line.includes('Phase 2')
          || line.includes('PHASE 2')
          || line.includes('canonicalAdapterKeyForRow')
          || line.includes('executableAdapterForExtension')
          || line.includes('seenCanonicalKeys')
          || line.includes('integration_type')
          || line.includes('adapter-registry')
          || /^\s*(\/\*\*|\*|\/\/|$)/.test(line)
          || line.includes('{ signal: request.signal }')
          || line.includes('signal?: AbortSignal;')
          || line.includes("...(deps.signal !== undefined ? { signal: deps.signal } : {})")),
        `§F5: ${csFile} additions are ONLY the Phase 1 cancellation threading + Phase 2 type-aware registry binding (added ${added.length})`,
      );
    }
  }

  // §F6 the existing deep-link tree is untouched.
  for (const deepFile of [
    'src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.server.ts',
    'src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.svelte',
    'src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.server.ts',
    'src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.svelte',
  ]) {
    const current = read(deepFile);
    const pristine = pristineFile(deepFile);
    ok(pristine === null || pristine === current, `§F6: ${deepFile} is byte-identical (existing deep links unchanged)`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

section_registry();
section_publicConfig();
section_sheetContracts();
section_deepLinks();
await section_runtimeMount();
section_regression();

console.log(`cloudstream_registry_integration_test: ${passed} checks passed (CS-5 Downloader 2 registry integration: identity, migration, public config, dropdown dispatch, launch routing, movie/series context, existing-provider isolation)`);
