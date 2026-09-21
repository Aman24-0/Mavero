import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readJsonBody, DEFAULT_MAX_JSON_BYTES } from '$lib/server/http/body';

/**
 * Phase 1 (audit SEC-010) — body size consistency.
 *
 * Problem: /api/settings/adult-mode PUT (UNAUTHENTICATED route) and
 * /api/admin/adult-mode PUT parsed RAW `request.json()` with no size cap,
 * while the rest of the application uses the shared bounded
 * `readJsonBody` (256 KiB) — an inconsistent pre-cap DoS surface.
 *
 * Fix: both endpoints route through `readJsonBody`. Auth (requireAdmin
 * still runs FIRST on the admin route), validation and error conventions
 * are unchanged.
 *
 * Behavioral: the REAL bounded parser is exercised against oversized /
 * invalid / valid bodies (it is a pure module — fully tsx-importable).
 * The handlers themselves import env-wired modules (adult-policy) and
 * therefore cannot be executed under tsx (same repo-wide constraint);
 * their wiring is asserted statically — the established pattern.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Behavioral — the shared bounded parser (the new boundary)
// ============================================================

function jsonRequest(body: string): Request {
  return new Request('https://mavero.test/api/settings/adult-mode', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

// 1a. Oversized body (declared Content-Length) → 413 BEFORE reading.
{
  const huge = '{"enabled":' + ' '.repeat(DEFAULT_MAX_JSON_BYTES + 1) + 'true}';
  const parsed = await readJsonBody(jsonRequest(huge));
  assert.equal(parsed.ok, false, 'oversized body rejected');
  if (!parsed.ok) {
    assert.equal(parsed.status, 413, 'oversized body maps to 413');
    assert.match(parsed.message, /too large/i);
  }
  ok(true, `1a. oversized JSON body rejected with 413 (cap ${DEFAULT_MAX_JSON_BYTES} bytes)`);
}

// 1b. Oversized body with a LYING (small) Content-Length is still caught by
// the byte count after reading — the parser never trusts the header alone.
{
  const huge = '{"pad":"' + 'x'.repeat(DEFAULT_MAX_JSON_BYTES + 1024) + '"}';
  const request = new Request('https://mavero.test/api/settings/adult-mode', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: huge,
  });
  const parsed = await readJsonBody(request);
  assert.equal(parsed.ok, false, 'lying content-length does not bypass the cap');
  if (!parsed.ok) assert.equal(parsed.status, 413, 'actual byte count enforces the cap');
  ok(true, '1b. a lying Content-Length cannot bypass the cap (byte-count enforcement)');
}

// 1c. Invalid JSON → 400; valid JSON → value returned (conventions preserved).
{
  const invalid = await readJsonBody(jsonRequest('{nope'));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.status, 400, 'invalid JSON maps to 400');
  const valid = await readJsonBody<{ enabled?: boolean }>(jsonRequest('{"enabled":true}'));
  assert.deepEqual(valid, { ok: true, value: { enabled: true } }, 'valid body passes through');
  ok(true, '1c. invalid JSON -> 400; valid JSON passes through unchanged');
}

// ============================================================
// 2. Wiring — both audited endpoints use the bounded parser
// ============================================================

const settingsSource = read('src/routes/api/settings/adult-mode/+server.ts');
const adminSource = read('src/routes/api/admin/adult-mode/+server.ts');

for (const [label, source] of [['settings adult-mode', settingsSource], ['admin adult-mode', adminSource]] as const) {
  assert.match(source, /readJsonBody</, `${label} PUT uses the shared bounded parser`);
  assert.doesNotMatch(source, /request\.json\(\)/, `${label} no longer parses raw request.json()`);
}
ok(true, '2. both audited endpoints wired to readJsonBody (raw request.json() removed)');

// Auth ordering preserved: the admin route STILL authorizes BEFORE parsing
// (requireAdmin guards the request regardless of body size), and the
// validation conventions are intact.
assert.match(adminSource, /await requireAdmin\(locals[\s\S]*?await readJsonBody</, 'admin auth runs before body parsing (auth unchanged)');
assert.match(adminSource, /No valid fields to update\./, 'admin validation convention preserved');
assert.match(settingsSource, /The `enabled` field must be a boolean\./, 'settings validation convention preserved');
ok(true, '3. auth-before-parse preserved; existing validation conventions intact');

console.log(`phase1_body_limit_test: ${passed} checks passed (bounded body parser on adult-mode endpoints)`);
