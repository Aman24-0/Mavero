import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import {
  escapeJsonForScript,
  serializeJsonLd,
  jsonLdScriptElement,
} from '../src/lib/shared/json-ld';
import type { MediaItem } from '../src/lib/data/content';

// ============================================================================
// JSON-LD SSR regression suite (Google Search Console fix, 2026-10).
//
// GSC REPORT: "Unparsable structured data — Parsing error: Missing '}' or
// object member name" on https://maveroweb.space/tv-show/4614?from=%2F.
//
// ROOT CAUSE: Svelte treats the CONTENTS of <script> elements in a template
// as RAW TEXT — neither `{expr}` nor `{@html expr}` interpolates inside
// them — so DetailPage.svelte's
//   <script type="application/ld+json">{structuredData}</script>
// emitted the LITERAL placeholder `{structuredData}` in the SSR HTML
// (JSON.parse fails at position 1 — the exact GSC error). Plain Svelte
// interpolation is also wrong here: it HTML-escapes the JSON ("&quot;"),
// which corrupts it for crawlers.
//
// FIX: the block is injected as RAW JSON through `{@html}` (whole script
// element), with every `<` escaped to the JSON unicode escape \u003c —
// identical after JSON.parse, and incapable of forming the `</script` or
// `<!--` sequence that would terminate the element early.
//
// This suite has two layers:
//   §A  Unit: the shared serializer (src/lib/shared/json-ld.ts) against
//       adversarial payloads — quotes, newlines, ampersands, markup-like
//       text, a literal `</script>` sequence, HTML-comment openers,
//       backslashes and U+2028/U+2029 separators.
//   §B  REAL SSR: the actual DetailPage.svelte (full component graph) is
//       server-rendered through a Vite SSR build for three fixtures —
//       the affected /tv-show/4614 shape, a movie detail route, and a
//       second TV-series route carrying the adversarial payload. Every
//       application/ld+json block in the generated head HTML is extracted
//       and JSON.parse'd, mirroring exactly what Googlebot consumes.
// ============================================================================

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Non-greedy extraction of a COMPLETE block. A block that terminates early
// (raw `</script` inside the payload) fails §B's parse assertions.
const LD_BLOCK_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function extractLdBlocks(html: string): string[] {
  return [...html.matchAll(LD_BLOCK_RE)].map((m) => m[1]);
}

// No HTML entity may appear inside a JSON-LD block: crawlers parse the raw
// characters, and entity-escaped JSON ("&quot;") is invalid JSON.
const HTML_ENTITY_RE = /&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-fA-F]+);/;

function assertValidLdBlock(block: string, label: string): Record<string, unknown> {
  assert.doesNotMatch(block, HTML_ENTITY_RE, `${label}: JSON-LD must not be HTML-entity-escaped`);
  assert.doesNotMatch(block, /</, `${label}: JSON-LD must contain no raw "<" (script-breaker)`);
  const parsed = JSON.parse(block) as Record<string, unknown>; // throws ⇒ test failure
  assert.equal(parsed['@context'], 'https://schema.org', `${label}: @context preserved`);
  return parsed;
}

// ============================================================
// §A — Unit: shared serializer (adversarial payloads)
// ============================================================
console.log('\n§A. Safe JSON-LD serializer (unit)');

const ADVERSARIAL_TEXT = [
  'double "quotes" and \'single quotes\'',
  'ampersand & ampersand',
  'newline\nafter a line break',
  'markup-like <b>bold</b> and <em>italic</em>',
  'script-breaker: </script> sequence',
  'comment opener: <!-- not a comment',
  'backslash \\ and \\" escaped quote',
  'unicode: café, 日本語, emoji 🎬',
  'line separators: \u2028 and \u2029',
].join('\n');

// 1. Every "<" becomes the JSON escape \u003c.
assert.equal(escapeJsonForScript('<a>'), '\\u003ca>', 'escape: < → \\u003c, > untouched');
ok('escape: < → \\u003c, > untouched');

// 2. U+2028/U+2029 are escaped to their JSON form.
assert.equal(escapeJsonForScript('x\u2028y\u2029z'), 'x\\u2028y\\u2029z', 'escape: U+2028/U+2029');
ok('escape: U+2028/U+2029 line separators escaped');

// 3. Adversarial payload round-trips EXACTLY (no truncation, no rewriting).
const adversarialObj = {
  '@context': 'https://schema.org',
  '@type': 'TVSeries',
  name: `The "Quote" & <em>Tag</em> Show`,
  description: ADVERSARIAL_TEXT,
};
const adversarialJson = serializeJsonLd(adversarialObj);
const adversarialRoundTrip = JSON.parse(adversarialJson) as Record<string, unknown>;
assert.equal(adversarialRoundTrip.name, adversarialObj.name, 'round-trip: name byte-identical');
assert.equal(adversarialRoundTrip.description, adversarialObj.description, 'round-trip: description byte-identical');
ok('adversarial payload round-trips byte-identical through JSON.parse');

