#!/usr/bin/env node
/**
 * Resilient sequential runner for the Mavero `pnpm test` chain.
 * Splits the package.json "test" script on '&&' and runs each command in a
 * fresh child process (same as the && chain, but survives long runs and
 * logs per-suite status lines that survive process loss).
 */
import { readFileSync, appendFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const commands = pkg.scripts.test.split('&&').map((c) => c.trim()).filter(Boolean);

const logFile = process.env.RUNNER_LOG ?? '/tmp/chain_progress.log';
const only = process.env.RUNNER_FROM !== undefined ? Number(process.env.RUNNER_FROM) : 0;
const limit = process.env.RUNNER_TO !== undefined ? Number(process.env.RUNNER_TO) : commands.length;

let failed = 0;
for (let i = only; i < Math.min(limit, commands.length); i += 1) {
  const command = commands[i];
  const started = Date.now();
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync(command, { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
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
console.log(`runner done: failed=${failed}`);
