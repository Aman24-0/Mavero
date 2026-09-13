// Phase 9 — LIVE TMDB network diagnostic (final verification phase).
//
// PURPOSE
// =======
// Independently re-confirm the verified Indian Adult network IDs against
// LIVE TMDB — not against hardcoded registry values, old fixtures, memory,
// or previous verification sessions:
//
//   Ullu     -> 2902
//   Kooku    -> 4573
//   Atrangii -> 7355
//
// The diagnostic runs THREE parts:
//
//   Part A — TMDB JSON API (the authoritative check; runs only when
//            credentials are present in the environment, using EXACTLY the
//            repository's credential contract: TMDB_READ_ACCESS_TOKEN
//            (v4 Bearer) or TMDB_API_KEY (v3 query param). Credentials are
//            NEVER printed, logged, or persisted. If neither variable is
//            set, Part A is reported CONFIG_MISSING and skipped — this is
//            an environment limitation, not a repository defect (the repo
//            correctly contains no committed credentials).
//   Part B — LIVE TMDB website evidence (credential-free, always runs):
//            GET https://www.themoviedb.org/network/{id} must redirect to
//            a slug derived from TMDB's own records (/{id}-{name}) and the
//            resolved page title must contain the expected network name.
//            Method controls re-run in the same session:
//              positive control  213  -> 213-netflix (known NON-adult network
//              resolves — proves the method reads real TMDB records)
//              negative control  999999999 -> 404 (unknown IDs are rejected)
//              near-miss control 2901 -> resolves to a DIFFERENT network
//              ("Spiegel TV Wissen") — proves exact-ID matching matters and
//              that a neighbouring ID is not silently accepted for Ullu.
//   Part C — Registry consistency (pure, imports the REAL registry module):
//              - verified set == { Ullu:2902, Kooku:4573, Atrangii:7355 }
//              - unverified entries all carry tmdbNetworkId 0
//              - a network TMDB knows live (Netflix 213) is NOT in the
//                Adult registry and does not classify as adult
//              - near-miss ID 2901 is not registered
//              - the production filter value is exactly "2902|4573|7355"
//              - repo-wide scan: the literal IDs appear only in the
//                registry module, test suites, and documentation — never
//                in adapters or other production code.
//
// RUN
// ===
//   pnpm exec tsx --tsconfig ./jsconfig.json scripts/adult_phase9_tmdb_diagnostic.ts
//   (optionally with TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in the env to
//    enable the JSON API part — the operator supplies the secret; this
//    script never writes it anywhere)
//
// Exit code 0 = all executed checks passed; non-zero = at least one failure.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- Expected values (the registry contract this diagnostic verifies) ----

const EXPECTED_NETWORKS: Array<{ id: number; name: string; slug: string }> = [
  { id: 2902, name: 'ullu', slug: 'ullu' },
  { id: 4573, name: 'Kooku', slug: 'kooku' },
  { id: 7355, name: 'Atrangii', slug: 'atrangii' }
];

const POSITIVE_CONTROL = { id: 213, slug: 'netflix' }; // known TMDB network, NOT adult
const NEGATIVE_CONTROL_ID = 999999999; // unknown to TMDB
const NEAR_MISS_CONTROL = { id: 2901, notSlug: 'ullu' }; // neighbours Ullu's ID space

// ---- Report plumbing ----

let checks = 0;
let failures = 0;
const lines: string[] = [];

function report(ok: boolean, label: string, detail?: string): void {
  checks += 1;
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  const suffix = detail ? ` — ${detail}` : '';
  lines.push(`  [${mark}] ${label}${suffix}`);
  if (!ok) process.exitCode = 1;
}

function section(title: string): void {
  lines.push('');
  lines.push(title);
}

// ---- Part A — TMDB JSON API (credential-aware; mirrors tmdbRequest contract) ----

const TMDB_BASE = 'https://api.themoviedb.org/3';

function readCredentials(): { token?: string; apiKey?: string } {
  // Same env names as src/lib/server/content/adapters/tmdb.ts.
  // Values are read but NEVER printed (failures never embed them).
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  return { token: token && token.trim() ? token.trim() : undefined, apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined };
}

