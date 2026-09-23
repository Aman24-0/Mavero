import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// PHASE 8 — SECURITY / RATE-LIMIT HARDENING TESTS
// ============================================================
// Phase 8 moves the pairing secret out of the URL query string into
// a URL fragment (#s=<secret>), converts /info from GET to POST
// with JSON body, and adds rate limits for /info and /cancel.
//
// STATIC CONTRACT tests.

// ============================================================
// A. QR URL USES /authorize#s= (FRAGMENT, NOT QUERY)
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');

  ok(createApi.includes('/authorize#s='), 'A. create: QR URL uses /authorize#s= (fragment)');
  ok(!createApi.includes('/authorize?s='), 'A. create: QR URL does NOT use /authorize?s= (query)');
  ok(createApi.includes('encodeURIComponent(pairing.secret)'), 'A. create: URL-encodes the secret in fragment');

  ok('A. QR URL uses fragment (#s=)');
}

// ============================================================
// B. QR URL DOES NOT USE /authorize?s=
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');

  // Explicit: no query-string secret in the QR URL.
  ok(!createApi.match(/authorize\?s=/), 'B. create: no ?s= query in QR URL');

  ok('B. QR URL does NOT use query (?s=)');
}

// ============================================================
// C. SCANNER ACCEPTS VALID FRAGMENT SECRET
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Scanner parses the fragment (#s=<secret>).
  ok(scanner.includes('fragmentParams'), 'C. scanner: parses fragment params');
  ok(scanner.includes("fragmentParams.get('s')"), 'C. scanner: extracts secret from fragment');
  ok(scanner.includes('hash.slice(1)'), 'C. scanner: removes leading # before parsing');

  // Scanner navigates to /authorize#s=<secret>.
  ok(scanner.includes('goto(`/authorize#s='), 'C. scanner: navigates to /authorize#s=<secret>');

  ok('C. scanner accepts valid fragment secret');
}

// ============================================================
// D. SCANNER REJECTS QUERY-BASED SECRET
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Scanner does NOT read secret from query params.
  ok(!scanner.includes("url.searchParams.get('s')"), 'D. scanner: does NOT read secret from query (?s=)');

  // Scanner rejects ANY query params.
  ok(scanner.includes("'unexpected-query-params'"), 'D. scanner: rejects any query params');

  ok('D. scanner rejects query-based secret');
}

// ============================================================
// E. SCANNER REJECTS UNEXPECTED QUERY PARAMS
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  ok(scanner.includes("url.searchParams.toString() !== ''"), 'E. scanner: checks searchParams.toString()');
  ok(scanner.includes("'unexpected-query-params'"), 'E. scanner: rejects unexpected query params');

  ok('E. scanner rejects unexpected query params');
}

// ============================================================
// F. SCANNER REJECTS UNEXPECTED FRAGMENT FORMAT
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Missing fragment.
  ok(scanner.includes("'missing-fragment'"), 'F. scanner: rejects missing fragment');

  // Unexpected fragment params.
  ok(scanner.includes("'unexpected-fragment-param'"), 'F. scanner: rejects unexpected fragment params');

  // Missing/short secret in fragment.
  ok(scanner.includes("'missing-or-short-secret'"), 'F. scanner: rejects missing/short secret');

  ok('F. scanner rejects unexpected fragment format');
}

// ============================================================
// G. SCANNER REJECTS WRONG ORIGIN
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  ok(scanner.includes('url.origin'), 'G. scanner: checks URL origin');
  ok(scanner.includes('window.location.origin'), 'G. scanner: enforces same-origin');
  ok(scanner.includes("'wrong-origin'"), 'G. scanner: rejects wrong-origin URLs');

  ok('G. scanner rejects wrong origin');
}

// ============================================================
// H. SCANNER REJECTS WRONG PATHNAME
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  ok(scanner.includes("url.pathname !== '/authorize'"), 'H. scanner: rejects non-/authorize paths');
  ok(scanner.includes("'wrong-path'"), 'H. scanner: rejects wrong-path URLs');

  ok('H. scanner rejects wrong pathname');
}

