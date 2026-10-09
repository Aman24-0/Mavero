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

  // §A10 no OTHER registry migration was added by CS-5 (FINAL TASK
  // evolution: the sanctioned additions are the unified-adapter migration
  // 20261101000002, the Phase 3 builder migration 20261101000003, and the
  // unified-downloader global-order migration 20261004000000 — the last
  // one DOES touch download_providers, by the documented retirement
  // statement (disable the mavero-downloader-2 row), plus the additive
  // ordering table. DURABLE BUILD LIFECYCLE (20261102000000, sanctioned):
  // the adapter-build-lifecycle migration (job rows + pointer + sweep
  // indexes; NEVER touches download_providers) is also sanctioned.
  // LT-5 ANALYTICS TAXONOMY (20261103000000, sanctioned): the Live TV
  // analytics events migration (widens the analytics_events CHECK
  // constraint only — NEVER touches download_providers or any registry
  // table) is sanctioned per live-tv-plan.md §14.
  // LT-15 EMBED FALLBACK EVENT (20261104000000, sanctioned): the Live TV
  // automatic embed-fallback analytics migration (widens the
  // analytics_events CHECK constraint with ONE event — never touches
  // download_providers or any registry table) is sanctioned per the LT-15
  // directive's analytics requirement.
  // VIDRIFT PROVIDER (20261105000000, sanctioned): the VidRift embed
  // provider registration migration (insert-only streaming_providers +
  // streaming_sources rows — never touches download_providers or any
  // registry table) is sanctioned per the VidRift integration directive.
  const migrations = execFileSync('ls', [path.join(REPO_ROOT, 'supabase/migrations')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const pristineMigrations = pristineMigrationNames();
  const phase2Migration = '20261101000002_extension_phase2_unified_adapters.sql';
  const phase3Migration = '20261101000003_extension_phase3_builder.sql';
  const unifiedMigration = '20261004000000_unified_downloader_global_order.sql';
  const lifecycleMigration = '20261102000000_adapter_build_lifecycle.sql';
  const liveTvAnalyticsMigration = '20261103000000_live_tv_analytics_events.sql';
  const liveTvFallbackMigration = '20261104000000_live_tv_fallback_embed_event.sql';
  const vidriftProviderMigration = '20261105000000_vidrift_provider.sql';
  const added = migrations.filter((name) => !pristineMigrations.includes(name));
  const phase2Sql = read(`supabase/migrations/${phase2Migration}`);
  const phase2SqlNoComments = phase2Sql.replace(/--[^\n]*/g, '');
  const phase3Sql = read(`supabase/migrations/${phase3Migration}`);
  const phase3SqlNoComments = phase3Sql.replace(/--[^\n]*/g, '');
  const unifiedSql = read(`supabase/migrations/${unifiedMigration}`);
  const unifiedSqlNoComments = unifiedSql.replace(/--[^\n]*/g, '');
  ok(
    added.length === 8
      && added.includes(migrationName)
      && added.includes(phase2Migration)
      && added.includes(phase3Migration)
      && added.includes(unifiedMigration)
      && added.includes(lifecycleMigration)
      && added.includes(liveTvAnalyticsMigration)
      && added.includes(liveTvFallbackMigration)
      && added.includes(vidriftProviderMigration),
    `§A10: exactly the CS-5 + Phase 2 + Phase 3 + FINAL TASK + build-lifecycle + LT-5-analytics + LT-15-fallback-event + VidRift-provider migrations were added (${added.join(', ') || 'none'})`,
  );
  // VIDRIFT (sanctioned): insert-only registration — no destructive verbs,
  // no download_providers / registry-table references.
  {
    const vidriftSqlNoComments = read(`supabase/migrations/${vidriftProviderMigration}`).replace(/--[^\n]*/g, '');
    ok(!/\b(update|delete|alter|drop|truncate)\b/i.test(vidriftSqlNoComments), '§A10: the VidRift migration contains no UPDATE/DELETE/ALTER/DROP/TRUNCATE (insert-only)');
    ok(!vidriftSqlNoComments.includes('download_providers'), '§A10: the VidRift migration never touches download_providers');
  }
  const liveTvAnalyticsSql = read(`supabase/migrations/${liveTvAnalyticsMigration}`);
  const liveTvAnalyticsSqlNoComments = liveTvAnalyticsSql.replace(/--[^\n]*/g, '');
  ok(
    !/\b(download_providers|streaming_providers|adapter_build)\b/i.test(liveTvAnalyticsSqlNoComments),
    '§A10: the LT-5 analytics migration never touches the provider registries or build tables',
  );
  const liveTvFallbackSql = read(`supabase/migrations/${liveTvFallbackMigration}`);
  const liveTvFallbackSqlNoComments = liveTvFallbackSql.replace(/--[^\n]*/g, '');
  ok(
    !/\b(download_providers|streaming_providers|adapter_build)\b/i.test(liveTvFallbackSqlNoComments),
    '§A10: the LT-15 fallback-event migration never touches the provider registries or build tables',
  );
  const lifecycleSql = read(`supabase/migrations/${lifecycleMigration}`);
  const lifecycleSqlNoComments = lifecycleSql.replace(/--[^\n]*/g, '');
  ok(
    !/\b(download_providers)\b/i.test(lifecycleSqlNoComments),
    '§A10: the build-lifecycle migration never touches the download_providers registry',
  );
  ok(
    /update\s+public\.download_providers\s+set\s+enabled\s*=\s*false\s+where\s+slug\s*=\s*'mavero-downloader-2'/i.test(unifiedSqlNoComments)
      && (unifiedSqlNoComments.match(/\bdownload_providers\b/gi) ?? []).length === 1,
    '§A10: the FINAL TASK migration touches download_providers ONLY through the idempotent retire statement',
  );
  ok(
    !/\b(download_providers)\b/i.test(phase2SqlNoComments),
    '§A10: the Phase 2 migration never touches the download_providers registry',
  );
  ok(
    !/\b(download_providers)\b/i.test(phase3SqlNoComments),
    '§A10: the Phase 3 migration never touches the download_providers registry',
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

  // §C1 imports (FINAL TASK evolution — the CS-5 Downloader 2 wiring is
  // RETIRED; the unified panel replaces the Stremio inline panel):
  ok(!sheet.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID'), '§C1: the sheet no longer references the Downloader 2 constant (retired)');
  ok(!sheet.includes("import MaveroCloudStreamDownload from '$components/MaveroCloudStreamDownload.svelte'"), '§C1: the sheet no longer imports the MaveroCloudStreamDownload component');
  ok(sheet.includes("import MaveroUnifiedDownload from '$components/MaveroUnifiedDownload.svelte'"), '§C1: the sheet imports the UNIFIED downloader panel');

  // §C2 slug dispatch precedes the type dispatch (all slug equality — the
  // slug checks MUST all precede isJsonDownloader/the iframe else). The
  // Downloader 2 branch is GONE (retired): exactly three dispatch branches.
  const maveroIndex = sheet.indexOf('{:else if isMaveroDownloader}');
  const mavero2Index = sheet.indexOf('{:else if isMaveroDownloader2}');
  const fourkIndex = sheet.indexOf('{:else if is4kDownloader}');
  const jsonIndex = sheet.indexOf('{:else if isJsonDownloader}');
  ok(maveroIndex !== -1 && fourkIndex !== -1 && jsonIndex !== -1, '§C2: the three dispatch branches exist');
  ok(mavero2Index === -1, '§C2: the retired Downloader 2 branch no longer exists');
  ok(maveroIndex < fourkIndex && fourkIndex < jsonIndex, '§C2: slug dispatch precedes the type dispatch (existing convention preserved)');

  // §C3 the unified branch passes the SAME media-context props the old
  // Stremio panel received (the drop-in contract, preserved by the swap).
  const unifiedBranch = sheet.slice(maveroIndex, fourkIndex);
  ok(unifiedBranch.includes('<MaveroUnifiedDownload'), '§C3: the branch renders MaveroUnifiedDownload');
  ok(unifiedBranch.includes('contentId={maveroContentId}'), '§C3: contentId uses the shared derived id');
  ok(unifiedBranch.includes('mediaType={maveroMediaType}'), '§C3: mediaType uses the shared content-type mapping (movie/series/anime)');
  ok(unifiedBranch.includes('{tmdbId}'), '§C3: tmdbId forwarded');
  ok(unifiedBranch.includes('{season}') && unifiedBranch.includes('{episode}'), '§C3: season/episode forwarded (undefined for movies — parent-gated)');
  ok(unifiedBranch.includes('onOpenInSheet={openEmbeddedSheet}'), '§C3: the shared embedded-sheet callback is reused (no second sheet)');

  // §C3b the unified panel replaces the old Stremio branch 1:1 (props parity).
  ok(unifiedBranch.includes('contentId={maveroContentId}') && unifiedBranch.includes('mediaType={maveroMediaType}') && unifiedBranch.includes('onOpenInSheet={openEmbeddedSheet}'), '§C3b: the unified branch keeps the exact panel props contract');

  // §C4 the no-URL-building reactive skip covers the unified panel (the
  // retired slug constant no longer appears — the retirement is complete).
  ok(
    /activeProvider\.slug === MAVERO_DOWNLOADER_PROVIDER_ID \|\| activeProvider\.slug === FOURK_DOWNLOADER_PROVIDER_ID \|\| activeProvider\.type === 'json'/.test(sheet),
    '§C4: the no-iframe-URL skip covers exactly mavero-downloader + 4k + json (no retired slug)',
  );

  // §C5 the existing branches are all still present.
  ok(sheet.includes('<FourKDownload') && sheet.includes('<JsonDownload') && sheet.includes('<MaveroUnifiedDownload'), '§C5: MaveroUnifiedDownload / FourKDownload / JsonDownload branches preserved');

  // §C6 (FINAL TASK evolution — second sanctioned recalibration, recorded
  // in-file): the unified-panel swap + Downloader-2 branch retirement + the
  // PART J dropdown fix. Comment-stripped code diff: every removal and
  // addition must belong to those three sanctioned changes.
  const pristineSheet = pristineFile('src/lib/components/DownloadSheet.svelte');
  if (pristineSheet !== null) {
    const stripSheetComments = (text: string): string[] =>
      text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\s*\/\/.*$/, '').trimEnd())
        .filter((line) => line.trim().length > 0);
    const pristineCode = stripSheetComments(pristineSheet);
    const sheetCode = stripSheetComments(sheet);
    const codeRemovals = pristineCode.filter((line) => !sheetCode.includes(line));
    // MAV-23 sanctioned evolution (Fix 5, approved): the sheet adopts the
    // active title's artwork-derived palette — only the bare dl-layer div
    // and hardcoded-color CSS declarations may be removed; any structural
    // or logic removal still fails.
    const isColorDeclaration = (line: string) =>
      /(background|border|color|box-shadow|text-shadow)[^:]*:/i.test(line) && /(#[0-9a-fA-F]{3,6}\b|rgba?\()/i.test(line);
    ok(
      codeRemovals.every((line) =>
        line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID')
        || line.includes('MaveroCloudStreamDownload')
        || line.includes('MaveroAddonDownload')
        || line.includes('isMaveroDownloader2')
        || line.includes('justify-content: space-between')
        || line.includes('.dl-item-name { overflow: hidden;')
        || line.includes('class="dl-layer"')
        || isColorDeclaration(line)),
      `§C6: every removed code line belongs to the retirement/unified swap/PART-J/MAV-23-palette fix (removed ${codeRemovals.length})`,
    );
    const codeAdditions = sheetCode.filter((line) => !pristineCode.includes(line));
    ok(
      codeAdditions.some((line) => line.includes('MaveroUnifiedDownload'))
      && codeAdditions.every((line) =>
        line.includes('MaveroUnifiedDownload')
        || line.includes('MAVERO_DOWNLOADER_2_PROVIDER_ID')
        || line.includes('MaveroCloudStreamDownload')
        || line.includes('isMaveroDownloader')
        || line.includes('.dl-item-name')
        || line.includes('.dl-item-badge')
        || line.includes('.dl-dropdown-item')
        || line.includes('flex-start')
        || line.includes('min-width: 0')
        || line.includes('margin-left: auto')
        || line.includes('retired')
        || line.includes('retire')
        || line.includes('unified')
        // MAV-23 palette contract (Fix 5): --dp-* var fallbacks, the
        // paletteStyle prop, and the design-system text-token fallbacks.
        || line.includes('--dp-')
        || line.includes('paletteStyle')
        || line.includes('var(--color-text')),
      `§C6: every added code line is the unified swap, the retirement, or the PART J fix (added ${codeAdditions.length})`,
    );
    // C6b hard guarantees: existing behavior lines survive verbatim.
    for (const pinned of [
      "$: isMaveroDownloader = activeProvider?.slug === MAVERO_DOWNLOADER_PROVIDER_ID;",
      "$: is4kDownloader = activeProvider?.slug === FOURK_DOWNLOADER_PROVIDER_ID;",
      "$: isJsonDownloader = activeProvider?.type === 'json';",
    ]) {
      ok(sheet.includes(pinned), `§C6b: the existing derived flags are byte-identical (${pinned.slice(0, 40)}…`);
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
  // FINAL TASK evolution: the existing deep links render the UNIFIED panel
  // (add-on + plugin sources) — the same surface the DownloadSheet renders
  // inline for the mavero-downloader slug.
  ok(read('src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.svelte').includes('MaveroUnifiedDownload'), '§D4 (regression): the existing deep links render the unified panel (deep-link parity with the sheet)');
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

    // §E1 (FINAL TASK evolution — the retired Downloader 2 slug has NO
    // inline branch anymore): selecting it renders the GENERIC iframe flow
    // (its deep-link page still hosts the panel; the row is disabled at the
    // registry level so the public dropdown never offers it).
    const e1 = renderSheet({ providers: [MAVERO2_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e1.err === null, `§E1: the sheet with the retired mavero-downloader-2 provider mounts WITHOUT throwing — got: ${e1.err instanceof Error ? e1.err.message : String(e1.err)}`);
    ok(e1.html.includes('<iframe') || e1.html.includes('Loading'), '§E1: the retired slug renders the generic embed flow (NO inline panel)');
    ok(!e1.html.includes('mud-') && !e1.html.includes('mcd-') && !e1.html.includes('mad-'), '§E1: no built-in inline panel mounts for the retired slug');
    ok(e1.html.includes('Mavero Downloader 2'), '§E1: the dropdown label shows the registry name');

    // §E2 Mavero Downloader → the UNIFIED panel (.mud — add-on +
    // plugin sources; the FINAL TASK launch routing).
    const e2 = renderSheet({ providers: [MAVERO_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e2.err === null, `§E2: the sheet with the mavero-downloader provider still mounts — got: ${e2.err instanceof Error ? e2.err.message : String(e2.err)}`);
    ok(/mud\b/.test(e2.html) || e2.html.includes('mud-'), '§E2: the UNIFIED panel (.mud) renders (the FINAL TASK launch routing)');
    ok(!/mad\b/.test(e2.html) && !e2.html.includes('mad-'), '§E2: the old Stremio-only panel (.mad) does NOT render (replaced by the unified panel)');
    ok(e2.html.includes('Finding sources'), '§E2: the unified panel renders its loading state at SSR (fetch starts on mount)');

    // §E3 exclusive dispatch with BOTH providers selectable — the selected
    // provider alone mounts; switching remounts the other branch (no state
    // leak between the branches).
    const e3a = renderSheet({ providers: [MAVERO_ROW, MAVERO2_ROW], selectedProviderId: MAVERO2_ROW.id, title: 'T', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(!e3a.html.includes('mud-') && !e3a.html.includes('mad-'), '§E3: selected (retired) Downloader 2 → NO inline panel mounts (generic flow)');
    const e3b = renderSheet({ providers: [MAVERO_ROW, MAVERO2_ROW], selectedProviderId: MAVERO_ROW.id, title: 'T', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e3b.html.includes('mud-') && !e3b.html.includes('mad-') && !e3b.html.includes('mcd-'), '§E3: selected Mavero Downloader → ONLY the unified panel mounts (no stale inline state)');
    ok(e3a.html.includes('Mavero Downloader 2') && e3a.html.includes('Mavero Downloader'), '§E3: the dropdown lists BOTH providers with their registry labels');

    // §E4 another provider → the existing iframe flow.
    const e4 = renderSheet({ providers: [CINEVERSE_ROW], title: 'Toxic', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie', releaseYear: 2024 });
    ok(e4.err === null, '§E4: the sheet with an embed provider mounts');
    ok(e4.html.includes('<iframe'), '§E4: an embed provider still renders the iframe branch (existing behavior)');
    ok(!e4.html.includes('mud-') && !e4.html.includes('mcd-') && !e4.html.includes('mad-'), '§E4: neither built-in panel renders for a third-party provider');

    // §E5 a type=json provider → the JsonDownload branch.
    const e5 = renderSheet({ providers: [JSON_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie' });
    ok(e5.html.includes('jd-'), '§E5: a json provider still renders the JsonDownload branch (existing behavior)');
    ok(!e5.html.includes('<iframe'), '§E5: the json provider is never iframed');

    // §E6 movie context: NO episode context line reaches the panel.
    const e6 = renderSheet({ providers: [MAVERO_ROW], title: 'Test Movie', mediaType: 'movie', tmdbId: '123', contentId: 'movie-123', contentType: 'movie', season: undefined, episode: undefined });
    ok(!e6.html.includes('Season '), '§E6 (movie): no Season/Episode context is displayed — no episode context is sent');

    // §E7 series context: season+episode flow through the sheet into the
    // unified panel (the episode context line renders at SSR from the props).
    const e7 = renderSheet({ providers: [MAVERO_ROW], title: 'Arcane', mediaType: 'tv', tmdbId: '94605', contentId: 'series-94605', contentType: 'series', season: 2, episode: 4 });
    ok(e7.html.includes('Season 2 · Episode 4'), '§E7 (series): season/episode are preserved and reach the unified panel (episode context line rendered)');

    // §E8 anime context (contentType='anime' rides the series pipeline).
    const e8 = renderSheet({ providers: [MAVERO_ROW], title: 'Anime', mediaType: 'tv', tmdbId: '12345', contentId: 'anime-12345', contentType: 'anime', season: 1, episode: 1 });
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
    // DetailPage.svelte left the byte-frozen list in the approved
    // Explorer redesign (mobile hero spacing −18px + "Streaming on" →
    // "Available on" label copy). Its downloader action model stays
    // pinned by §F1c below.
    'src/routes/api/downloader/config/+server.ts',
    'src/lib/server/downloader/admin-service.ts',
    'src/lib/server/downloader/validation.ts',
    'src/lib/server/downloader/types.ts',
  ]) {
    const current = read(frozen);
    const pristine = pristineFile(frozen);
    ok(pristine === null || pristine === current, `§F1: ${frozen} is byte-identical to the pre-CS-5 commit`);
  }

  // §F1c (Explorer redesign): DetailPage.svelte evolved in the approved
  // task (mobile top spacing 150→132px + "Streaming on" → "Available on"
  // label copy). The DOWNLOADER action model it hosts is unchanged —
  // pinned here line-for-line. (MAV-21 Cinematic Detail Page 2.0: the
  // icon size moved 16→17 to match the dominant Play action's 17px icon
  // in the new action hierarchy — the model itself is unchanged.)
  // MAV-24 final polish: the hero Download button became ICON-ONLY (the
  // visible text was removed; the accessible name carries the semantics),
  // so the pinned icon line gained aria-hidden and an 18px glyph for the
  // square 52px target — the downloader action model lines are unchanged.
  const detailPageSrc = read('src/lib/components/DetailPage.svelte');
  for (const pinned of [
    'function openDownloadSheet(',
    'aria-haspopup="dialog" aria-expanded={downloadSheetOpen}',
    'showDownloadButton',
    'showDownloadFailure',
    'class="download-btn download-unavailable"',
    'retryDownloadProviders',
    'downloadProvidersLoading',
    '<Download size={18} aria-hidden="true" />',
    '<DownloadSheet'
  ]) {
    ok(detailPageSrc.includes(pinned), `§F1c: DetailPage keeps the downloader action model line: ${pinned}`);
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
        || line === "    .select('repository_id, internal_name, name, icon_url, enabled');"
        // Phase 3 sanctioned removals: ONLY the Phase 2 binding/select/lookup
        // lines replaced by their generated-map equivalents (type-aware
        // binding call sites gained the optional map argument; the catalog
        // select gained the Phase 3 columns; the row lookup gained the
        // canonical-key alias; the orchestrator call gained the map).
        || line === '    const adapter = executableAdapterForExtension(row);'
        || line === '      const adapter = executableAdapterForExtension(row);'
        || line === '  const adapter = executableAdapterForExtension(row);'
        || line === "    .select('repository_id, internal_name, name, icon_url, enabled, integration_type');"
        || line === '  return { repositories, extensions };'
        || line === "    const rowByKey = new Map(catalog.extensions.map((row) => [row.internal_name.toLowerCase(), row] as const));"
        || line === '      ? await resolveThroughOrchestrator(content, request, resolvable.map(({ adapter }) => adapter.id), deps)'
        || line === '    (candidate) => candidate.internal_name.toLowerCase() === extensionId.trim().toLowerCase(),'
        || line === '  const result = await resolveThroughOrchestrator(content, request, [adapter.id], deps);'
        || line.trim().startsWith('// Phase 2: type-aware binding')
        || line.trim().startsWith('// native adapter) has no executable adapter')
        || line.trim().startsWith('// a native adapter) has no executable adapter')
        // Source-discovery AUDIT sanctioned removals: ONLY the two
        // single-extension row-lookup lines replaced by the deterministic
        // `resolveExtensionRow` call (the unordered raw `find` over the
        // catalog could land on a disabled same-name row from another
        // repository/integration type — the per-tab RETRY collision). The
        // Phase 3 Mode 2 rowByKey.set block removal is covered above via
        // the generic-closure lines (none of its lines appear in the
        // pristine file).
        || line === '  const row = catalog.extensions.find('
        || line === '  if (row === undefined) {';
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
          || line.includes('Phase 3')
          || line.includes('PHASE 3')
          || line.includes('generatedArtifacts')
          || line.includes('generatedAdapters')
          || line.includes('generated_adapter_version')
          || line.includes('buildGeneratedAdapterMap')
          || line.includes('adapterInstances')
          || line.includes('canonicalAdapterKeyForRow')
          || line.includes('selectedInstances')
          || line.includes('rowByKey.set')
          || line.includes('rowByKey = new Map')
          || line.includes('adapter_state')
          || line.includes(': undefined;')
          || line.includes('activeGenerated')
          || line.includes('artifactData')
          || line.includes('artifactError')
          || line.includes('cloudstream_adapter_artifacts')
          || line.includes("canonical_key', keys")
          || line.includes('for (const row of catalog.extensions)')
          || line.includes('candidate.internal_name.toLowerCase() === extensionId.trim().toLowerCase()')
          || line.includes('new Map([[adapter.id.toLowerCase(), adapter]]))')
          || line.includes('canonicalAdapterKeyForRow')
          || line.includes('executableAdapterForExtension')
          || line.includes('seenCanonicalKeys')
          || line.includes('integration_type')
          || line.includes('adapter-registry')
          || line.includes('generated-registry')
          // Phase 5 (Session 13) sanctioned: the ACTIVE-version binding fix
          // in defaultLoadCatalog — the loader now filters artifact rows to
          // the extension row's generated_adapter_version POINTER (rollback
          // = pointer re-version is respected at resolution time; the
          // pre-fix shape bound an arbitrary DB-ordered version). The new
          // identifiers: repoOrder/repoEnabled (the deterministic
          // first-eligible-row-wins derivation), activeVersionByKey (the
          // pointer map), and its keys/filter.
          || line.includes('Phase 5')
          || line.includes('repoOrder')
          || line.includes('repoEnabled')
          || line.includes('activeVersionByKey')
          || line.includes('a.internal_name.localeCompare(b.internal_name)))')
          || line.includes('if (keys.length > 0) {')
          || /^\s*(\/\*\*|\*|\/\/|$)/.test(line)
          || line.includes('{ signal: request.signal }')
          || line.includes('signal?: AbortSignal;')
          || line.includes("...(deps.signal !== undefined ? { signal: deps.signal } : {})")
          // Source-discovery AUDIT sanctioned additions: the deterministic,
          // collision-free row resolution (resolveExtensionRow /
          // buildRequestedRowMap / catalogOrder / rank classes) replacing
          // the raw unordered `find` + last-wins rowByKey map in BOTH the
          // Mode 2 explicit-selection path and the single-extension retry
          // path (the MoviesDrive Admin-Test-vs-Downloader-2 defect class).
          || line.includes('resolveExtensionRow')
          || line.includes('buildRequestedRowMap')
          || line.includes('catalogOrder')
          || line.includes('requestedId')
          || line.includes('orderedRepos')
          || line.includes('a.created_at.localeCompare')
          || line.includes('keysFor')
          || line.includes('ranked')
          || line.includes('rank')
          || line.includes('CloudStreamExtensionSelectionRow')
          || line.includes('row.internal_name.toLowerCase()')
          || line.includes('return map;')
          || line.includes('typeof requestedId')
          || line === '  ];'
          || line === '    .map((row) => {'
          || line === '    })'
          || line === 'import {'
          || line === '  executableAdapterForExtension,'
          || line === '  return [...catalog.extensions].sort((a, b) =>'
          || line === '    || a.internal_name.localeCompare(b.internal_name));'
          || line === 'const ROW_RESOLUTION_RANK = { executableEnabled: 0, executable: 1, enabled: 2, other: 3 } as const;'
          || line === '  if (key.length === 0) return null;'
          || line === '        : executable ? ROW_RESOLUTION_RANK.executable'
          || line === '        : enabled ? ROW_RESOLUTION_RANK.enabled'
          || line === '        : ROW_RESOLUTION_RANK.other;'
          || line === '      if (resolved !== null) map.set(key, resolved);'
          || line === '  if (row === null) {'),
        `§F5: ${csFile} additions are ONLY the Phase 1 cancellation threading + Phase 2/3 registry binding evolution (added ${added.length})`,
      );
    }
  }

  // §F6 the existing deep-link tree is untouched — FINAL TASK evolution:
  // the two +page.svelte leaves now render the UNIFIED panel (deep-link
  // parity with the DownloadSheet); the +page.server.ts files (the adult
  // guards + param validation) remain byte-identical.
  for (const deepServerFile of [
    'src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.server.ts',
    'src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.server.ts',
  ]) {
    const current = read(deepServerFile);
    const pristine = pristineFile(deepServerFile);
    ok(pristine === null || pristine === current, `§F6: ${deepServerFile} is byte-identical (guards/validation unchanged)`);
  }
  for (const deepPageFile of [
    'src/routes/watch/mavero-downloader/movie/[tmdbId]/+page.svelte',
    'src/routes/watch/mavero-downloader/tv/[tmdbId]/[season]/[episode]/+page.svelte',
  ]) {
    const current = read(deepPageFile);
    ok(current.includes('MaveroUnifiedDownload'), `§F6: ${deepPageFile} renders the unified panel (deep-link parity)`);
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
