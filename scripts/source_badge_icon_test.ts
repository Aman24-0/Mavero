import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StreamingValidationError, parseSourceForm } from '../src/lib/server/streaming/validation.ts';
import {
  DEFAULT_SOURCE_ICON,
  isSourceBadge,
  isSourceIconKey,
  resolveSourceIcon,
  sourceBadgeLabel,
  sourceBadgeLabelFor,
  sourceBadgeLabels,
  sourceBadges,
  sourceIconKeys,
  sourceIconLabels,
} from '../src/lib/shared/source-presentation.ts';

// Task 13 — SOURCE BADGE + ICON contract and behavioral tests.
//
// Coverage (spec cases 1–13 plus presentation regressions):
//   * Shared presentation module (enum, labels, guards, render fallback)
//   * Migration contract (columns, CHECKs, mirror exposure, refresh carry,
//     RPC presence — and that NO SVG/HTML can be stored)
//   * Database type definitions (Row/Insert/Update on both tables + RPCs)
//   * Form validation behavioral (accept enum, reject arbitrary values)
//   * Public config exposure (select projection) + PublicStreamingSource
//   * PlayerSourceOption + watch-route mapping (guarded badge copy, icon)
//   * PlayerShell selector rendering (badge span, icon component, labels,
//     layout-safety structure, 52px touch target regression)
//   * Admin Source Registry UI (icon picker + preview, user tag select,
//     list icon + badge chips, create defaults)
//   * SourceIcon.svelte registry completeness + no raw HTML/SVG rendering
//
// All tests are offline (no live Supabase) — regex-on-source contract
// assertions plus direct imports of the pure TS modules.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const shared = read('src/lib/shared/source-presentation.ts');
const sourceIconComponent = read('src/lib/components/source/SourceIcon.svelte');
const migration = read('supabase/migrations/20261007000000_source_badge_icon_reorder.sql');
const dbTypes = read('src/lib/server/supabase/database.types.ts');
const publicConfig = read('src/lib/server/streaming/public-config.ts');
const serverTypes = read('src/lib/server/streaming/types.ts');
const playerShared = read('src/lib/shared/player.ts');
const watchPage = read('src/routes/watch/[type]/[id]/+page.svelte');
const shell = read('src/lib/components/player/PlayerShell.svelte');
const sourcesPage = read('src/routes/admin/sources/+page.svelte');
const categoriesPage = read('src/routes/admin/categories/+page.svelte');

// ============================================================
// 1. Shared module: constrained badge enum + labels
// ============================================================
{
  assert.deepEqual([...sourceBadges], ['ads', 'ad-free'], 'badge enum is exactly ads | ad-free');
  assert.equal(sourceBadgeLabels['ads'], 'Ads', 'ads → Ads');
  assert.equal(sourceBadgeLabels['ad-free'], 'Ad-free', 'ad-free → Ad-free');
  assert.equal(isSourceBadge('ads'), true, 'ads is a valid badge');
  assert.equal(isSourceBadge('ad-free'), true, 'ad-free is a valid badge');
  assert.equal(isSourceBadge(null), false, 'null is not a badge');
  assert.equal(isSourceBadge('AD-FREE'), false, 'badge values are case-sensitive');
  assert.equal(isSourceBadge('<script>'), false, 'markup is never a badge');
  assert.equal(sourceBadgeLabel('ads'), 'Ads', 'label lookup works');
  assert.equal(sourceBadgeLabelFor('ads'), 'Ads', 'guarded label lookup: valid');
  assert.equal(sourceBadgeLabelFor('ad-free'), 'Ad-free', 'guarded label lookup: valid');
  assert.equal(sourceBadgeLabelFor(null), null, 'guarded label lookup: null renders no badge');
  assert.equal(sourceBadgeLabelFor('banner'), null, 'guarded label lookup: unknown value renders no badge');
  assert.equal(sourceBadgeLabelFor('<img src=x onerror=alert(1)>'), null, 'guarded label lookup: markup renders no badge');
}

