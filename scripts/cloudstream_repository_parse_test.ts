import assert from 'node:assert/strict';
import {
  parseRepositoryIndex,
  parsePluginList,
  validateRepositoryUrl,
  canonicalRepositoryUrlKey,
  MAX_PLUGIN_LISTS,
  MAX_EXTENSIONS_PER_REPOSITORY,
} from '$lib/server/cloudstream/repository/parse';
import { CloudStreamRepositoryError } from '$lib/server/cloudstream/repository/errors';
import { deriveAdapterStatus, lookupCloudStreamAdapter } from '$lib/server/cloudstream/adapters/registry';

// CS-1: CloudStream repository parser contract tests (plan §40.3).
//
// Scope: CS.json parsing, pluginLists resolution rules, plugins.json parsing,
// metadata normalization bounds, malformed-entry skipping, URL validation,
// canonical duplicate keys, and the adapter-status derivation (code-owned
// registry — EMPTY in CS-1). No test touches the real network: parsing is
// pure structural validation on fixture documents.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function rejectsCode(action: () => Promise<unknown> | unknown, code: string, label: string) {
  try {
    await action();
    assert.fail(`${label}: expected rejection with ${code}`);
  } catch (error) {
    assert.ok(error instanceof CloudStreamRepositoryError, `${label}: expected CloudStreamRepositoryError, got ${String(error)}`);
    assert.equal((error as CloudStreamRepositoryError).code, code, label);
  }
  passed += 1;
}

// ---------------------------------------------------------------------------
// A. validateRepositoryUrl
// ---------------------------------------------------------------------------
{
  ok(validateRepositoryUrl(' https://example.com/CS.json ') === 'https://example.com/CS.json', 'A: trims and accepts an absolute https URL');
  ok(validateRepositoryUrl('http://example.com/cs.json') === 'http://example.com/cs.json', 'A: accepts http');
  rejectsCode(() => validateRepositoryUrl(''), 'INVALID_URL', 'A: empty URL rejected');
  rejectsCode(() => validateRepositoryUrl(null), 'INVALID_URL', 'A: non-string rejected');
  rejectsCode(() => validateRepositoryUrl('ftp://example.com/CS.json'), 'INVALID_URL', 'A: non-http(s) protocol rejected');
  rejectsCode(() => validateRepositoryUrl('https://user:pass@example.com/CS.json'), 'INVALID_URL', 'A: credentials rejected');
  rejectsCode(() => validateRepositoryUrl('https://example.com/CS json'), 'INVALID_URL', 'A: whitespace inside URL rejected');
  rejectsCode(() => validateRepositoryUrl(`https://example.com/${'a'.repeat(2100)}`), 'INVALID_URL', 'A: over-length URL rejected');
  rejectsCode(() => validateRepositoryUrl('not a url'), 'INVALID_URL', 'A: garbage rejected');
}

// ---------------------------------------------------------------------------
// B. canonicalRepositoryUrlKey (duplicate identity)
// ---------------------------------------------------------------------------
{
  ok(
    canonicalRepositoryUrlKey('https://example.com/CS.json') === canonicalRepositoryUrlKey('https://EXAMPLE.com/CS.json'),
    'B: hostname case-insensitive for duplicate identity',
  );
  ok(
    canonicalRepositoryUrlKey('https://example.com:443/CS.json') === canonicalRepositoryUrlKey('https://example.com/CS.json'),
    'B: default port stripped for duplicate identity',
  );
  ok(
    canonicalRepositoryUrlKey('https://example.com/CS.json') === canonicalRepositoryUrlKey('https://example.com/CS.json/'),
    'B: trailing slash collapses to the same canonical form',
  );
  ok(
    canonicalRepositoryUrlKey('https://example.com/CS.json////') === canonicalRepositoryUrlKey('https://example.com/CS.json'),
    'B: multiple trailing slashes collapse',
  );
  ok(
    canonicalRepositoryUrlKey('https://example.com/CS.json?x=1') !== canonicalRepositoryUrlKey('https://example.com/CS.json'),
    'B: query string distinguishes repositories',
  );
}

// ---------------------------------------------------------------------------
// C. parseRepositoryIndex — valid documents (REAL format, AC-002)
// ---------------------------------------------------------------------------
{
  const parsed = parseRepositoryIndex({
    name: 'CSX',
    description: 'A CloudStream repository',
    iconUrl: 'https://example.com/icon.png',
    manifestVersion: 2,
    pluginLists: ['https://example.com/plugins.json'],
  });
  ok(parsed.name === 'CSX', 'C: repository name parsed');
  ok(parsed.description === 'A CloudStream repository', 'C: description parsed');
  ok(parsed.iconUrl === 'https://example.com/icon.png', 'C: iconUrl (canonical field) parsed');
  ok(parsed.pluginLists.length === 1 && parsed.pluginLists[0].url === 'https://example.com/plugins.json', 'C: string plugin-list URL resolved');
}