async function tmdbJson(pathname: string, params: Record<string, string> = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
  const { token, apiKey } = readCredentials();
  const url = new URL(`${TMDB_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!token && apiKey) url.searchParams.set('api_key', apiKey);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url.toString(), { headers });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function partA(): Promise<void> {
  section('PART A — TMDB JSON API diagnostic');
  const { token, apiKey } = readCredentials();
  if (!token && !apiKey) {
    lines.push('  [SKIP] No TMDB credentials in environment (TMDB_READ_ACCESS_TOKEN / TMDB_API_KEY).');
    lines.push('         The repository correctly contains no committed credentials; the JSON API leg');
    lines.push('         of the diagnostic is an operator-supplied-secret run. Live-TMDB evidence for');
    lines.push('         this session is established by Part B (same TMDB records, public website).');
    return;
  }
  lines.push('  Credentials present (values not printed). Running the JSON API diagnostic.');

  // A1. Network detail: /3/network/{id} — exists, ID matches, name matches.
  for (const expected of EXPECTED_NETWORKS) {
    try {
      const res = await tmdbJson(`/network/${expected.id}`);
      report(res.ok && res.status === 200, `network/${expected.id}: HTTP 200`, `status=${res.status}`);
      const body = res.body;
      if (isRecord(body) && typeof body.name === 'string') {
        report(body.id === expected.id, `network/${expected.id}: returned ID matches`, `live id=${String(body.id)}`);
        report(body.name.toLowerCase() === expected.name.toLowerCase(), `network/${expected.id}: name matches "${expected.name}"`, `live name="${body.name}"`);
      } else {
        report(false, `network/${expected.id}: response carries {id, name}`, 'unexpected body shape');
      }
    } catch (error) {
      report(false, `network/${expected.id}: request failed`, error instanceof Error ? error.message : String(error));
    }
  }

  // A2. Positive controls: /3/discover/tv?with_networks=<id> returns TV content
  //     for the network (proves the ID is a valid production TV-network input).
  for (const expected of EXPECTED_NETWORKS) {
    try {
      const res = await tmdbJson('/discover/tv', { with_networks: String(expected.id), include_adult: 'true', sort_by: 'popularity.desc' });
      report(res.ok && res.status === 200, `discover/tv with_networks=${expected.id}: HTTP 200`, `status=${res.status}`);
      const body = res.body;
      if (isRecord(body)) {
        const total = typeof body.total_results === 'number' ? body.total_results : 0;
        report(total > 0, `discover/tv with_networks=${expected.id}: total_results > 0`, `total=${String(total)}`);
        const first = Array.isArray(body.results) && isRecord(body.results[0]) ? body.results[0] : undefined;
        if (first && typeof first.name === 'string') {
          lines.push(`         sample: "${first.name}" (id ${String(first.id)})`);
        }
      }
    } catch (error) {
      report(false, `discover/tv with_networks=${expected.id}: request failed`, error instanceof Error ? error.message : String(error));
    }
  }

  // A3. JSON API negative control: unknown ID -> non-200 (no network entity).
  try {
    const res = await tmdbJson(`/network/${NEGATIVE_CONTROL_ID}`);
    report(res.status === 404, `network/${NEGATIVE_CONTROL_ID}: HTTP 404 (unknown ID rejected)`, `status=${res.status}`);
  } catch (error) {
    report(false, `network/${NEGATIVE_CONTROL_ID}: request failed`, error instanceof Error ? error.message : String(error));
  }

  // A4. JSON API near-miss control: 2901 exists but is NOT Ullu.
  try {
    const res = await tmdbJson('/network/2901');
    if (res.ok && isRecord(res.body) && typeof res.body.name === 'string') {
      report(res.body.id === NEAR_MISS_CONTROL.id && res.body.name.toLowerCase() !== 'ullu', 'network/2901: resolves to a DIFFERENT network (not Ullu)', `live name="${res.body.name}"`);
    } else {
      report(false, 'network/2901: request/shape check', `status=${res.status}`);
    }
  } catch (error) {
    report(false, 'network/2901: request failed', error instanceof Error ? error.message : String(error));
  }

  // A5. Positive control through the API: Netflix 213 is a valid TMDB network.
  try {
    const res = await tmdbJson('/network/213');
    report(res.ok && isRecord(res.body) && res.body.name === 'Netflix', 'network/213: live API resolves Netflix (method positive control)', 'not an Adult registry entry (see Part C)');
  } catch (error) {
    report(false, 'network/213: request failed', error instanceof Error ? error.message : String(error));
  }
}

// ---- Part B — LIVE TMDB website evidence (credential-free) ----

const SITE_BASE = 'https://www.themoviedb.org/network';

async function fetchLiveNetwork(id: number): Promise<{ status: number; redirectUrl: string; title: string }> {
  const response = await fetch(`${SITE_BASE}/${id}`, { redirect: 'manual' });
  const redirectUrl = response.headers.get('location') ?? '';
  let title = '';
  if (response.status >= 300 && response.status < 400) {
    // Follow the redirect once to read the resolved page title.
    const resolved = await fetch(redirectUrl.startsWith('http') ? redirectUrl : `https://www.themoviedb.org${redirectUrl}`);
    const html = await resolved.text();
    title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  }
  return { status: response.status, redirectUrl, title };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .toLowerCase();
}