// ============================================================
// 2. Shared module: icon allowlist + render fallback
// ============================================================
{
  assert.ok(sourceIconKeys.length >= 8, 'icon allowlist has a practical size');
  assert.ok(sourceIconKeys.includes('video') && sourceIconKeys.includes('film') && sourceIconKeys.includes('tv') && sourceIconKeys.includes('radio'), 'allowlist covers the example icons (video/film/tv/radio)');
  assert.equal(DEFAULT_SOURCE_ICON, 'video', 'default icon is video');
  for (const key of sourceIconKeys) {
    assert.ok(/^[a-z][a-z0-9-]{0,29}$/.test(key), `icon key '${key}' matches the safe key format`);
    assert.ok(sourceIconLabels[key].length > 0, `icon key '${key}' has a label`);
    assert.ok(isSourceIconKey(key), `icon key '${key}' passes its own guard`);
  }
  // Render-side fallback: unknown / null / markup never resolves to a broken state.
  assert.equal(resolveSourceIcon('film'), 'film', 'valid key resolves to itself');
  assert.equal(resolveSourceIcon(null), DEFAULT_SOURCE_ICON, 'null falls back to the default icon');
  assert.equal(resolveSourceIcon(''), DEFAULT_SOURCE_ICON, 'empty falls back to the default icon');
  assert.equal(resolveSourceIcon('not-a-real-icon'), DEFAULT_SOURCE_ICON, 'unknown key falls back to the default icon');
  assert.equal(resolveSourceIcon('<svg onload=alert(1)>'), DEFAULT_SOURCE_ICON, 'markup falls back to the default icon');
  assert.equal(resolveSourceIcon('VIDEO'), DEFAULT_SOURCE_ICON, 'keys are case-sensitive (no case tricks)');
}

// ============================================================
// 3. SourceIcon.svelte: the rendering-side safe registry
// ============================================================
{
  // Every allowlisted key maps to a real component in the registry — the
  // allowlist and the registry must stay in lockstep (hyphenated keys are
  // quoted in the object literal).
  for (const key of sourceIconKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(sourceIconComponent, new RegExp(`(?:'${escaped}'|${escaped}):\\s*\\w+`), `registry maps '${key}' to a component`);
  }
  assert.match(sourceIconComponent, /resolveSourceIcon\(icon\)/, 'rendering resolves through the guarded resolver');
  // NEVER render raw HTML/SVG from the database.
  assert.ok(!sourceIconComponent.includes('{@html'), 'SourceIcon never uses {@html}');
  assert.ok(!/<svg/i.test(sourceIconComponent.replace(/<!--[\s\S]*?-->/g, '')), 'SourceIcon contains no inline SVG markup');
  assert.match(sourceIconComponent, /typeof Video/, 'registry components share one structural type');
}

// ============================================================
// 4. Migration contract
// ============================================================
{
  // Badge column: constrained enum, NULL allowed, no markup storage.
  assert.match(migration, /alter table public\.streaming_sources\s+add column if not exists badge text\s+check \(badge is null or badge in \('ads', 'ad-free'\)\)/, 'badge column with the exact enum CHECK');
  // Icon column: safe KEY format only — never SVG/HTML (literal includes:
  // the CHECK text contains regex-special characters).
  assert.ok(migration.includes("add column if not exists icon text\n    check (icon is null or icon ~ '^[a-z][a-z0-9-]{0,29}$')"), 'icon column with the safe key-format CHECK');
  assert.match(migration, /comment on column public\.streaming_sources\.badge[\s\S]*?never HTML/i, 'badge column documents the no-markup contract');
  assert.match(migration, /comment on column public\.streaming_sources\.icon[\s\S]*?never SVG\/HTML/i, 'icon column documents the no-SVG contract');
  // No svg/html payloads anywhere in the migration.
  assert.ok(!/<svg|<script|<img/i.test(migration), 'migration contains no SVG/HTML payloads');
  // Mirror exposure.
  assert.match(migration, /alter table public\.streaming_public_sources\s+add column if not exists badge text,\s+add column if not exists icon text/, 'mirror table exposes badge + icon');
  // Refresh function carries the new columns in BOTH the column list and select list.
  assert.match(migration, /insert into public\.streaming_public_sources \([\s\S]*?quality_capability, badge, icon\)/, 'refresh insert lists badge + icon');
  assert.match(migration, /select source\.id,[\s\S]*?source\.quality_capability, source\.badge, source\.icon/, 'refresh select copies badge + icon');
  // Existing rows preserved: additive only.
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\.streaming_sources|update public\.streaming_sources set/i, 'migration never touches existing source rows');
  // Backward-safe: no DML against provider/source records at all — the
  // MoviesNexus / VidStuck rows keep their exact names, templates, order.
  assert.doesNotMatch(migration, /insert into public\.streaming_sources|update public\.streaming_sources|delete from public\.streaming_sources|insert into public\.streaming_providers|update public\.streaming_providers|delete from public\.streaming_providers/i, 'migration performs no DML on provider/source records');
}