// ---------------------------------------------------------------------------
// C2. parseRepositoryIndex — legacy tolerated shapes (pre-AC-002)
// ---------------------------------------------------------------------------
{
  const parsed = parseRepositoryIndex({
    name: 'Legacy',
    icon: 'https://example.com/legacy-icon.png',
    pluginLists: [{ name: 'Main', plugins: 'https://example.com/plugins.json' }],
  });
  ok(parsed.pluginLists.length === 1 && parsed.pluginLists[0].url === 'https://example.com/plugins.json', 'C2: legacy { plugins } object form tolerated');
  ok(parsed.iconUrl === 'https://example.com/legacy-icon.png', 'C2: legacy `icon` field tolerated as alias');

  const mixed = parseRepositoryIndex({
    pluginLists: ['https://example.com/a.json', { plugins: 'https://example.com/b.json' }, 42, null],
  });
  ok(
    mixed.pluginLists.length === 2 &&
      mixed.pluginLists[0].url === 'https://example.com/a.json' &&
      mixed.pluginLists[1].url === 'https://example.com/b.json',
    'C2: mixed string/object entries accepted; malformed entries skipped',
  );
}

// ---------------------------------------------------------------------------
// D. parseRepositoryIndex — missing pluginLists is VALID but empty (§40.3)
// ---------------------------------------------------------------------------
{
  const parsed = parseRepositoryIndex({ name: 'Empty' });
  ok(parsed.pluginLists.length === 0, 'D: missing pluginLists → zero lists (NOT an error)');
  ok(parsed.name === 'Empty', 'D: name still parsed');
  const parsedNoDoc = parseRepositoryIndex({});
  ok(parsedNoDoc.pluginLists.length === 0, 'D: empty object → zero lists');
  ok(parsedNoDoc.name === 'Unnamed repository', 'D: fallback name when absent');
}

// ---------------------------------------------------------------------------
// E. parseRepositoryIndex — invalid documents
// ---------------------------------------------------------------------------
{
  rejectsCode(() => parseRepositoryIndex([1, 2, 3]), 'INVALID_REPOSITORY', 'E: array body rejected');
  rejectsCode(() => parseRepositoryIndex('string'), 'INVALID_REPOSITORY', 'E: string body rejected');
  rejectsCode(() => parseRepositoryIndex(null), 'INVALID_REPOSITORY', 'E: null body rejected');
  rejectsCode(() => parseRepositoryIndex({ pluginLists: 'nope' }), 'INVALID_REPOSITORY', 'E: pluginLists non-array rejected');
  rejectsCode(() => parseRepositoryIndex({ pluginLists: [{ plugins: 'relative/path/plugins.json' }] }), 'INVALID_REPOSITORY', 'E: relative plugin-list URL rejected');
  rejectsCode(() => parseRepositoryIndex({ pluginLists: [{ plugins: 'ftp://example.com/plugins.json' }] }), 'INVALID_REPOSITORY', 'E: non-http plugin-list URL rejected');
}

// ---------------------------------------------------------------------------
// F. parseRepositoryIndex — bounds (max 4 plugin lists; malformed entries skipped)
// ---------------------------------------------------------------------------
{
  const manyLists = {
    name: 'Many',
    pluginLists: [0, 1, 2, 3, 4, 5].map((i) => `https://example.com/list-${i}.json`),
  };
  const parsed = parseRepositoryIndex(manyLists);
  ok(parsed.pluginLists.length === MAX_PLUGIN_LISTS, `F: plugin lists bounded to ${MAX_PLUGIN_LISTS} (surplus ignored, not fatal)`);
  ok(parsed.pluginLists[0].url === 'https://example.com/list-0.json', 'F: first lists kept');

  const malformedEntries = parseRepositoryIndex({
    pluginLists: [null, 42, '', '   ', { nope: true }, {}, 'https://example.com/ok.json'],
  });
  ok(malformedEntries.pluginLists.length === 1, 'F: malformed plugin-list entries skipped');
  ok(malformedEntries.pluginLists[0].url === 'https://example.com/ok.json', 'F: well-formed entry kept');

  // A garbage STRING entry is a non-absolute plugin-list URL → the repository
  // is rejected as invalid (plan §40.3: relative/invalid URLs are fatal).
  rejectsCode(() => parseRepositoryIndex({ pluginLists: ['https://ok.example/a.json', 'garbage'] }), 'INVALID_REPOSITORY', 'F: invalid string plugin-list URL rejects the repository');
}

