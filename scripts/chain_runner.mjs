#!/usr/bin/env node
/**
 * Resilient sequential runner for the Mavero `pnpm test` regression gate.
 *
 * 2026-10 (Task A): the package.json "test" script is now a chain of GROUP
 * scripts (test:core, test:admin, test:providers, …). This runner expands
 * each `pnpm run test:<group>` entry into the group's per-suite commands
 * (recursively, one level of grouping is all the gate uses), so per-suite
 * status lines, resume (RUNNER_FROM / RUNNER_TO) and per-suite timeouts
 * keep working against the grouped chain. Non-group commands run as-is.
 *
 * Semantics (unchanged from the original runner):
 *   - Splits pkg.scripts.test on '&&' and runs each command in a fresh
 *     child process, logging per-suite status lines to RUNNER_LOG.
 *   - Diagnostic tool: by default it CONTINUES past failures (recording
 *     them) so a full failure map can be collected in one pass. The
 *     regression GATE itself is `pnpm test` — its && semantics (stop at
 *     the first failure, propagate non-zero exit) are the contract; this
 *     runner never replaces the gate.
 *   - RUNNER_STOP_ON_FAIL=1 stops at the first failure (gate-equivalent).
 *   - RUNNER_FROM / RUNNER_TO resume a range; RUNNER_TIMEOUT_MS (default
 *     300000) bounds each suite.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const GROUP_RE = /^pnpm run (test:[\w:-]+)$/;

/** Expand `pnpm run test:<group>` entries into their per-suite commands. */
function expand(commands, depth = 0) {
  const out = [];
  for (const raw of commands) {
    const command = raw.trim();
    const m = GROUP_RE.exec(command);
    const groupScript = m ? pkg.scripts[m[1]] : undefined;
    if (groupScript && depth < 5) {
      out.push(...expand(groupScript.split('&&').map((c) => c.trim()).filter(Boolean), depth + 1));
    } else if (command) {
      out.push(command);
    }
  }
  return out;
}

const commands = expand(pkg.scripts.test.split('&&'));

const logFile = process.env.RUNNER_LOG ?? '/tmp/chain_progress.log';
const only = process.env.RUNNER_FROM !== undefined ? Number(process.env.RUNNER_FROM) : 0;
const limit = process.env.RUNNER_TO !== undefined ? Number(process.env.RUNNER_TO) : commands.length;
const timeoutMs = process.env.RUNNER_TIMEOUT_MS !== undefined ? Number(process.env.RUNNER_TIMEOUT_MS) : 300000;

let failed = 0;
for (let i = only; i < Math.min(limit, commands.length); i += 1) {
  const command = commands[i];
  const started = Date.now();
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync(command, { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
    const tail = out.toString().trim().split('\n').slice(-1)[0] ?? '';
    appendFileSync(logFile, `OK [${i + 1}/${commands.length}] ${command.slice(0, 120)} :: ${tail.slice(0, 120)} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  } catch (error) {
    failed += 1;
    const stdoutTail = (error.stdout?.toString() ?? '').trim().split('\n').slice(-5).join(' | ');
    const stderrTail = (error.stderr?.toString() ?? '').trim().split('\n').slice(-5).join(' | ');
    appendFileSync(logFile, `FAIL [${i + 1}/${commands.length}] ${command.slice(0, 120)} (exit ${error.status}) ${Math.round((Date.now() - started) / 1000)}s\n  OUT: ${stdoutTail.slice(0, 400)}\n  ERR: ${stderrTail.slice(0, 400)}\n`);
    if (process.env.RUNNER_STOP_ON_FAIL === '1') process.exit(1);
  }
}
appendFileSync(logFile, `RUNNER DONE from=${only} to=${limit} failed=${failed}\n`);
console.log(`runner done: ${commands.length} suites, failed=${failed}`);
