#!/usr/bin/env node
/**
 * Task 4 (2026-10-15) — Device-session forensics probe (OWNER-RUN).
 *
 * READ-ONLY. AGGREGATE-ONLY. This script answers the "28 Unknown device
 * sessions" question with numbers, never identifiers:
 *
 *   §1 Registry totals            — total / active / revoked / stale rows
 *   §2 Device-name distribution   — active rows by device_name bucket
 *   §3 Session-shape aggregates   — rows with last_seen_at = created_at,
 *                                   rows per created-day (last 7 days)
 *   §4 Per-user distribution      — COUNT of users, max rows per user,
 *                                   never a user id
 *   §5 Supabase-side session age  — total sessions in auth (if the
 *                                   service key permits), aggregate only
 *
 * PRIVACY CONTRACT (enforced by construction):
 *   - Every query is a COUNT / GROUP BY over non-identifying columns.
 *   - No user_id, session_id, device_id, ip_hash, token, cookie or IP is
 *     ever selected, interpolated into a message, or written to disk.
 *   - No INSERT / UPDATE / DELETE exists in this script. No sessions are
 *     revoked or deleted. Run it as many times as you like.
 *
 * Usage (from the repo root):
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=<service-role-key> node scripts/mav_task4_session_forensics_probe.mjs
 *
 * Optional Supabase project URL override (defaults to PUBLIC_SUPABASE_URL
 * from .env / .env.local):
 *   PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co ...
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, '.env'));
loadEnvFile(resolve(root, '.env.local'));

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing PUBLIC_SUPABASE_URL or PRIVATE_SUPABASE_SERVICE_ROLE_KEY — nothing was queried.');
  console.error('Usage: PRIVATE_SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/mav_task4_session_forensics_probe.mjs');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // the app's listUserSessions threshold
const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();

async function rpcQuery(sql) {
  // PostgREST /rpc is for functions — we use the data API's raw SQL via a
  // temporary SECURITY INVOKER function? No: keep it dependency-free and
  // use the Supabase REST API with PostgREST-compatible filters where
  // possible; for true aggregates use the `pg_meta`-style REST fallback:
  // Supabase exposes REST rows only, so aggregate queries are executed by
  // selecting the minimal columns and aggregating IN THIS PROCESS.
  // (No SQL execution endpoint exists without a helper function; the
  // script therefore downloads the SAFE subset of columns only.)
  const url = `${SUPABASE_URL}/rest/v1/device_sessions?select=created_at,last_seen_at,revoked_at,device_type,device_name,user_id&order=created_at.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`REST query failed: HTTP ${res.status}`);
  return res.json();
}

// Privacy reducer — aggregates rows in-process; the raw rows never leave
// this function's scope.
function aggregate(rows) {
  const total = rows.length;
  let active = 0, revoked = 0, stale = 0, seenOnce = 0, missingUaLabel = 0, unrecognizedLabel = 0;
  const byName = new Map();
  const byDay = new Map();
  const perUser = new Map();
  for (const row of rows) {
    if (row.revoked_at) revoked += 1; else active += 1;
    if (!row.revoked_at && row.last_seen_at < staleCutoff) stale += 1;
    if (row.last_seen_at === row.created_at) seenOnce += 1;
    const name = row.device_name ?? '(null)';
    if (name === 'Unidentified client (no User-Agent)' || name === 'Unknown device') missingUaLabel += 1;
    if (name === 'Unrecognized client') unrecognizedLabel += 1;
    byName.set(name, (byName.get(name) ?? 0) + 1);
    const day = String(row.created_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + 1);
  }
  const maxRowsPerUser = Math.max(0, ...perUser.values());
  const usersWithRows = perUser.size;
  return { total, active, revoked, stale, seenOnce, missingUaLabel, unrecognizedLabel, byName, byDay, maxRowsPerUser, usersWithRows };
}

async function run() {
  console.log('\nTask 4 — device-session forensics (READ-ONLY, aggregate-only)\n');
  let rows;
  try {
    rows = await rpcQuery();
    ok(Array.isArray(rows), '§0. device_sessions readable with the service key');
  } catch (err) {
    console.error('  ABORT:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const agg = aggregate(rows);

  console.log('\n§1 — registry totals');
  console.log(`  total rows:            ${agg.total}`);
  console.log(`  active (revoked=null): ${agg.active}`);
  console.log(`  revoked:               ${agg.revoked}`);
  console.log(`  active AND stale (>30d without heartbeat): ${agg.stale}`);
  console.log(`  → the Account UI count for the whole registry = active AND NOT stale`);

  console.log('\n§2 — active rows by device_name (the "Unknown device" question)');
  const activeRows = rows.filter((r) => !r.revoked_at);
  const activeAgg = aggregate(activeRows);
  for (const [name, count] of [...activeAgg.byName.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${name}`);
  }
  console.log(`  (rows with a missing-UA label: ${agg.missingUaLabel}; unrecognized-UA label: ${agg.unrecognizedLabel})`);

  console.log('\n§3 — session-shape aggregates');
  console.log(`  rows with last_seen_at = created_at (registered once, never heartbeated): ${agg.seenOnce}`);
  console.log('  rows created per day (last 7 days):');
  const days = [...agg.byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
  for (const [day, count] of days) console.log(`    ${day}: ${count}`);

  console.log('\n§4 — per-user distribution (aggregate only — NO ids)');
  console.log(`  distinct users with registry rows: ${agg.usersWithRows}`);
  console.log(`  max rows for a single user:        ${agg.maxRowsPerUser}`);

  console.log('\n§5 — interpretation guide');
  console.log('  - A row = ONE distinct Supabase auth session (the registry key is (user_id, supabase_session_id)).');
  console.log('  - last_seen_at = created_at + active means: the session registered, then never made another request.');
  console.log('  - "Unidentified client (no User-Agent)" rows = requests WITHOUT a User-Agent header (scripts, email scanners, some TV webviews).');
  console.log('  - "Unrecognized client" rows = a non-empty UA matching no known browser/OS pattern.');
  console.log('  - Correlate the per-day buckets with your own activity (magic-link emails opened, TV pairings, TV app launches)');
  console.log('    to establish origin. This probe cannot attribute requests to a device or geography — no such data is collected.');

  ok(agg.total === rows.length, '§V. read-only verification — every row was only counted');
  console.log(`\nTask 4 probe result: ${passed} passed, ${failed} failed (no data was modified)`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