// 4. The serialized block can never terminate the script element early.
assert.doesNotMatch(adversarialJson, /<\/script/i, 'serialized: no raw </script sequence');
assert.doesNotMatch(adversarialJson, /<!--/, 'serialized: no raw <!-- sequence');
assert.doesNotMatch(adversarialJson, /</, 'serialized: no raw < at all');
ok('serialized output contains no </script, <!-- or any raw <');

// 5. No HTML entities leak into the JSON (the historical "&quot;" hazard).
assert.doesNotMatch(adversarialJson, HTML_ENTITY_RE, 'serialized: no HTML entities');
ok('serialized output contains no &quot;/&amp;/&lt; HTML entities');

// 6. jsonLdScriptElement wraps the JSON in exactly one complete block.
const wrapped = jsonLdScriptElement(adversarialJson);
const wrappedBlocks = extractLdBlocks(wrapped);
assert.equal(wrappedBlocks.length, 1, 'wrapper: exactly one ld+json block');
const wrappedParsed = assertValidLdBlock(wrappedBlocks[0], 'wrapper');
assert.equal(wrappedParsed.name, adversarialObj.name, 'wrapper: name preserved');
ok('jsonLdScriptElement emits one complete parseable block');

// ============================================================
// §B — REAL SSR: the actual DetailPage.svelte component graph
// ============================================================
console.log('\n§B. Real SSR renders (Vite SSR build of DetailPage.svelte)');

const BASE_ITEM = {
  year: 2003,
  runtime: '45m',
  rating: 8.4,
  genres: ['Drama', 'Crime'],
  poster: 'https://image.tmdb.org/t/p/w500/ncis-poster.jpg',
  backdrop: 'https://image.tmdb.org/t/p/w1280/ncis-backdrop.jpg',
  accent: '#1f2937',
};

// Fixture 1 — the exact affected route shape: /tv-show/4614 (NCIS).
const tvShow4614: MediaItem = {
  id: '4614',
  type: 'series',
  title: 'NCIS',
  description:
    'From murder and espionage to terrorism and stolen submarines, a team of special agents investigates any crime that has any connection to Navy and Marine Corps personnel, regardless of rank or position.',
  voteCount: 1423,
  ...BASE_ITEM,
};

// Fixture 2 — a movie detail route (canonical /movie/27205).
const movie27205: MediaItem = {
  id: '27205',
  type: 'movie',
  title: 'Inception',
  description: 'Cobb, a skilled thief who steals corporate secrets through dream-sharing technology.',
  voteCount: 34567,
  ...BASE_ITEM,
  runtime: '148m',
  year: 2010,
};

// Fixture 3 — a second TV-series route carrying the ADVERSARIAL payload
// (quotes, newlines, ampersands, markup-like text, a literal </script>
// sequence and an HTML-comment opener) AND a zero/absent vote count so the
// no-aggregateRating branch of the real rating-count logic is exercised.
const adversarialSeries: MediaItem = {
  id: '999999',
  type: 'series',
  title: 'The "Quote" & <em>Tag</em> Show',
  description: ADVERSARIAL_TEXT,
  voteCount: 0,
  ...BASE_ITEM,
};

// ---- Harness scaffolding (temp dir, cleaned up below) ----
const harnessDir = mkdtempSync(path.join(tmpdir(), 'mavero-jsonld-ssr-'));
const appStateShim = path.join(harnessDir, 'app-state-shim.mjs');
writeFileSync(
  appStateShim,
  `// Test shim for SvelteKit's $app/state virtual module: the harness renders
// DetailPage.svelte outside SvelteKit, so "page" is a plain object carrying
// the affected production URL shape.
export const page = {
  url: new URL('https://maveroweb.space/tv-show/4614?from=%2F'),
  params: {},
  data: {},
  route: { id: null },
  status: 200,
  error: null,
  form: null,
  state: {},
};
export const navigating = { from: null, to: null, type: undefined };
export const updated = { check: () => Promise.resolve(false) };
`,
);
const entryFile = path.join(harnessDir, 'ssr-entry.mjs');
writeFileSync(
  entryFile,
  `import { render } from 'svelte/server';
import DetailPage from '${path.join(REPO_ROOT, 'src/lib/components/DetailPage.svelte')}';

export function renderFixture(props) {
  const { head } = render(DetailPage, { props });
  return head;
}
`,
);

const outDir = path.join(harnessDir, 'out');
const alias = (find: string, replacement: string) => ({ find, replacement });