async function partB(): Promise<void> {
  section('PART B — LIVE TMDB website diagnostic (credential-free; same TMDB records)');
  for (const expected of EXPECTED_NETWORKS) {
    try {
      const live = await fetchLiveNetwork(expected.id);
      report(live.status === 301 || live.status === 302, `network/${expected.id}: live redirect`, `HTTP ${live.status}`);
      const slugOk = live.redirectUrl.includes(`/${expected.id}-`);
      report(slugOk, `network/${expected.id}: slug derived from live records`, live.redirectUrl.split('/').pop() ?? '(none)');
      const nameOk = slugOk && live.redirectUrl.toLowerCase().includes(`/${expected.id}-${expected.slug}`);
      report(nameOk, `network/${expected.id}: slug name matches "${expected.slug}"`);
      const titleOk = decodeHtmlEntities(live.title).includes(expected.name.toLowerCase());
      report(titleOk, `network/${expected.id}: resolved page title contains the network name`, `title="${live.title.slice(0, 60)}"`);
    } catch (error) {
      report(false, `network/${expected.id}: live check failed`, error instanceof Error ? error.message : String(error));
    }
  }

  // Positive control: a known NON-adult network resolves (method validity).
  try {
    const live = await fetchLiveNetwork(POSITIVE_CONTROL.id);
    report(live.status === 301 || live.status === 302, `positive control network/${POSITIVE_CONTROL.id}: resolves`, `HTTP ${live.status}`);
    report(live.redirectUrl.toLowerCase().includes(`-${POSITIVE_CONTROL.slug}`), `positive control network/${POSITIVE_CONTROL.id}: slug is "${POSITIVE_CONTROL.slug}"`, live.redirectUrl.split('/').pop() ?? '(none)');
  } catch (error) {
    report(false, 'positive control 213: live check failed', error instanceof Error ? error.message : String(error));
  }

  // Negative control: an unknown ID is rejected by live TMDB.
  try {
    const live = await fetchLiveNetwork(NEGATIVE_CONTROL_ID);
    report(live.status === 404, `negative control network/${NEGATIVE_CONTROL_ID}: HTTP 404`, `HTTP ${live.status}`);
  } catch (error) {
    report(false, `negative control network/${NEGATIVE_CONTROL_ID}: live check failed`, error instanceof Error ? error.message : String(error));
  }

  // Near-miss control: the neighbouring ID is a DIFFERENT network — the slug
  // must NOT be Ullu's (exact-ID matching matters).
  try {
    const live = await fetchLiveNetwork(NEAR_MISS_CONTROL.id);
    report(live.status === 301 || live.status === 302, `near-miss control network/${NEAR_MISS_CONTROL.id}: resolves`, `HTTP ${live.status}`);
    report(!live.redirectUrl.toLowerCase().includes(`-${NEAR_MISS_CONTROL.notSlug}`), `near-miss control network/${NEAR_MISS_CONTROL.id}: NOT "${NEAR_MISS_CONTROL.notSlug}"`, live.redirectUrl.split('/').pop() ?? '(none)');
  } catch (error) {
    report(false, `near-miss control network/${NEAR_MISS_CONTROL.id}: live check failed`, error instanceof Error ? error.message : String(error));
  }
}

// ---- Part C — Registry consistency (pure; imports the REAL registry) ----