// ---------------------------------------------------------------------------
// G. parsePluginList — valid documents (REAL format, AC-002) + normalization
// ---------------------------------------------------------------------------
{
  const entries = parsePluginList([
    {
      internalName: 'BollyflixProvider',
      name: 'Bollyflix',
      version: 12,
      apiVersion: 1,
      description: 'Provider for Bollyflix',
      authors: ['Author One', 'Author Two'],
      language: 'hi',
      tvTypes: ['TvSeries', 'Movie', 'AsianDrama', 'Anime'],
      status: 1,
      url: 'https://example.com/builds/Bollyflix.cs3',
      iconUrl: 'https://example.com/icons/bollyflix.png',
      fileHash: 'sha256-507b486b195b98903b0cec0fca811c27fdff6cf200f6f94a662c64dd8abe0e59',
      fileSize: 38129,
      repositoryUrl: 'https://github.com/example/CSX',
    },
  ]);
  ok(entries.length === 1, 'G: one entry normalized');
  const entry = entries[0];
  ok(entry.internalName === 'BollyflixProvider', 'G: internalName kept');
  ok(entry.name === 'Bollyflix', 'G: name kept');
  ok(entry.version === 12, 'G: version kept (number)');
  ok(entry.apiVersion === 1, 'G: apiVersion kept');
  ok(entry.authors.length === 2, 'G: authors kept');
  ok(entry.language === 'hi', 'G: language kept');
  ok(entry.tvTypes.length === 4 && entry.tvTypes[0] === 'TvSeries' && entry.tvTypes[1] === 'Movie', 'G: tvTypes kept as enum NAMES');
  ok(entry.pluginStatus === 1, 'G: plugin status kept');
  // .cs3 artifact URL is METADATA ONLY — persisted, never fetched.
  ok(entry.pluginUrl === 'https://example.com/builds/Bollyflix.cs3', 'G: .cs3 `url` persisted as metadata');
  ok(entry.iconUrl === 'https://example.com/icons/bollyflix.png', 'G: iconUrl (canonical field) kept');
  ok(entry.fileHash === 'sha256-507b486b195b98903b0cec0fca811c27fdff6cf200f6f94a662c64dd8abe0e59', 'G: fileHash kept as inert metadata');
  ok(entry.fileSizeBytes === 38129, 'G: fileSize kept as inert metadata');
  ok(entry.sourceUrl === 'https://github.com/example/CSX', 'G: repositoryUrl kept as sourceUrl metadata');

  // Legacy tolerated field names (pre-AC-002): `file` + `icon` + numeric tvTypes.
  const legacy = parsePluginList([
    {
      internalName: 'LegacyProvider',
      tvTypes: [0, 5, 99],
      file: 'https://example.com/builds/Legacy.cs3',
      icon: 'https://example.com/icons/legacy.png',
    },
  ]);
  ok(legacy[0].pluginUrl === 'https://example.com/builds/Legacy.cs3', 'G: legacy `file` field tolerated as artifact alias');
  ok(legacy[0].iconUrl === 'https://example.com/icons/legacy.png', 'G: legacy `icon` field tolerated');
  ok(
    legacy[0].tvTypes.length === 3 && legacy[0].tvTypes[0] === 'Movie' && legacy[0].tvTypes[1] === 'TvSeries' && legacy[0].tvTypes[2] === 'Type99',
    'G: numeric tvTypes normalized to enum names (unknown ordinals fall back to TypeN)',
  );
}

// ---------------------------------------------------------------------------
// H. parsePluginList — malformed entries skipped; document must be an array
// ---------------------------------------------------------------------------
{
  rejectsCode(() => parsePluginList({ not: 'an array' }), 'PLUGIN_LIST_INVALID', 'H: non-array plugin document rejected');
  rejectsCode(() => parsePluginList('nope'), 'PLUGIN_LIST_INVALID', 'H: string plugin document rejected');

  const entries = parsePluginList([
    { name: 'NoInternalName' }, // skipped — no canonical key
    null,
    42,
    'string',
    { internalName: '' }, // skipped — empty
    { internalName: 42 }, // skipped — not a string
    { internalName: 'ValidProvider', name: 'Valid' },
  ]);
  ok(entries.length === 1, 'H: entries without internalName skipped');
  ok(entries[0].internalName === 'ValidProvider', 'H: valid entry kept');
}

