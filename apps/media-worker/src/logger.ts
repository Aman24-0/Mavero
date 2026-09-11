/**
 * MAVERO media worker — structured logging (GOAL B5).
 *
 * One JSON line per event on stdout — machine-parseable by any log
 * collector, safe for humans to read. NEVER logged: tokens, source URLs,
 * authorization material of any kind. Job ids and addon-id FRAGMENTS are
 * the only correlation identifiers.
 */

import { randomUUID } from 'node:crypto';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields, req: undefined });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') write('debug', msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
  newRequestId: () => randomUUID(),
};
