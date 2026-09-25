// ============================================================================
// DEVICE RPC AMBIGUITY GUARD — static regression test
// ============================================================================
// Guards against the production incident class SQLSTATE 42702:
// "column reference X is ambiguous — it could refer to either a
// PL/pgSQL variable or a table column."
//
// ROOT CAUSE BEING GUARDED:
//   PL/pgSQL `RETURNS TABLE(id, exchange_code, ...)` declares OUT
//   parameter VARIABLES. If a function body then references a table
//   column with the same name UNQUALIFIED (select list, WHERE clause,
//   RETURNING list, ORDER BY), PostgreSQL refuses to guess and raises
//   42702 at execution time. This shipped to production in
//   20261003000000 (all four pairing RPCs) and 20260930000000
//   (register_device_session) and broke every QR exchange attempt
//   (requestId e8fb94ed-bb64-46b8-a5bb-6a3b17088f92).
//
// WHAT THIS TEST DOES:
//   1. Parses every supabase/migrations/*.sql file in timestamp order
//      and computes the FINAL definition of each device RPC (last
//      definition wins — mirrors applying the chain to a database).
//   2. For each final function body, flags any BARE identifier that is
//      simultaneously:
//        - an OUT-parameter name (from RETURNS TABLE) or a DECLARE
//          variable name, AND
//        - a column of device_pairing_requests / device_sessions,
//      unless the position can only ever be a column (UPDATE SET
//      targets and INSERT column lists — SQL never substitutes
//      variables there).
//   3. Proves the checker has teeth by running it against the
//      PRE-FIX state (migrations up to 20261003 / 20260930) and
//      asserting it flags the exact historical ambiguities.
//   4. Asserts the fix migration (20261004000000) preserves the wire
//      contract: identical signatures (PostgREST binds by name),
//      identical defaults, identical return types, SECURITY DEFINER,
//      search_path, service_role-only EXECUTE, and that it uses
//      CREATE OR REPLACE (no DROP, no schema/table changes).
//   5. Advisories: scans every OTHER plpgsql function in the migration
//      chain for the same pattern (printed, not asserted — device RPCs
//      are the guarded surface; anything else gets reported here for
//      follow-up).
//
// The LIVE counterpart (scripts/device_pairing_rpc_live_test.ts) applies
// the real migration files to an embedded PostgreSQL and verifies
// behavior end-to-end.
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Strip line comments, block comments and the contents of string literals. */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "''";
      continue;
    }
    // dollar-quoted strings only matter inside function bodies, which we
    // handle separately — top-level SQL here has none.
    out += sql[i];
    i += 1;
  }
  return out;
}

interface FunctionDef {
  file: string;
  name: string;
  argList: string;          // raw text between the outer parens
  returnsTable: string[];   // OUT column names from RETURNS TABLE(...)
  header: string;           // text between argList ')' and 'as $$' (language/security/search_path)
  body: string;             // text between the $$ ... $$ of the body
  fullMatch: string;        // whole create statement text (for grant checks)
}

const DEVICE_FUNCTIONS = [
  'claim_device_pairing',
  'complete_device_pairing',
  'release_device_pairing_exchange',
  'fail_device_pairing',
  'register_device_session',
] as const;

/** Extract the last `create [or replace] function public.<name>(...)` per name. */
function parseFunctionDefs(files: { file: string; sql: string }[]): Map<string, FunctionDef> {
  const defs = new Map<string, FunctionDef>();
  for (const { file, sql } of files) {
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1];
      // balanced-paren scan for the argument list
      let depth = 1;
      let i = re.lastIndex;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') depth -= 1;
        i += 1;
      }
      const argList = sql.slice(re.lastIndex, i - 1);

      // header + returns table + body within the next chunk
      const chunk = sql.slice(i, i + 8000);
      const returnsM = chunk.match(/returns\s+table\s*\(([^)]*)\)/i);
      const bodyM = chunk.match(/\$\$(.*?)\$\$/is);
      const headerEnd = bodyM ? chunk.indexOf('$$') : -1;
      const header = headerEnd === -1 ? '' : chunk.slice(0, headerEnd);
      const outNames = (returnsM?.[1] ?? '')
        .split(',')
        .map((c) => c.trim().split(/\s+/)[0].replace(/^--.*$/, '').toLowerCase())
        .filter((c) => c.length > 0 && /^[a-z_][a-z0-9_]*$/.test(c));
      defs.set(name, {
        file,
        name,
        argList,
        returnsTable: outNames,
        header,
        body: bodyM ? bodyM[1] : '',
        fullMatch: `create function public.${name}(${argList})`,
      });
    }
  }
  return defs;
}