// ============================================================
// I. AUTHORIZE PAGE READS SECRET FROM FRAGMENT
// ============================================================
{
  const authorize = read('src/routes/authorize/+page.svelte');

  // Reads from window.location.hash (client-side only).
  ok(authorize.includes('window.location.hash'), 'I. authorize: reads from window.location.hash');
  ok(authorize.includes('fragmentParams'), 'I. authorize: parses fragment params');
  ok(authorize.includes("fragmentParams.get('s')"), 'I. authorize: extracts secret from fragment');

  // Does NOT read from page.url.searchParams.
  ok(!authorize.includes('page.url.searchParams.get'), 'I. authorize: does NOT read from page.url.searchParams');
  ok(!authorize.match(/searchParams\.get\(['"]s['"]\)/), 'I. authorize: no searchParams.get(s) anywhere');

  ok('I. authorize page reads secret from fragment (client-side)');
}

// ============================================================
// J. AUTHORIZE PAGE CALLS /info VIA POST
// ============================================================
{
  const authorize = read('src/routes/authorize/+page.svelte');

  ok(authorize.includes("method: 'POST'"), 'J. authorize: calls /info via POST');
  ok(authorize.includes("'content-type': 'application/json'"), 'J. authorize: JSON content-type');
  ok(authorize.includes('JSON.stringify({ secret: pairingSecret })'), 'J. authorize: sends secret in JSON body');

  ok('J. authorize page calls /info via POST');
}

// ============================================================
// K. AUTHORIZE PAGE DOES NOT CALL /info?s=
// ============================================================
{
  const authorize = read('src/routes/authorize/+page.svelte');

  ok(!authorize.includes('/info?s='), 'K. authorize: does NOT call /info?s=<secret>');
  ok(!authorize.match(/info\?s=/), 'K. authorize: no query-string info lookup');

  ok('K. authorize page does NOT call /info?s=');
}

// ============================================================
// L. /info ACCEPTS JSON { secret }
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(infoApi.includes('export const POST'), 'L. info: POST handler');
  ok(!infoApi.includes('export const GET'), 'L. info: no GET handler');
  ok(infoApi.includes('readJsonBody'), 'L. info: uses readJsonBody');
  ok(infoApi.includes('MAX_BODY_BYTES'), 'L. info: body size limit');
  ok(infoApi.includes("body.value?.secret"), 'L. info: extracts secret from body');
  ok(infoApi.includes('typeof secret'), 'L. info: type-checks secret');
  ok(infoApi.includes('secret.length < 16'), 'L. info: minimum secret length');

  ok('L. /info accepts JSON { secret }');
}

// ============================================================
// M. /info VALIDATES MALFORMED/MISSING/SHORT SECRET
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(infoApi.includes('if (!body.ok)'), 'M. info: rejects malformed body');
  ok(infoApi.includes('typeof secret !== \'string\''), 'M. info: rejects non-string secret');
  ok(infoApi.includes('secret.length < 16'), 'M. info: rejects short secret');
  ok(infoApi.includes('400'), 'M. info: returns 400 for invalid input');

  ok('M. /info validates malformed/missing/short secret');
}

// ============================================================
// N. /info DOES NOT EXPOSE exchange_code
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(!infoApi.match(/json\(\s*\{[^}]*exchange_code/), 'N. info: no exchange_code in JSON response');
  ok(!infoApi.match(/json\(\s*\{[^}]*access_token/), 'N. info: no access_token in JSON response');
  ok(!infoApi.match(/json\(\s*\{[^}]*refresh_token/), 'N. info: no refresh_token in JSON response');

  // The SELECT does NOT include exchange_code.
  ok(infoApi.includes('select('), 'N. info: has a select clause');
  const selectClause = infoApi.match(/select\(['"]([^'"]+)['"]\)/);
  if (selectClause) {
    ok(!selectClause[1].includes('exchange_code'), 'N. info: SELECT does NOT include exchange_code');
  }

  ok('N. /info does not expose exchange_code');
}

// ============================================================
// O. /info USES no-store
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  ok(infoApi.includes('cache-control'), 'O. info: has cache-control header');
  ok(infoApi.includes('no-store'), 'O. info: cache-control value is no-store');

  ok('O. /info uses no-store');
}

// ============================================================
// P. /info HAS pairingInfo RATE LIMIT
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const rl = read('src/lib/server/http/rate-limit.ts');

  ok(infoApi.includes('checkRateLimit'), 'P. info: rate limited');
  ok(infoApi.includes("'pairingInfo'"), 'P. info: uses pairingInfo bucket');
  ok(infoApi.includes('429'), 'P. info: returns 429');
  ok(infoApi.includes('retry-after'), 'P. info: includes retry-after header');

  ok(rl.includes('pairingInfo'), 'P. rate-limit: pairingInfo bucket defined');
  ok(rl.match(/pairingInfo:\s*\{\s*limit:\s*30/), 'P. rate-limit: pairingInfo limit is 30/min');

  ok('P. /info has pairingInfo rate limit');
}

// ============================================================
// Q. /cancel HAS pairingCancel RATE LIMIT
// ============================================================
{
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');
  const rl = read('src/lib/server/http/rate-limit.ts');

  ok(cancelApi.includes('checkRateLimit'), 'Q. cancel: rate limited');
  ok(cancelApi.includes("'pairingCancel'"), 'Q. cancel: uses pairingCancel bucket');
  ok(cancelApi.includes('429'), 'Q. cancel: returns 429');
  ok(cancelApi.includes('retry-after'), 'Q. cancel: includes retry-after header');

  ok(rl.includes('pairingCancel'), 'Q. rate-limit: pairingCancel bucket defined');
  ok(rl.match(/pairingCancel:\s*\{\s*limit:\s*20/), 'Q. rate-limit: pairingCancel limit is 20/min');

  ok('Q. /cancel has pairingCancel rate limit');
}

// ============================================================
// R. 429 RESPONSES INCLUDE Retry-After
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');

  ok(infoApi.includes('retry-after'), 'R. info: 429 has retry-after');
  ok(cancelApi.includes('retry-after'), 'R. cancel: 429 has retry-after');

  ok('R. 429 responses include Retry-After');
}

// ============================================================
// S. EXISTING RATE LIMITS REMAIN INTACT
// ============================================================
{
  const rl = read('src/lib/server/http/rate-limit.ts');

  ok(rl.includes('pairingCreate'), 'S. pairingCreate bucket still exists');
  ok(rl.includes('pairingPoll'), 'S. pairingPoll bucket still exists');
  ok(rl.includes('pairingApprove'), 'S. pairingApprove bucket still exists');
  ok(rl.includes('pairingExchange'), 'S. pairingExchange bucket still exists');

  // Verify limits are unchanged.
  ok(rl.match(/pairingCreate:\s*\{\s*limit:\s*10/), 'S. pairingCreate: 10/min');
  ok(rl.match(/pairingPoll:\s*\{\s*limit:\s*60/), 'S. pairingPoll: 60/min');
  ok(rl.match(/pairingApprove:\s*\{\s*limit:\s*20/), 'S. pairingApprove: 20/min');
  ok(rl.match(/pairingExchange:\s*\{\s*limit:\s*10/), 'S. pairingExchange: 10/min');

  ok('S. existing pairing rate limits remain intact');
}

// ============================================================
// T. NO RAW SECRET LOGGING INTRODUCED
// ============================================================
{
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const cancelApi = read('src/routes/api/auth/device-pairing/cancel/+server.ts');

  for (const [name, file] of [
    ['info', infoApi],
    ['cancel', cancelApi],
  ] as const) {
    ok(!file.match(/console\.\w+.*secret/i), `T. ${name}: no secret logging`);
    ok(!file.match(/console\.\w+.*access_token/i), `T. ${name}: no access_token logging`);
    ok(!file.match(/console\.\w+.*refresh_token/i), `T. ${name}: no refresh_token logging`);
    ok(!file.match(/console\.\w+.*exchange_code/i), `T. ${name}: no exchange_code logging`);
  }

  ok('T. no raw secret logging introduced');
}

// ============================================================
// U. FULL QR FLOW CONTRACT
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const authorize = read('src/routes/authorize/+page.svelte');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
  const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
  const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // create → QR uses #s= fragment
  ok(createApi.includes('/authorize#s='), 'U. create: QR URL uses #s= fragment');

  // scanner → validates #s= fragment → navigates to /authorize#s=
  ok(scanner.includes('fragmentParams.get'), 'U. scanner: validates fragment');
  ok(scanner.includes('goto(`/authorize#s='), 'U. scanner: navigates to /authorize#s=');

  // authorize → reads fragment → POST /info → POST /approve
  ok(authorize.includes('window.location.hash'), 'U. authorize: reads fragment');
  ok(authorize.includes("method: 'POST'"), 'U. authorize: POST /info');
  ok(authorize.includes('/api/auth/device-pairing/approve'), 'U. authorize: POST /approve');

  // TV polling + exchange unchanged
  ok(tvLogin.includes('/api/auth/device-pairing/status'), 'U. TV: polls status');
  ok(tvLogin.includes('/api/auth/device-pairing/exchange'), 'U. TV: calls exchange');

  // approve + status + exchange unchanged
  ok(approveApi.includes('POST'), 'U. approve: POST handler');
  ok(statusApi.includes('GET'), 'U. status: GET handler');
  ok(exchangeApi.includes('POST'), 'U. exchange: POST handler');

  ok('U. full QR flow contract (create → QR → scanner → authorize → info → approve → TV poll → exchange → authenticated)');
}

// ============================================================
// V. PHASE 7 ATOMIC EXCHANGE PRESERVED
// ============================================================
{
  const rpcMigration = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');

  ok(rpcMigration.includes('for update;'), 'V. RPC: SELECT FOR UPDATE preserved');
  ok(rpcMigration.includes("status = 'approved'"), 'V. RPC: WHERE status=approved preserved');
  ok(rpcMigration.includes('exchange_code = null'), 'V. RPC: clears exchange_code preserved');
  ok(rpcMigration.includes('return query select v_row.id'), 'V. RPC: returns OLD exchange_code preserved');

  const service = read('src/lib/server/auth/device-pairing.ts');
  ok(service.includes('.select('), 'V. approve: .select() affected-rows check preserved');
  ok(service.includes('updatedRows'), 'V. approve: updatedRows check preserved');

  ok('V. Phase 7 atomic exchange preserved (RPC + approval race fix)');
}

// ============================================================
// W. NO SECRET IN QUERY-BASED /authorize OR /info URLs
// ============================================================
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  const authorize = read('src/routes/authorize/+page.svelte');
  const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');

  // create: no ?s= in QR URL
  ok(!createApi.includes('/authorize?s='), 'W. create: no /authorize?s= in QR URL');

  // authorize: no ?s= reading
  ok(!authorize.includes('searchParams.get(\'s\')'), 'W. authorize: no searchParams.get(s)');
  ok(!authorize.includes('/info?s='), 'W. authorize: no /info?s= call');

  // info: no GET handler, no ?s= reading
  ok(!infoApi.includes('export const GET'), 'W. info: no GET handler');
  ok(!infoApi.includes("url.searchParams.get"), 'W. info: no searchParams.get');

  ok('W. no pairing secret in query-based /authorize or /info URLs');
}

console.log(`\nPhase 8 security/rate-limit hardening tests passed (${passed} check groups).`);