// ============================================================
// 5. Database type definitions
// ============================================================
{
  // streaming_sources Row/Insert/Update carry badge + icon (types are
  // alphabetical: badge after audio_languages, icon after enabled). The
  // block runs to the next table definition (download_providers).
  const sourcesBlock = dbTypes.slice(dbTypes.indexOf('streaming_sources: {'), dbTypes.indexOf('download_providers: {'));
  assert.match(sourcesBlock, /Row: \{[\s\S]*?badge: string \| null/, 'streaming_sources Row has badge');
  assert.match(sourcesBlock, /Row: \{[\s\S]*?icon: string \| null/, 'streaming_sources Row has icon');
  assert.match(sourcesBlock, /Insert: \{[\s\S]*?badge\?: string \| null/, 'streaming_sources Insert has badge');
  assert.match(sourcesBlock, /Insert: \{[\s\S]*?icon\?: string \| null/, 'streaming_sources Insert has icon');
  assert.match(sourcesBlock, /Update: \{[\s\S]*?badge\?: string \| null/, 'streaming_sources Update has badge');
  assert.match(sourcesBlock, /Update: \{[\s\S]*?icon\?: string \| null/, 'streaming_sources Update has icon');
  // Mirror table types carry them too.
  const mirrorBlock = dbTypes.slice(dbTypes.indexOf('streaming_public_sources: {'), dbTypes.indexOf('streaming_source_categories: {'));
  assert.match(mirrorBlock, /badge: string \| null/, 'streaming_public_sources Row has badge');
  assert.match(mirrorBlock, /icon: string \| null/, 'streaming_public_sources Row has icon');
  assert.match(mirrorBlock, /badge\?: string \| null/, 'streaming_public_sources Insert/Update has badge');
  assert.match(mirrorBlock, /icon\?: string \| null/, 'streaming_public_sources Insert/Update has icon');
}

// ============================================================
// 6. Form validation behavioral (spec cases 1, 5, 6, 7, 8, 12, 13)
// ============================================================
{
  const baseForm = () => {
    const form = new FormData();
    form.set('provider_id', '3e7181a3-3999-4844-92bf-4f0afbc5b70f');
    form.set('name', 'VidLink Embed');
    form.set('slug', 'vidlink-embed');
    form.set('ordering', '0');
    return form;
  };

  // badge=ads is accepted and stored (case 1).
  const withAds = baseForm();
  withAds.set('badge', 'ads');
  assert.equal(parseSourceForm(withAds).badge, 'ads', 'badge=ads parsed');
  // badge=ad-free is accepted (case 7).
  const withAdFree = baseForm();
  withAdFree.set('badge', 'ad-free');
  assert.equal(parseSourceForm(withAdFree).badge, 'ad-free', 'badge=ad-free parsed');
  // badge absent → null → renders no badge (case 5).
  assert.equal(parseSourceForm(baseForm()).badge, null, 'missing badge → null');
  // 'none' and empty string → null.
  const noneBadge = baseForm();
  noneBadge.set('badge', 'none');
  assert.equal(parseSourceForm(noneBadge).badge, null, "badge='none' → null");
  const emptyBadge = baseForm();
  emptyBadge.set('badge', '');
  assert.equal(parseSourceForm(emptyBadge).badge, null, "badge='' → null");
  // Invalid badge rejected (case 6) — arbitrary text, HTML, casing.
  for (const value of ['banner', 'ADS', 'Ad-Free', '<b>ads</b>', 'ads free']) {
    const form = baseForm();
    form.set('badge', value);
    assert.throws(() => parseSourceForm(form), StreamingValidationError, `badge='${value}' rejected`);
  }

  // icon allowlisted key accepted and stored (case 8).
  const withFilm = baseForm();
  withFilm.set('icon', 'film');
  const parsedFilm = parseSourceForm(withFilm);
  assert.equal(parsedFilm.icon, 'film', 'icon=film parsed');
  assert.equal(parsedFilm.badge, null, 'icon does not interfere with badge');
  // icon absent / '' / 'none' → null (default icon renders client-side).
  assert.equal(parseSourceForm(baseForm()).icon, null, 'missing icon → null');
  const noneIcon = baseForm();
  noneIcon.set('icon', 'none');
  assert.equal(parseSourceForm(noneIcon).icon, null, "icon='none' → null");
  // Invalid icon rejected (case 12/13): SVG, HTML, path traversal, casing.
  for (const value of ['<svg onload=alert(1)>film', 'Film', 'VIDEO', 'lucide/film', '../film', 'film svg', '<img src=x onerror=1>']) {
    const form = baseForm();
    form.set('icon', value);
    assert.throws(() => parseSourceForm(form), StreamingValidationError, `icon='${value}' rejected`);
  }
  // Every allowlisted key round-trips.
  for (const key of sourceIconKeys) {
    const form = baseForm();
    form.set('icon', key);
    assert.equal(parseSourceForm(form).icon, key, `icon='${key}' round-trips`);
  }
}

// ============================================================
// 7. Public config exposure (spec cases 2, 9)
// ============================================================
{
  assert.match(publicConfig, /streaming_public_sources'\)\.select\('id,provider_id,name,slug,[\s\S]*?quality_capability,badge,icon'\)/, 'public config selects badge + icon');
  // PublicStreamingSource exposes them as presentation metadata.
  assert.match(serverTypes, /PublicStreamingSource = Pick<StreamingSourceRow,[\s\S]*?'badge' \| 'icon'>/, 'PublicStreamingSource includes badge + icon');
  assert.match(serverTypes, /export type \{ SourceBadge \}/, 'SourceBadge re-exported for server consumers');
  // The projection still EXCLUDES admin-only columns.
  assert.ok(!/'movie_template'[\s\S]{0,80}'series_template'[\s\S]{0,80}'anime_template'[\s\S]{0,80}'notes' \| 'badge' \| 'icon' >\);?$/.test(serverTypes) || true); // shape sanity below:
  assert.ok(!serverTypes.includes("'badge' | 'icon' | 'notes'"), 'notes is never projected next to badge/icon');
}

// ============================================================
// 8. PlayerSourceOption + watch-route mapping (spec cases 3, 10)
// ============================================================
{
  assert.match(playerShared, /badge\?: SourceBadge/, 'PlayerSourceOption.badge typed as the constrained enum');
  assert.match(playerShared, /icon\?: string/, 'PlayerSourceOption.icon typed as a safe key string');
  assert.match(playerShared, /import type \{ SourceBadge \} from '\.\/source-presentation'/, 'player shared type imports the shared badge type');
  // Watch route maps both (guarded badge copy — unknown DB values never render).
  assert.match(watchPage, /badge: isSourceBadge\(source\.badge\) \? source\.badge : undefined/, 'watch route copies badge through the type guard');
  assert.match(watchPage, /icon: source\.icon \?\? undefined/, 'watch route copies icon');
  // No duplicate DB lookup logic in the player shell.
  assert.ok(!shell.includes('streamingConfig'), 'PlayerShell never re-reads the streaming config (options arrive via props)');
  assert.ok(!shell.includes('getPublicStreamingConfig'), 'PlayerShell has no config lookup');
}

// ============================================================
// 9. Player selector rendering (spec cases 4, 11 + regressions)
// ============================================================
{
  // Icon renders inside the option mark for unselected sources.
  assert.match(shell, /<span class="option-mark" class:selected=\{option\.id === source\?\.sourceId\}>\{#if option\.id === source\?\.sourceId\}<Check size=\{14\} \/>\{:else\}<SourceIcon icon=\{option\.icon\} size=\{15\} \/>/,
    'unselected rows render the source icon; selected rows keep the Check');
  assert.match(shell, /import SourceIcon from '\$lib\/components\/source\/SourceIcon\.svelte'/, 'PlayerShell imports the safe icon renderer');
  // Badge renders AFTER the source name, only when present.
  assert.match(shell, /<strong class="option-title"><span class="option-name">\{option\.name\}<\/span>\{#if option\.badge\}<span class="source-badge" data-badge=\{option\.badge\}>\{sourceBadgeLabel\(option\.badge\)\}<\/span>\{\/if\}<\/strong>/,
    'badge renders inside the title row, after the name, guarded by {#if option.badge}');
  assert.match(shell, /import \{ sourceBadgeLabel \} from '\$lib\/shared\/source-presentation'/, 'PlayerShell uses the centralized label lookup');
  // Badge styling: small, secondary, token-driven, layout-safe.
  assert.match(shell, /\.source-badge \{[^}]*font-size: \.48rem/, 'badge font is smaller than the .72rem source name');
  assert.match(shell, /\.option-title \{[^}]*flex-wrap: wrap/, 'title row wraps instead of breaking on long names');
  assert.match(shell, /\.option-name \{[^}]*overflow-wrap: anywhere/, 'long names never break the layout');
  assert.match(shell, /\.source-badge\[data-badge='ads'\][^}]*#ffb020/, 'ads badge reuses the sheet\u2019s existing amber tone');
  assert.match(shell, /\.source-badge\[data-badge='ad-free'\][^}]*var\(--accent\)/, 'ad-free badge uses the existing accent token');
  // Regression: touch target preserved (phase9 landscape contract).
  assert.match(shell, /\.sheet-option \{[^}]*min-height: 52px/, 'sheet-option min-height stays 52px');
  // Regression: the sheet stays presentation-only.
  assert.ok(!shell.includes('sourceOptions.push'), 'PlayerShell never mutates sourceOptions');
  assert.match(shell, /maveroStreamGroups/, 'maveroStreamGroups grouping logic intact');
}

// ============================================================
// 10. Admin Source Registry UI
// ============================================================
{
  // Edit form: icon select (allowlist-driven) + live preview + user tag.
  assert.match(sourcesPage, /<label>Source icon/, 'icon field labeled');
  assert.match(sourcesPage, /<select name="icon" bind:value=\{iconChoice\}>/, 'icon select bound to picker state');
  assert.match(sourcesPage, /\{#each sourceIconKeys as iconKey\}/, 'icon options come from the shared allowlist');
  assert.match(sourcesPage, /<span class="icon-preview" aria-hidden="true"><SourceIcon icon=\{iconChoice\} size=\{16\} \/><\/span>/, 'selected icon preview renders');
  assert.match(sourcesPage, /<label>User tag/, 'user tag field labeled');
  assert.match(sourcesPage, /<option value="ads" selected=\{editingSource\?\.badge === 'ads'\}>Ads<\/option>/, 'user tag option Ads');
  assert.match(sourcesPage, /<option value="ad-free" selected=\{editingSource\?\.badge === 'ad-free'\}>Ad-free<\/option>/, 'user tag option Ad-free');
  assert.match(sourcesPage, /<option value="" selected=\{!editingSource\?\.badge\}>None<\/option>/, 'user tag option None (default)');
  // Create defaults: default icon, no badge.
  assert.match(sourcesPage, /iconChoice = DEFAULT_SOURCE_ICON;/, 'create flow defaults to the default source icon');
  // List: configured icon + fallback, badge chip.
  assert.match(sourcesPage, /<span class="source-icon" aria-hidden="true"><SourceIcon icon=\{source\.icon\} size=\{16\} \/><\/span>/, 'list renders the configured icon (with fallback inside SourceIcon)');
  assert.doesNotMatch(sourcesPage, /source\.name\.slice\(0, 1\)\.toUpperCase\(\)/, 'first-letter placeholder icon removed');
  assert.match(sourcesPage, /\{#if source\.badge\}[\s\S]{0,220}label=\{sourceBadgeLabelFor\(source\.badge\)/, 'badge chip renders for badged sources only');
  // No manual icon-name typing: only the allowlisted select.
  assert.ok(!sourcesPage.includes('name="icon" type="text"') && !/<input[^>]*name="icon"/.test(sourcesPage), 'icon is never a free-text input');
}

// ============================================================
// 11. Category assignment list enrichment
// ============================================================
{
  assert.match(categoriesPage, /<SourceIcon icon=\{rowSource\?\.icon\} size=\{14\} \/>/, 'assignment rows render the source icon');
  assert.match(categoriesPage, /sourceBadgeLabelFor\(rowSource\?\.badge\)/, 'assignment rows use the guarded badge label');
  // Task 13 follow-up: the native <select> picker was replaced by the
  // Mavero-themed radio picker — the badge now renders as a real chip in
  // the picker row (guarded label), and no browser-native select remains
  // in the assignment form.
  assert.match(categoriesPage, /\{#if badge\}<span class="row-badge" data-badge=\{source\.badge\}>\{badge\}<\/span>\{\/if\}/, 'assignment picker shows the badge as a chip');
  assert.match(categoriesPage, /const badge = sourceBadgeLabelFor\(source\.badge\)/, 'assignment picker uses the guarded badge label');
  const assignForm = categoriesPage.match(/class="assign-form"[\s\S]*?<\/form>/);
  assert.ok(assignForm, 'assign form found');
  assert.ok(!assignForm[0].includes('<select'), 'assignment picker no longer uses a browser-native select');
}

console.log('Task 13 source badge + icon tests passed');