try {
  await build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'warn',
    plugins: [svelte()],
    resolve: {
      alias: [
        alias('$app/state', appStateShim),
        alias('$app/navigation', path.join(REPO_ROOT, 'scripts/env-stubs/app-navigation.ts')),
        alias('$app/environment', path.join(REPO_ROOT, 'scripts/env-stubs/app-environment.ts')),
        alias('$app/forms', path.join(REPO_ROOT, 'scripts/env-stubs/app-forms.ts')),
        alias('$env/dynamic/private', path.join(REPO_ROOT, 'scripts/env-stubs/dynamic-private.ts')),
        alias('$env/dynamic/public', path.join(REPO_ROOT, 'scripts/env-stubs/dynamic-public.ts')),
        alias('$components', path.join(REPO_ROOT, 'src/lib/components')),
        alias('$components/', path.join(REPO_ROOT, 'src/lib/components/')),
        alias('$data/', path.join(REPO_ROOT, 'src/lib/data/')),
        alias('$data', path.join(REPO_ROOT, 'src/lib/data')),
        alias('$lib/', path.join(REPO_ROOT, 'src/lib/')),
        alias('$lib', path.join(REPO_ROOT, 'src/lib')),
        alias('$styles/', path.join(REPO_ROOT, 'src/lib/styles/')),
        alias('$styles', path.join(REPO_ROOT, 'src/lib/styles')),
      ],
    },
    ssr: { noExternal: ['lucide-svelte'] },
    build: {
      ssr: entryFile,
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'bundle.mjs' } },
    },
  });

  const bundlePath = path.join(outDir, 'bundle.mjs');
  assert.ok(existsSync(bundlePath), 'SSR harness bundle was produced');
  ok('real DetailPage.svelte component graph compiled (Vite SSR build)');

  const { renderFixture } = (await import(pathToFileURL(bundlePath).href)) as {
    renderFixture: (props: { id: string; type: string; dataItem: MediaItem }) => string;
  };

  // Canonical head contract: the fixed production origin + the public
  // route-type path (unchanged by this fix).
  const canonicalFor = (props: { id: string; type: string; dataItem: MediaItem }) => {
    const routeType = props.type === 'movie' ? 'movie' : 'tv-show';
    return `https://maveroweb.space/${routeType}/${props.id}`;
  };

  const fixtures: Array<{
    label: string;
    props: { id: string; type: string; dataItem: MediaItem };
    expectedType: 'TVSeries' | 'Movie';
    expectAggregate: boolean;
  }> = [
    { label: 'tv-show/4614 (affected route)', props: { id: '4614', type: 'series', dataItem: tvShow4614 }, expectedType: 'TVSeries', expectAggregate: true },
    { label: 'movie/27205', props: { id: '27205', type: 'movie', dataItem: movie27205 }, expectedType: 'Movie', expectAggregate: true },
    { label: 'adversarial tv-show/999999', props: { id: '999999', type: 'series', dataItem: adversarialSeries }, expectedType: 'TVSeries', expectAggregate: false },
  ];

  for (const fixture of fixtures) {
    console.log(`\n  -- ${fixture.label} --`);
    const head = renderFixture(fixture.props);
    assert.ok(head.length > 0, `${fixture.label}: head rendered`);
    assert.ok(head.includes(`<link rel="canonical" href="${canonicalFor(fixture.props)}"`),
      `${fixture.label}: canonical URL preserved`);
    ok(`canonical URL preserved (${canonicalFor(fixture.props)})`);

    const blocks = extractLdBlocks(head);
    assert.equal(blocks.length, 1, `${fixture.label}: exactly one application/ld+json block`);
    ok('exactly one application/ld+json block in the SSR head');

    const parsed = assertValidLdBlock(blocks[0], fixture.label);
    assert.equal(parsed['@type'], fixture.expectedType, `${fixture.label}: @type correct`);
    assert.equal(parsed.name, fixture.props.dataItem.title, `${fixture.label}: name byte-identical`);
    assert.equal(parsed.description, fixture.props.dataItem.description, `${fixture.label}: description byte-identical`);
    assert.equal(parsed.image, fixture.props.dataItem.backdrop || fixture.props.dataItem.poster, `${fixture.label}: image preserved`);
    assert.equal(parsed.dateCreated, String(fixture.props.dataItem.year), `${fixture.label}: dateCreated preserved`);
    ok(`JSON.parse succeeded; name/description/image/dateCreated byte-identical (${fixture.expectedType})`);

    if (fixture.expectAggregate) {
      const agg = parsed.aggregateRating as Record<string, unknown> | undefined;
      assert.ok(agg, `${fixture.label}: aggregateRating present when voteCount > 0`);
      assert.equal(agg?.['@type'], 'AggregateRating', `${fixture.label}: aggregateRating type`);
      assert.equal(agg?.ratingCount, fixture.props.dataItem.voteCount, `${fixture.label}: real vote count preserved`);
      ok(`real rating-count logic preserved (ratingCount=${String(agg?.ratingCount)})`);
    } else {
      assert.equal(parsed.aggregateRating, undefined,
        `${fixture.label}: no fabricated aggregateRating when voteCount is 0`);
      ok('no fabricated aggregateRating when voteCount is 0 (honest-facts branch)');
    }

    // The placeholder bug can never return: the emitted block must start
    // with raw JSON, not the literal Svelte expression.
    assert.ok(blocks[0].startsWith('{"@context"'), `${fixture.label}: block starts with raw JSON`);
    ok('block starts with raw JSON (no literal {structuredData} placeholder)');
  }
} finally {
  rmSync(harnessDir, { recursive: true, force: true });
}

console.log(`\nJSON-LD SSR regression tests passed (${passed} checks).`);