/** Column names of a table, derived from its CREATE TABLE DDL (+ ADD COLUMN statements). */
function tableColumns(files: { file: string; sql: string }[], table: string): Set<string> {
  const cols = new Set<string>();
  for (const { sql } of files) {
    const cleaned = stripCommentsAndStrings(sql);
    const createRe = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(cleaned)) !== null) {
      let depth = 1;
      let i = createRe.lastIndex;
      while (i < cleaned.length && depth > 0) {
        if (cleaned[i] === '(') depth += 1;
        else if (cleaned[i] === ')') depth -= 1;
        i += 1;
      }
      const inner = cleaned.slice(createRe.lastIndex, i - 1);
      for (const line of inner.split(/[\n,]/)) {
        const t = line.trim();
        if (!t) continue;
        const cm = t.match(/^([a-z_][a-z0-9_]*)\s+[a-z]/i);
        if (cm && !/^(check|primary|unique|foreign|constraint|exclude)$/i.test(cm[1])) {
          cols.add(cm[1].toLowerCase());
        }
      }
    }
    const addRe = new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)`, 'gi');
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(cleaned)) !== null) cols.add(a[1].toLowerCase());
  }
  return cols;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ambiguity checker (mirrors PL/pgSQL variable_conflict=error for the
// variable/column name-collision class)
// ─────────────────────────────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'into', 'for', 'update',
  'order', 'by', 'desc', 'asc', 'set', 'insert', 'values', 'returning', 'return', 'query',
  'if', 'then', 'else', 'end', 'begin', 'declare', 'as', 'on', 'in', 'exists', 'create',
  'table', 'index', 'constraint', 'check', 'unique', 'primary', 'key', 'foreign',
  'references', 'default', 'do', 'exception', 'when', 'found', 'record', 'uuid', 'text',
  'int', 'integer', 'timestamptz', 'boolean', 'timestamp', 'zone', 'utc', 'now',
  'timezone', 'make_interval', 'extract', 'epoch', 'cast', 'coalesce', 'case', 'using',
  'policy', 'to', 'grant', 'revoke', 'execute', 'function', 'language', 'plpgsql',
  'security', 'definer', 'search_path', 'true', 'false', 'new', 'old', 'others', 'conflict', 'nothing',
]);

interface Violation {
  name: string;
  identifier: string;
  context: string;
}

function checkAmbiguity(def: FunctionDef, dangerous: Set<string>): Violation[] {
  const violations: Violation[] = [];
  const body = stripCommentsAndStrings(def.body);
  if (!dangerous.size || !body) return violations;

  // Tokenize: identifiers + significant punctuation
  const tokens: { v: string; i: number }[] = [];
  const tokenRe = /[A-Za-z_][A-Za-z0-9_]*|[.,;()=:]|\S/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(body)) !== null) tokens.push({ v: tm[0], i: tm.index });

  // Statement-context state machine
  let inUpdate = false;
  let inSetAssignments = false;   // between SET and WHERE/RETURNING inside UPDATE
  let insertState: 'none' | 'into' | 'columns' = 'none';
  let insertDepth = 0;

  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    const lower = t.v.toLowerCase();
    const prev = k > 0 ? tokens[k - 1].v : '';
    const next = k < tokens.length - 1 ? tokens[k + 1].v : '';
    const nextNext = k < tokens.length - 2 ? tokens[k + 2].v : '';

    // context transitions (keywords)
    if (insertState === 'none' && lower === 'update') { inUpdate = true; inSetAssignments = false; }
    else if (inUpdate && lower === 'set') { inSetAssignments = true; }
    else if (inSetAssignments && (lower === 'where' || lower === 'returning')) { inSetAssignments = false; }
    else if (lower === 'select') { inUpdate = false; inSetAssignments = false; }

    if (insertState === 'none' && lower === 'insert') { insertState = 'into'; }
    else if (insertState === 'into' && lower === 'into') { /* stay */ }
    else if (insertState === 'into' && t.v === '(') { insertState = 'columns'; insertDepth = 1; }
    else if (insertState === 'columns') {
      if (t.v === '(') insertDepth += 1;
      else if (t.v === ')') { insertDepth -= 1; if (insertDepth === 0) insertState = 'none'; }
      else if (lower === 'values') insertState = 'none';
    }

    if (t.v === ';') { inUpdate = false; inSetAssignments = false; insertState = 'none'; insertDepth = 0; }

    // identifier checks
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.v)) continue;
    if (prev === '.') continue;                       // qualified column (dpr.id)
    if (next === '.') continue;                       // itself a qualifier (dpr / public / v_row)
    if (next === '(') continue;                       // function call
    if (SQL_KEYWORDS.has(lower)) continue;
    if (!dangerous.has(lower)) continue;

    const isSetTarget = inSetAssignments && (next === '=' || next === ',');
    const isPlpgsqlAssignment = next === ':' && nextNext === '='; // var := expr — always a variable target
    const isInsertColumn = insertState === 'columns';
    if (isSetTarget || isPlpgsqlAssignment || isInsertColumn) continue; // column/variable-only positions — never ambiguous

    const lineStart = body.lastIndexOf('\n', t.i) + 1;
    const lineEnd = body.indexOf('\n', t.i) === -1 ? body.length : body.indexOf('\n', t.i);
    violations.push({
      name: def.name,
      identifier: t.v,
      context: body.slice(lineStart, lineEnd).trim().slice(0, 90),
    });
  }
  return violations;
}

function declareNames(def: FunctionDef): Set<string> {
  const names = new Set<string>();
  const dm = def.body.match(/^\s*declare\s(.*?)\s*begin\b/is);
  if (!dm) return names;
  for (const line of dm[1].split(';')) {
    const t = line.trim();
    if (!t) continue;
    const cm = t.match(/^([a-z_][a-z0-9_]*)\s/i);
    if (cm) names.add(cm[1].toLowerCase());
  }
  return names;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Argument identity: names + types (defaults dropped) — matches pg_proc identity rules. */
function argIdentity(argList: string): string {
  return normalizeWhitespace(
    argList
      .split(',')
      .map((a) => a.replace(/\bdefault\b.*$/i, '').trim())
      .filter(Boolean)
      .join(', ')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Load migrations
// ─────────────────────────────────────────────────────────────────────────────

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migrations = migrationFiles.map((f) => ({ file: f, sql: read(path.join('supabase', 'migrations', f)) }));

const FIX_MIGRATION = '20261004000000_device_rpc_ambiguous_column_fix.sql';
const PRE_FIX_CHAIN_END = '20261003000000_device_pairing_exchange_lease.sql';

const indexOfFile = (f: string) => migrationFiles.indexOf(f);
assert.ok(indexOfFile(FIX_MIGRATION) > 0, `${FIX_MIGRATION} must exist in supabase/migrations/`);
assert.ok(indexOfFile(PRE_FIX_CHAIN_END) > 0, 'pre-fix boundary migration must exist');

const preFixMigrations = migrations.slice(0, indexOfFile(FIX_MIGRATION));
const allMigrations = migrations;

const pairingColumns = tableColumns(allMigrations, 'device_pairing_requests');
const sessionColumns = tableColumns(allMigrations, 'device_sessions');
const deviceColumns = new Set([...pairingColumns, ...sessionColumns]);

console.log('device_rpc_ambiguity_guard_test');
console.log(`  scanned ${migrationFiles.length} migrations; device columns tracked: ${deviceColumns.size}`);

// sanity: the tracked column set contains the production-collision names
ok(pairingColumns.has('id') && pairingColumns.has('exchange_code') && pairingColumns.has('exchange_attempts'),
  'tracked device_pairing_requests columns include id / exchange_code / exchange_attempts');
ok(sessionColumns.has('user_id') && sessionColumns.has('supabase_session_id'),
  'tracked device_sessions columns include user_id / supabase_session_id');

// ─────────────────────────────────────────────────────────────────────────────
// 1. TEETH: the checker must flag the historical (pre-fix) definitions
// ─────────────────────────────────────────────────────────────────────────────
console.log('1. checker teeth — pre-fix definitions are flagged');

{
  const preFixDefs = parseFunctionDefs(preFixMigrations);
  const flagged: Record<string, Violation[]> = {};
  for (const name of DEVICE_FUNCTIONS) {
    const def = preFixDefs.get(name);
    assert.ok(def, `pre-fix definition of ${name} must exist`);
    const dangerous = new Set(
      [...def.returnsTable, ...declareNames(def)].filter((n) => deviceColumns.has(n))
    );
    flagged[name] = checkAmbiguity(def, dangerous);
  }

  const claimIds = flagged.claim_device_pairing.filter((v) => v.identifier === 'id').length;
  const claimCode = flagged.claim_device_pairing.filter((v) => v.identifier === 'exchange_code').length;
  const claimAttempts = flagged.claim_device_pairing.filter((v) => v.identifier === 'exchange_attempts').length;
  ok(claimIds >= 3, `pre-fix claim flags bare "id" ≥3 times (select list + 2 UPDATE WHEREs)`, `got ${claimIds}`);
  ok(claimCode >= 1 && claimAttempts >= 1, 'pre-fix claim flags exchange_code + exchange_attempts in the SELECT list',
    `got code=${claimCode} attempts=${claimAttempts}`);
  ok(flagged.claim_device_pairing.some((v) => v.context.includes('into v_row')), 'flagged context is the SELECT ... INTO v_row statement');

  for (const name of ['complete_device_pairing', 'release_device_pairing_exchange', 'fail_device_pairing'] as const) {
    ok(flagged[name].length >= 2, `pre-fix ${name} flags bare "id" in WHERE + RETURNING`, `got ${flagged[name].length}`);
  }
  ok(flagged.register_device_session.length >= 4,
    'pre-fix register_device_session flags user_id/supabase_session_id/id/revoked_at',
    `got ${flagged.register_device_session.length}: ${[...new Set(flagged.register_device_session.map((v) => v.identifier))].join(',')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. FINAL STATE: zero ambiguity in every device RPC
// ─────────────────────────────────────────────────────────────────────────────
console.log('2. final state (after full chain incl. fix migration) is unambiguous');

{
  const finalDefs = parseFunctionDefs(allMigrations);
  for (const name of DEVICE_FUNCTIONS) {
    const def = finalDefs.get(name);
    assert.ok(def, `final definition of ${name} must exist`);
    const dangerous = new Set([...def.returnsTable, ...declareNames(def)].filter((n) => deviceColumns.has(n)));
    const violations = checkAmbiguity(def, dangerous);
    ok(violations.length === 0,
      `final ${name} has ZERO bare OUT/DECLARE names in SQL expression positions`,
      violations.map((v) => `"${v.identifier}" in: ${v.context}`).join(' | '));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CONTRACT PRESERVATION — fix migration vs previous definitions
// ─────────────────────────────────────────────────────────────────────────────
console.log('3. wire contract preserved (signatures, defaults, returns, security)');

{
  const preFixDefs = parseFunctionDefs(preFixMigrations);
  const finalDefs = parseFunctionDefs(allMigrations);
  const fixSql = read(path.join('supabase', 'migrations', FIX_MIGRATION));
  const fixDefs = parseFunctionDefs([{ file: FIX_MIGRATION, sql: fixSql }]);

  for (const name of DEVICE_FUNCTIONS) {
    const before = preFixDefs.get(name);
    const after = fixDefs.get(name);
    assert.ok(before, `pre-fix ${name} def`);
    assert.ok(after, `fix migration defines ${name}`);
    ok(argIdentity(before.argList) === argIdentity(after.argList),
      `${name}: argument identity unchanged (names+types)`,
      `${argIdentity(before.argList)} → ${argIdentity(after.argList)}`);
    ok(normalizeWhitespace(before.argList) === normalizeWhitespace(after.argList),
      `${name}: defaults preserved verbatim (incl. p_now default)`);
    ok(before.returnsTable.length === after.returnsTable.length &&
       before.returnsTable.every((c, idx) => c === after.returnsTable[idx]),
      `${name}: RETURNS TABLE columns unchanged`);
    ok(/security\s+definer/i.test(after.header), `${name}: still SECURITY DEFINER`);
    ok(/set\s+search_path\s*=\s*public/i.test(after.header), `${name}: still SET search_path = public`);
    ok(/language\s+plpgsql/i.test(after.header), `${name}: still LANGUAGE plpgsql`);
    ok(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\b`, 'i').test(fixSql),
      `${name}: replaced via CREATE OR REPLACE (no DROP, no overload)`);
  }

  // Function-only migration: no schema/table/index/constraint changes.
  const fixCleaned = stripCommentsAndStrings(fixSql);
  ok(!/\b(alter\s+table|create\s+(table|index)|drop\s+(table|index|function|trigger|policy))\b/i.test(fixCleaned),
    'fix migration is function-only (no ALTER TABLE / CREATE|DROP table|index|function)');

  // Grants re-asserted for all five functions.
  for (const name of DEVICE_FUNCTIONS) {
    const grantRe = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
    ok(grantRe.test(fixSql), `${name}: service_role EXECUTE grant re-asserted`);
  }
  ok((fixSql.match(/revoke\s+execute\s+on\s+function/gi) ?? []).length >= 15,
    'fix migration revokes PUBLIC/anon/authenticated on all five functions');

  // The masked 42883 must stay gone: no make_interval(ms => ...) anywhere in
  // final bodies (comment-stripped — the fix migration documents the trap in
  // a comment, which is not executable SQL).
  for (const name of DEVICE_FUNCTIONS) {
    const def = finalDefs.get(name);
    assert.ok(def, `final ${name}`);
    ok(!/make_interval\s*\(\s*ms\s*=>/i.test(stripCommentsAndStrings(def.body)),
      `${name}: no make_interval(ms => …) (SQLSTATE 42883 trap)`);
  }

  // Operator verification probe is documented in the migration.
  ok(fixSql.includes("repeat('0', 64)"), 'fix migration documents the repeat(\'0\', 64) operator probe');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADVISORY — same pattern scan across every other plpgsql function
// ─────────────────────────────────────────────────────────────────────────────
console.log('4. advisory scan — other plpgsql functions in the chain');

{
  const finalDefs = parseFunctionDefs(allMigrations);
  const deviceSet = new Set<string>(DEVICE_FUNCTIONS);
  let advisories = 0;
  for (const [name, def] of finalDefs) {
    if (deviceSet.has(name) || !def.body) continue;
    const dangerous = new Set([...def.returnsTable, ...declareNames(def)].filter((n) => deviceColumns.has(n)));
    // Advisory scope: any bare OUT/DECLARE name (columns of the tables the
    // body references cannot be resolved statically in general — report the
    // superset for OUT params, which is the exact production pattern).
    const outDangerous = new Set(def.returnsTable);
    const hits = [...checkAmbiguity(def, dangerous), ...checkAmbiguity(def, outDangerous)]
      .filter((v, idx, arr) => arr.findIndex((x) => x.identifier === v.identifier && x.context === v.context) === idx);
    if (hits.length > 0) {
      advisories += 1;
      console.log(`  ⚠ ADVISORY ${name} (${def.file}): ${hits.length} bare OUT-parameter name(s): ${hits.slice(0, 3).map((h) => `"${h.identifier}" in: ${h.context}`).join(' | ')}`);
    }
  }
  console.log(`  advisory functions flagged: ${advisories} (device RPCs are the asserted surface)`);
  ok(true, `advisory scan completed over ${finalDefs.size} tracked functions`);
}

console.log(`\nPASS: device_rpc_ambiguity_guard_test — ${passed} checks`);