// ---------------------------------------------------------------------------
// I. parsePluginList — sanitization (string bounds, numeric coercion, tvTypes)
// ---------------------------------------------------------------------------
{
  const entries = parsePluginList([
    {
      internalName: 'A',
      name: 'x'.repeat(500), // over-length → dropped to null
      description: 'y'.repeat(2000), // over-length → dropped to null
      version: '7', // numeric string → coerced
      tvTypes: ['Movie', 5, true, -1, 2.5, 'nope', '', '   '], // strings kept, safe ints mapped, garbage dropped
      status: 3,
      authors: [123, null, 'Real Author', 'x'.repeat(300)],
      url: 'javascript:alert(1)', // non-http URL → dropped
      iconUrl: 'not a url',
      fileHash: 42, // non-string → dropped
      fileSize: '38129', // numeric string → coerced
      repositoryUrl: 'ftp://example.com/repo', // non-http URL → dropped
    },
  ]);
  const entry = entries[0];
  ok(entry.name === null, 'I: over-length name dropped');
  ok(entry.description === null, 'I: over-length description dropped');
  ok(entry.version === 7, 'I: numeric string version coerced');
  ok(
    entry.tvTypes.length === 3 && entry.tvTypes[0] === 'Movie' && entry.tvTypes[1] === 'TvSeries' && entry.tvTypes[2] === 'nope',
    'I: tvTypes sanitized (strings kept verbatim, numeric ids mapped, booleans/floats/negatives/blank dropped)',
  );
  ok(entry.pluginStatus === 3, 'I: status 3 kept (BROKEN)');
  ok(entry.authors.length === 1 && entry.authors[0] === 'Real Author', 'I: authors sanitized (non-strings/over-length dropped)');
  ok(entry.pluginUrl === null, 'I: non-http(s) artifact URL dropped (metadata is still URL-validated)');
  ok(entry.iconUrl === null, 'I: invalid iconUrl dropped');
  ok(entry.fileHash === null, 'I: non-string fileHash dropped');
  ok(entry.fileSizeBytes === 38129, 'I: numeric string fileSize coerced');
  ok(entry.sourceUrl === null, 'I: non-http(s) repositoryUrl dropped');
}

// ---------------------------------------------------------------------------
// J. parsePluginList — duplicates + bounds
// ---------------------------------------------------------------------------
{
  const duplicated = parsePluginList([
    { internalName: 'SameProvider', name: 'First' },
    { internalName: 'SameProvider', name: 'Second' },
    { internalName: 'sameprovider', name: 'Third (case-insensitive duplicate)' },
    { internalName: 'OtherProvider', name: 'Other' },
  ]);
  ok(duplicated.length === 2, 'J: duplicate internalName entries deduplicated (first wins)');
  ok(duplicated[0].name === 'First', 'J: first occurrence wins');

  const bigList = Array.from({ length: 600 }, (_, i) => ({ internalName: `Provider${i}` }));
  const bounded = parsePluginList(bigList);
  ok(bounded.length === MAX_EXTENSIONS_PER_REPOSITORY, `J: extension records bounded to ${MAX_EXTENSIONS_PER_REPOSITORY}`);

  const manyTvTypes = parsePluginList([{ internalName: 'A', tvTypes: Array.from({ length: 30 }, (_, i) => i) }]);
  ok(manyTvTypes[0].tvTypes.length === 20, 'J: tvTypes bounded to 20');

  const manyAuthors = parsePluginList([{ internalName: 'A', authors: Array.from({ length: 30 }, (_, i) => `Author${i}`) }]);
  ok(manyAuthors[0].authors.length === 20, 'J: authors bounded to 20');
}

// ---------------------------------------------------------------------------
// K. Adapter status derivation (code-owned registry — EMPTY in CS-1)
// ---------------------------------------------------------------------------
{
  ok(lookupCloudStreamAdapter('BollyflixProvider') === null, 'K: CS-1 registry is intentionally empty');
  ok(deriveAdapterStatus('BollyflixProvider', null) === 'adapter_required', 'K: no adapter → adapter_required');
  ok(deriveAdapterStatus('BollyflixProvider', 1) === 'adapter_required', 'K: plugin OK + no adapter → adapter_required');
  ok(deriveAdapterStatus('BollyflixProvider', 2) === 'unsupported', 'K: plugin DOWN → unsupported');
  ok(deriveAdapterStatus('BollyflixProvider', 3) === 'broken', 'K: plugin BROKEN → broken (takes precedence)');
  // Discovery NEVER implies runtime compatibility (plan §18).
}

console.log(`cloudstream_repository_parse_test: ${passed} checks passed`);