async function partC(): Promise<void> {
  section('PART C — Registry consistency (real registry module + repo-wide scan)');
  const { getAdultNetworks, getVerifiedAdultNetworks, getAdultNetworkIds, getAdultNetworkById, isKnownAdultNetwork } = await import('../src/lib/server/content/adult-networks');
  const { adultNetworkExclusionValue } = await import('../src/lib/server/content/adult-catalog');

  // C1. Verified set is exactly the three expected entries.
  const verified = getVerifiedAdultNetworks();
  report(verified.length === 3, 'registry verified set has exactly 3 entries', `count=${String(verified.length)}`);
  for (const expected of EXPECTED_NETWORKS) {
    const entry = verified.find((candidate) => candidate.tmdbNetworkId === expected.id);
    report(Boolean(entry), `registry contains verified ID ${expected.id}`);
    report(entry?.name.toLowerCase() === expected.name.toLowerCase(), `registry entry ${expected.id} name matches "${expected.name}"`, entry ? `name="${entry.name}"` : '(missing)');
    report(entry?.verification === 'verified', `registry entry ${expected.id} is labeled verified`);
  }
  report(JSON.stringify([...getAdultNetworkIds()].sort((a, b) => a - b)) === '[2902,4573,7355]', 'getAdultNetworkIds() == [2902, 4573, 7355]', JSON.stringify(getAdultNetworkIds()));

  // C2. Unverified candidates never carry a trusted ID.
  const unverified = getAdultNetworks().filter((entry) => entry.verification !== 'verified');
  report(unverified.every((entry) => entry.tmdbNetworkId === 0), `all ${String(unverified.length)} unverified entries carry tmdbNetworkId 0`);

  // C3. Negative control — a network live TMDB knows (Netflix 213) is NOT adult here.
  report(getAdultNetworkById(POSITIVE_CONTROL.id) === undefined, 'registry does NOT contain Netflix 213 (live-known network not auto-adult)');
  report(isKnownAdultNetwork({ id: POSITIVE_CONTROL.id, name: 'Netflix' }) === false, 'isKnownAdultNetwork({id:213,name:Netflix}) is false');

  // C4. Near-miss negative control.
  report(getAdultNetworkById(NEAR_MISS_CONTROL.id) === undefined, 'registry does NOT contain near-miss ID 2901');
  report(isKnownAdultNetwork({ id: NEAR_MISS_CONTROL.id, name: 'Spiegel TV Wissen' }) === false, 'isKnownAdultNetwork({id:2901}) is false');

  // C5. Positive classification semantics against the live-confirmed IDs.
  report(isKnownAdultNetwork({ id: 2902, name: 'anything-else' }) === true, 'isKnownAdultNetwork({id:2902,...}) is true (numeric ID is authoritative)');
  report(isKnownAdultNetwork({ name: 'ULLU' }) === true, 'name-based match is case-insensitive ("ULLU")');
  report(isKnownAdultNetwork(null) === false && isKnownAdultNetwork({}) === false, 'empty/null network references never match');

  // C6. Production filter value is exactly the verified pipe-joined set.
  report(adultNetworkExclusionValue() === '2902|4573|7355', 'adultNetworkExclusionValue() == "2902|4573|7355"', adultNetworkExclusionValue() ?? '(empty)');

  // C7. Repo-wide scan: literal IDs must not be FUNCTIONALLY hardcoded outside
  //     the registry. Documentation comments and test suites are legitimate
  //     per the Phase 9 contract ("hardcoded references are acceptable only
  //     where they are legitimate tests/documentation/registry behavior"), so
  //     comments are stripped before scanning functional code. The registry
  //     module itself (adult-networks.ts) is the source of truth and always
  //     allowed.
  const root = path.resolve(process.cwd());
  const scanDirs = [path.join(root, 'src'), path.join(root, 'scripts')];
  const idPattern = /\b(2902|4573|7355)\b/;
  const violations: string[] = [];
  const stripComments = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|\s)\/\/[^\n]*/g, '$1'); // line comments (not URLs inside strings)
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|svelte|json)$/.test(entry.name)) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      const isTest = rel.startsWith('scripts/');
      const isRegistry = rel.endsWith('src/lib/server/content/adult-networks.ts');
      if (isTest || isRegistry) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!idPattern.test(text)) continue; // fast path: no IDs at all
      if (idPattern.test(stripComments(text))) {
        violations.push(rel);
      }
    }
  };
  for (const dir of scanDirs) {
    if (fs.existsSync(dir)) walk(dir);
  }
  report(violations.length === 0, 'no FUNCTIONAL hardcoding of network IDs outside the registry (comments/docs/tests allowed)', violations.length ? violations.join(', ') : 'no violations');
}

// ---- Main ----

async function main(): Promise<void> {
  lines.push('==================================================================');
  lines.push('PHASE 9 — LIVE TMDB NETWORK DIAGNOSTIC');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push('Expected registry: Ullu=2902, Kooku=4573, Atrangii=7355 (verified-only)');
  lines.push('==================================================================');

  await partA();
  await partB();
  await partC();

  lines.push('');
  lines.push('==================================================================');
  lines.push(`RESULT: ${checks} checks, ${failures} failures — ${failures === 0 ? 'DIAGNOSTIC PASS' : 'DIAGNOSTIC FAIL'}`);
  lines.push('==================================================================');
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(lines.join('\n'));
  console.error('DIAGNOSTIC ERROR (fatal):', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
