/**
 * MAVERO Adapter Builder — hardened untrusted-module sandbox (plan §8/§14).
 *
 * Executes ONE untrusted Nuvio provider module inside a FRESH V8 realm
 * (vm.createContext) during BUILD-TIME ANALYSIS ONLY. This never happens
 * in Mavero — only inside the disposable external Builder worker.
 *
 * SECURITY MODEL (defense in depth):
 *   1. FRESH REALM: the context gets its own intrinsics (Object, Promise,
 *      JSON …). Objects the module creates have realm-internal
 *      constructors — `({}).constructor.constructor` stays inside the
 *      sandbox realm and cannot reach host `process`.
 *   2. NEUTRALIZED HOST BRIDGES: the ONLY host functions crossing into the
 *      realm (fetch, console, require, setTimeout) are wrapped in proxies
 *      whose `constructor`/`__proto__` accesses return a self-referential
 *      POISON function (the classic vm-escape chain `fn.constructor
 *      .constructor("return process")()` is severed), whose `this` is
 *      always re-bound to the neutralized target, and whose property
 *      access recursively re-neutralizes.
 *   3. PRIMITIVES-ONLY DATA: response objects handed to the module are
 *      BUILT INSIDE THE REALM from primitive arguments (a realm-internal
 *      factory script) — no host object graph is ever passed in.
 *   4. BUDGETS: per-request timeout, response size cap, request-count cap,
 *      total-byte cap, wall-clock budget, bounded console buffer, bounded
 *      timer count — every resource the module can consume is counted.
 *   5. STATIC PRE-SCAN: the module text is rejected when it contains
 *      obvious hostile hooks (node builtins, process access, eval of
 *      control flow we refuse to host) BEFORE any execution.
 *   6. The whole Builder worker is DISPOSABLE BY DESIGN: no DB, no
 *      filesystem writes, no secrets except the inbound auth check — a
 *      full compromise gains nothing (plan §5 architecture).
 */

import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { assertSafeManifestUrl, assertSafeManifestDestination, isBlockedIpAddress, type SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { systemDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { cloudStreamSafeFetch } from '$lib/server/cloudstream/security/http';
import type { AdapterBuildRequest, AdapterTestCase } from '$lib/shared/adapter-artifact';
import type { BuilderLimits } from './config';

// ---------------------------------------------------------------------------
// Sandbox error (closed vocabulary — never carries internals)
// ---------------------------------------------------------------------------

export const SANDBOX_ERROR_CODES = [
  'SANDBOX_FORBIDDEN_PATTERN',
  'SANDBOX_BUDGET_EXCEEDED',
  'SANDBOX_TIMEOUT',
  'SANDBOX_EXECUTION_FAILED',
  'SANDBOX_INVALID_MODULE',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Traces (the analysis observations the compiler consumes)
// ---------------------------------------------------------------------------

export type SandboxFetchRecord = {
  seq: number;
  url: string;
  method: string;
  /** Outbound request header names only (values never recorded). */
  requestHeaderNames: string[];
  /**
   * Sanitized ALLOWLISTED request headers the compiler needs to reproduce
   * the module's requests (user-agent/referer/accept family only — auth
   * tokens and cookies are never recorded). Bounded, values ≤ 512 chars.
   */
  requestHeadersSanitized: Record<string, string>;
  status: number;
  ok: boolean;
  contentType: string | null;
  responseBytes: number;
  finalUrl: string;
  /** sha256 of the response body — correlates cheerio docs to fetches. */
  bodyDigest: string;
  /**
   * For JSON object responses: top-level keys whose values are http(s)
   * URLs, with the value's HOST (host only — never the full URL). Used by
   * the compiler to identify dynamic-domains documents. Bounded ≤ 16.
   */
  jsonUrlKeys: Array<{ key: string; valueHost: string }>;
  /** True when the URL was served by the deterministic TMDB stub. */
  stubbed: boolean;
  durationMs: number;
};

export type SandboxCheerioRecord = {
  docDigest: string;
  op: 'select' | 'attr' | 'text' | 'find';
  selector: string | null;
  attr: string | null;
  resultCount: number;
};

export type SandboxConsoleRecord = { level: 'log' | 'warn' | 'error'; text: string };

export type SandboxTrace = {
  fetches: SandboxFetchRecord[];
  cheerio: SandboxCheerioRecord[];
  console: SandboxConsoleRecord[];
  /** The raw getStreams return value (validated shape). */
  output: SandboxStreamOutput[];
  wallClockMs: number;
};

export type SandboxStreamOutput = {
  name: string | null;
  title: string | null;
  url: string;
  quality: string | null;
  size: string | null;
};

// ---------------------------------------------------------------------------
// Static pre-scan (hostile hooks are rejected BEFORE execution)
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /require\s*\(\s*['"]fs['"]/, reason: 'filesystem access' },
  { pattern: /require\s*\(\s*['"]child_process['"]/, reason: 'process spawning' },
  { pattern: /require\s*\(\s*['"]node:fs/, reason: 'filesystem access' },
  { pattern: /require\s*\(\s*['"]node:child_process/, reason: 'process spawning' },
  { pattern: /require\s*\(\s*['"](?:net|dgram|tls|node:net|node:dgram|node:tls)['"]/, reason: 'raw sockets' },
  { pattern: /require\s*\(\s*['"](?:os|v8|node:os|node:v8)['"]/, reason: 'host introspection' },
  { pattern: /process\s*\.\s*(?:binding|mainModule|env|exit|kill)/, reason: 'process access' },
  { pattern: /globalThis\s*\.\s*process\b/, reason: 'process access' },
  { pattern: /\b__dirname\b/, reason: 'filesystem paths' },
  { pattern: /\b__filename\b/, reason: 'filesystem paths' },
];

/** Static gate: reject modules containing forbidden hostile hooks. */
export function staticScanModuleSource(source: string): { ok: boolean; reason: string | null } {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) return { ok: false, reason };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Poison + neutralization (sever every host-object escape chain)
// ---------------------------------------------------------------------------

/** Self-referential dead-end function: constructor → POISON, forever. */
const POISON: unknown = new Proxy(function poison(): never {
  throw new Error('sandbox: blocked');
}, {
  get(_target: unknown, prop: string | symbol): unknown {
    if (prop === 'constructor' || prop === '__proto__') return POISON;
    if (prop === Symbol.toPrimitive) return () => '[blocked]';
    if (prop === 'toString' || prop === 'name') return '[blocked]';
    return undefined;
  },
  apply(): never { throw new Error('sandbox: blocked'); },
  construct(): never { throw new Error('sandbox: blocked'); },
});

function isSafeSymbol(prop: string | symbol): boolean {
  return typeof prop === 'string' || prop === Symbol.iterator || prop === Symbol.asyncIterator;
}

/**
 * Neutralizes ONE host object crossing into the realm: `constructor` and
 * `__proto__` are poisoned, function properties are BOUND to the original
 * target (receiver-sensitive host methods — cheerio collections, response
 * objects — keep working; realm code can never substitute a receiver),
 * function calls apply with the ORIGINAL host target as the receiver, and
 * every returned value is recursively neutralized. Strings/numbers/
 * booleans/null pass untouched.
 */
function neutralize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type !== 'function' && type !== 'object') return value; // primitives safe
  return new Proxy(value as object, {
    get(target: object, prop: string | symbol, _receiver: unknown): unknown {
      if (prop === 'constructor' || prop === '__proto__') return POISON;
      if (!isSafeSymbol(prop)) return undefined;
      const inner = Reflect.get(target, prop, target) as unknown;
      if (typeof inner === 'function') {
        // BOUND method: the receiver is pinned to the original target —
        // the method's `this` is always the object it was read from, never
        // a realm-controlled receiver (escape-proof AND correct).
        return neutralize((inner as (...args: unknown[]) => unknown).bind(target));
      }
      return neutralize(inner);
    },
    set(target: object, prop: string | symbol, value: unknown): boolean {
      if (prop === '__proto__') return true; // swallow proto pollution attempts
      try { Reflect.set(target, prop, value); } catch { /* read-only host props */ }
      return true;
    },
    has(target: object, prop: string | symbol): boolean {
      if (prop === 'constructor' || prop === '__proto__') return false;
      return Reflect.has(target, prop);
    },
    apply(target: (...args: unknown[]) => unknown, _thisArg: unknown, args: unknown[]): unknown {
      // `this` binds to the ORIGINAL host target — realm code can never
      // smuggle a hostile receiver into a host function.
      return neutralize(Reflect.apply(target, target, args));
    },
    construct(target: new (...args: unknown[]) => object, args: unknown[]): object {
      return neutralize(Reflect.construct(target, args)) as object;
    },
  });
}

// ---------------------------------------------------------------------------
// The guarded recording fetch (the ONLY network the module can reach)
// ---------------------------------------------------------------------------

type FetchBudget = {
  requests: number;
  totalBytes: number;
};

export type SandboxFetchDeps = {
  fetcher?: typeof fetch;
  dnsResolver?: SafeDnsResolver;
  /** TMDB stub data (title/year/imdbId per test input — deterministic analysis). */
  tmdbStub?: { title: string; year?: number; name?: string; imdbId?: string | null };
};

const TMDB_HOST = 'api.themoviedb.org';
const SANDBOX_FETCH_TIMEOUT_MS = 15_000;
const MAX_HEADER_NAME_LENGTH = 64;

/** Allowlisted request headers recorded for the compiler (never auth/cookies). */
const RECORDED_HEADER_ALLOWLIST = new Set([
  'user-agent',
  'referer',
  'accept',
  'accept-language',
  'x-requested-with',
]);

/** Extracts the sanitized header map + header-name list from an init record. */
function sanitizeRequestHeaders(headerSource: unknown): {
  names: string[];
  sanitized: Record<string, string>;
} {
  const names: string[] = [];
  const sanitized: Record<string, string> = {};
  if (headerSource !== null && typeof headerSource === 'object') {
    for (const [name, value] of Object.entries(headerSource as Record<string, unknown>)) {
      if (name.length > MAX_HEADER_NAME_LENGTH) continue;
      names.push(name);
      const lower = name.toLowerCase();
      if (RECORDED_HEADER_ALLOWLIST.has(lower) && typeof value === 'string' && value.length > 0 && value.length <= 512) {
        sanitized[lower] = value;
      }
    }
  }
  return { names, sanitized };
}

/** Top-level JSON keys whose values are http(s) URLs → { key, valueHost }. */
function extractJsonUrlKeys(text: string): Array<{ key: string; valueHost: string }> {
  const result: Array<{ key: string; valueHost: string }> = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (result.length >= 16) break;
    if (key.length > 60) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) continue;
    try {
      const host = new URL(trimmed).hostname;
      if (host.length > 0 && host.length <= 200) result.push({ key, valueHost: host });
    } catch {
      // not a parseable URL — skip
    }
  }
  return result;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const buffer = await response.arrayBuffer();
  const truncated = buffer.byteLength > maxBytes;
  const slice = truncated ? buffer.slice(0, maxBytes) : buffer;
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), bytes: buffer.byteLength, truncated };
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// The instrumented cheerio (records selector ops per document)
// ---------------------------------------------------------------------------

// The real cheerio is loaded lazily so the Builder only requires it when a
// Nuvio analysis actually needs it (host-side only — never inside the realm).
type CheerioApi = ReturnType<(typeof import('cheerio'))['load']>;

/**
 * Wraps one loaded cheerio document so EVERY top-level collection
 * operation records (docDigest, op, selector/attr, count) for the
 * compiler, while delegating to real cheerio. The wrapper object itself
 * is handed to the realm NEUTRALIZED (host bridge).
 */
function instrumentCheerioDocument($: CheerioApi, docDigest: string, cheerioRecorder: SandboxCheerioRecord[]) {
  const record = (op: 'select' | 'find', selector: string, resultCount: number) => {
    if (cheerioRecorder.length < 512) {
      cheerioRecorder.push({ docDigest, op, selector: selector.slice(0, 256), attr: null, resultCount });
    }
  };
  const wrapped = ((selector: unknown, ...rest: unknown[]) => {
    const selectorText = typeof selector === 'string' ? selector : '<fn>';
    const collection = ($ as unknown as (selector: unknown, ...rest: unknown[]) => CheerioApi)(selector, ...rest);
    const length = (collection as unknown as { length?: number }).length ?? 0;
    record('select', selectorText, Number(length));
    return collection;
  }) as unknown as CheerioApi;
  // Preserve the documented static API of a loaded document.
  for (const staticMethod of ['html', 'text', 'root', 'contains', 'load', 'serialize'] as const) {
    const value = ($ as unknown as Record<string, unknown>)[staticMethod];
    if (typeof value === 'function') {
      (wrapped as unknown as Record<string, unknown>)[staticMethod] = value.bind($);
    }
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// The sandbox run
// ---------------------------------------------------------------------------

export type SandboxRunResult = {
  getStreams: ((...args: unknown[]) => Promise<unknown>) | null;
  trace: SandboxTrace;
  context: vm.Context;
  dispose: () => void;
};

/**
 * Prepares the sandbox realm: neutralized host bridges, realm-internal
 * response factory, module/exports capture, instrumented cheerio, and the
 * guarded recording fetch (with the deterministic TMDB stub).
 */
export async function createModuleSandbox(
  moduleSource: string,
  request: AdapterBuildRequest,
  limits: BuilderLimits,
  deps: SandboxFetchDeps = {},
): Promise<SandboxRunResult> {
  const fetchRecords: SandboxFetchRecord[] = [];
  const cheerioRecords: SandboxCheerioRecord[] = [];
  const consoleRecords: SandboxConsoleRecord[] = [];
  const budget: FetchBudget = { requests: 0, totalBytes: 0 };
  const deadline = Date.now() + limits.buildTimeoutMs;
  const dnsResolver = deps.dnsResolver ?? systemDnsResolver;
  const fetcher = deps.fetcher ?? cloudStreamSafeFetch;

  // --- the guarded fetch (host side; exposed to the realm neutralized) ---
  const guardedFetch = async (input: unknown, init?: unknown): Promise<unknown> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input ?? '');
    const initRecord = (init ?? {}) as { method?: string; headers?: unknown; redirect?: string };
    const method = typeof initRecord.method === 'string' ? initRecord.method.toUpperCase() : 'GET';

    // Budget checks (closed failures, never internals).
    if (budget.requests >= limits.maxNetworkRequests) {
      throw new SandboxError('SANDBOX_BUDGET_EXCEEDED', 'The provider exceeded the network request budget.');
    }
    if (Date.now() > deadline) {
      throw new SandboxError('SANDBOX_TIMEOUT', 'The analysis exceeded its build budget.');
    }
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
      throw new SandboxError('SANDBOX_INVALID_MODULE', 'The provider attempted an invalid request.');
    }

    // Header passthrough (names recorded only; values bounded).
    const outboundHeaders: Record<string, string> = {};
    const headerSource = initRecord.headers;
    const { names: headerNames, sanitized: sanitizedHeaders } = sanitizeRequestHeaders(headerSource);
    if (headerSource !== null && typeof headerSource === 'object') {
      for (const [name, value] of Object.entries(headerSource as Record<string, unknown>)) {
        if (name.length > MAX_HEADER_NAME_LENGTH) continue;
        if (typeof value !== 'string' || value.length > 512) continue;
        outboundHeaders[name] = value;
      }
    }

    let url: URL;
    try {
      url = assertSafeManifestUrl(rawUrl);
    } catch {
      throw new SandboxError('SANDBOX_INVALID_MODULE', 'The provider attempted an invalid URL.');
    }

    // Deterministic TMDB stub (the analysis NEVER depends on live TMDB).
    if (url.hostname === TMDB_HOST) {
      const stubTitle = deps.tmdbStub?.title ?? request.test.movie.title;
      const stubYear = deps.tmdbStub?.year ?? request.test.movie.year;
      // A REALISTIC imdb id (from the test case): providers of the
      // moviesdrive family search by imdb id — a null stub would send them
      // down a different (unrepresentative) code path.
      const stubImdb = deps.tmdbStub?.imdbId ?? request.test.movie.imdbId ?? null;
      const stub = JSON.stringify({
        title: stubTitle,
        name: stubTitle,
        release_date: stubYear !== undefined ? `${stubYear}-01-01` : undefined,
        first_air_date: stubYear !== undefined ? `${stubYear}-01-01` : undefined,
        external_ids: { imdb_id: stubImdb },
      });
      fetchRecords.push({
        seq: fetchRecords.length + 1,
        url: url.toString(),
        method,
        requestHeaderNames: headerNames,
        requestHeadersSanitized: {},
        status: 200,
        ok: true,
        contentType: 'application/json',
        responseBytes: stub.length,
        finalUrl: url.toString(),
        bodyDigest: digestOf(stub),
        jsonUrlKeys: [],
        stubbed: true,
        durationMs: 0,
      });
      return realmResponseFactory(url.toString(), 200, true, 'application/json', '{}', stub);
    }

    // Real fetch: two-stage SSRF guard + DNS revalidation happens inside
    // the connect-time lookup of cloudStreamSafeFetch's agent; the explicit
    // destination check below re-validates DNS + blocked ranges up front.
    try {
      await assertSafeManifestDestination(url, dnsResolver);
    } catch {
      throw new SandboxError('SANDBOX_BUDGET_EXCEEDED', 'The provider attempted a blocked destination.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SANDBOX_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = (await fetcher(url.toString(), {
        method,
        headers: outboundHeaders,
        redirect: initRecord.redirect === 'manual' ? 'manual' : 'manual',
        signal: controller.signal,
      } as RequestInit)) as Response;
    } catch {
      throw new SandboxError('SANDBOX_BUDGET_EXCEEDED', 'A provider request failed.');
    } finally {
      clearTimeout(timer);
    }

    const { text, bytes } = await readBodyCapped(response, limits.responseMaxBytes);
    budget.requests += 1;
    budget.totalBytes += bytes;
    if (budget.totalBytes > limits.totalMaxBytes) {
      throw new SandboxError('SANDBOX_BUDGET_EXCEEDED', 'The provider exceeded the total response budget.');
    }

    const headersJson = JSON.stringify(((): Record<string, string> => {
      const flat: Record<string, string> = {};
      try {
        response.headers.forEach((value, name) => { flat[name.toLowerCase()] = value.slice(0, 512); });
      } catch { /* headers unreadable */ }
      return flat;
    })());

    fetchRecords.push({
      seq: fetchRecords.length + 1,
      url: url.toString(),
      method,
      requestHeaderNames: headerNames,
      requestHeadersSanitized: sanitizedHeaders,
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      contentType: response.headers.get('content-type'),
      responseBytes: bytes,
      finalUrl: url.toString(),
      bodyDigest: digestOf(text),
      jsonUrlKeys: (response.headers.get('content-type') ?? '').includes('json') ? extractJsonUrlKeys(text) : [],
      stubbed: false,
      durationMs: 0,
    });

    return realmResponseFactory(url.toString(), response.status, response.status >= 200 && response.status < 300, response.headers.get('content-type') ?? 'text/plain', headersJson, text);
  };

  // --- create the fresh realm ---
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // NOTE: strings:false blocks eval/new Function INSIDE the realm (an
  // untrusted module cannot even generate code) — the Mavero pin, enforced
  // at the V8 level here too.

  // Realm-internal response factory (evaluated as realm code, built ONLY
  // from primitives — no host object graphs cross into the realm).
  const responseFactorySource = `
    globalThis.__makeResponse = function (url, status, ok, contentType, headersJson, bodyText) {
      var headersLower;
      try { headersLower = JSON.parse(headersJson); } catch (e) { headersLower = {}; }
      return {
        url: url, status: status, ok: ok,
        headers: {
          get: function (name) { var v = headersLower[String(name).toLowerCase()]; return v === undefined ? null : v; },
          has: function (name) { return headersLower[String(name).toLowerCase()] !== undefined; }
        },
        text: function () { return Promise.resolve(bodyText); },
        json: function () {
          try { return Promise.resolve(JSON.parse(bodyText)); }
          catch (e) { return Promise.reject(new TypeError('body is not valid JSON')); }
        }
      };
    };
    globalThis.__makeResponse;
  `;
  const realmResponseFactory = vm.runInContext(responseFactorySource, context, { timeout: 1_000 }) as (url: string, status: number, ok: boolean, contentType: string, headersJson: string, bodyText: string) => unknown;

  // Neutralized host bridges.
  //
  // PROMISE BRIDGE (the subtle one): a raw host Promise would leak its host
  // `constructor` (the classic vm escape), but a neutralize PROXY over a
  // host Promise breaks the Promise.prototype.then BRAND CHECK
  // ("incompatible receiver"). The correct construction is a REALM-NATIVE
  // function whose return value is a REALM promise that ADOPTS the host
  // promise's outcome: the module's `.then` chain runs entirely on realm
  // promises (brand checks pass, constructor chains stay realm-internal
  // where code generation is disabled), and rejections cross as REALM
  // Errors carrying the safe message only.
  const realmFetchBridgeFactory = vm.runInContext(`
    (function (hostFetch, makeError) {
      return function fetchBridge(input, init) {
        return Promise.resolve(hostFetch(input, init).catch(function (e) {
          throw makeError(String((e && e.message) || e));
        }));
      };
    })
  `, context, { timeout: 1_000 }) as (hostFetch: unknown, makeError: unknown) => (input: unknown, init?: unknown) => unknown;
  const makeRealmError = vm.runInContext('(function (m) { return new Error(m); })', context, { timeout: 1_000 }) as (message: string) => Error;
  const realmFetch = realmFetchBridgeFactory(guardedFetch, makeRealmError);

  const consoleBudget = { count: 0 };
  const sandboxConsole = {
    log: (...args: unknown[]) => recordConsole('log', args),
    warn: (...args: unknown[]) => recordConsole('warn', args),
    error: (...args: unknown[]) => recordConsole('error', args),
    info: (...args: unknown[]) => recordConsole('log', args),
    debug: (...args: unknown[]) => recordConsole('log', args),
  };
  function recordConsole(level: 'log' | 'warn' | 'error', args: unknown[]): void {
    if (consoleRecords.length >= 400 || consoleBudget.count >= 2_000) return;
    consoleBudget.count += 1;
    try {
      const text = args.map((arg) => (typeof arg === 'string' ? arg : typeof arg === 'number' || typeof arg === 'boolean' ? String(arg) : typeof arg === 'object' && arg !== null ? '[object]' : String(arg))).join(' ').slice(0, 500);
      consoleRecords.push({ level, text });
    } catch { /* console must never break the sandbox */ }
  }

  // Bounded timer bridge (providers using setTimeout keep working, but
  // timers are counted, capped and always unref'd so the process can exit).
  const timerBudget = { count: 0 };
  const sandboxSetTimeout = (handler: unknown, ms?: unknown, ...rest: unknown[]): unknown => {
    if (timerBudget.count >= 20) return 0;
    timerBudget.count += 1;
    const delay = Math.max(0, Math.min(typeof ms === 'number' ? ms : 0, 5_000));
    const callback = typeof handler === 'function' ? () => { try { (handler as () => void)(); } catch { /* swallowed */ } } : undefined;
    if (callback === undefined) return 0;
    const timer = setTimeout(callback, delay);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    return 0;
  };

  // The instrumented require: cheerio only, everything else refused.
  const cheerioLoads = new Map<string, CheerioApi>();
  let cheerioModule: unknown = null;
  const requireBridge = (name: unknown): unknown => {
    if (typeof name !== 'string') throw new Error('sandbox: invalid require');
    if (name !== 'cheerio' && name !== 'cheerio-without-node-native') {
      throw new Error('sandbox: module is not allowed');
    }
    if (cheerioModule === null) {
      const cheerio = import('cheerio') as unknown as typeof import('cheerio');
      // Synchronous require emulation: the module must already be importable.
      // The Builder preloads cheerio before creating the sandbox (see
      // runProviderAnalysis) so this path never throws in practice.
      throw new Error('sandbox: cheerio not preloaded');
    }
    return cheerioModule;
  };

  // The instrumented cheerio facade: load() wraps real cheerio.load and
  // records document digests; selector ops are recorded by the wrapped $.
  const makeCheerioFacade = (realCheerio: typeof import('cheerio')): unknown => {
    const facade = {
      load: (html: unknown): unknown => {
        if (typeof html !== 'string' || html.length === 0) {
          throw new Error('sandbox: invalid document');
        }
        const $ = realCheerio.load(html);
        const docDigest = digestOf(html.slice(0, 1_048_576));
        cheerioLoads.set(docDigest, $);
        return instrumentCheerioDocument($, docDigest, cheerioRecords);
      },
    };
    return facade;
  };

  // Bridge the preloaded cheerio (async host import resolved before run).
  const preloadCheerio = async (): Promise<void> => {
    const realCheerio = await import('cheerio');
    cheerioModule = makeCheerioFacade(realCheerio);
  };

  // Module/exports + minimal realm globals.
  vm.runInContext(`
    globalThis.module = { exports: {} };
    globalThis.exports = globalThis.module.exports;
    globalThis.global = globalThis;
    globalThis.console = undefined; // replaced with the neutralized bridge below
  `, context, { timeout: 1_000 });

  const sandboxGlobal = vm.runInContext('globalThis', context) as Record<string, unknown>;
  sandboxGlobal['fetch'] = realmFetch;
  sandboxGlobal['console'] = neutralize(sandboxConsole);
  sandboxGlobal['setTimeout'] = neutralize(sandboxSetTimeout);
  sandboxGlobal['clearTimeout'] = neutralize(() => undefined);
  sandboxGlobal['require'] = neutralize(requireBridge);
  sandboxGlobal['Buffer'] = POISON; // node Buffer is a host bridge — poisoned
  // WHATWG URL/URLSearchParams (host APIs the provider modules use to parse
  // links): crossed NEUTRALIZED — `new URL(x)` runs the real constructor with
  // realm-controlled arguments, and every produced instance is itself
  // neutralized (constructor chains poisoned; methods bound to the instance).
  sandboxGlobal['URL'] = neutralize(URL);
  sandboxGlobal['URLSearchParams'] = neutralize(URLSearchParams);

  const runResult: SandboxRunResult = {
    getStreams: null,
    trace: { fetches: fetchRecords, cheerio: cheerioRecords, console: consoleRecords, output: [], wallClockMs: 0 },
    context,
    dispose: () => { /* realm dropped with the context reference */ },
  };

  // --- execute the module source inside the realm ---
  const scan = staticScanModuleSource(moduleSource);
  if (!scan.ok) {
    throw new SandboxError('SANDBOX_FORBIDDEN_PATTERN', `The provider module requires ${scan.reason ?? 'a forbidden capability'}.`);
  }
  await preloadCheerio();
  const startedAt = Date.now();
  try {
    vm.runInContext(moduleSource, context, {
      timeout: limits.sandboxScriptTimeoutMs,
      displayErrors: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/sandbox|blocked|not allowed/.test(message)) {
      throw new SandboxError('SANDBOX_FORBIDDEN_PATTERN', 'The provider module attempted a forbidden capability.');
    }
    throw new SandboxError('SANDBOX_EXECUTION_FAILED', 'The provider module could not be evaluated.');
  }

  // --- capture getStreams from module.exports (realm-internal object) ---
  const moduleExports = vm.runInContext('globalThis.module.exports', context) as Record<string, unknown> | null;
  const candidate = moduleExports !== null && typeof moduleExports === 'object' && typeof moduleExports['getStreams'] === 'function'
    ? moduleExports['getStreams']
    : null;
  if (candidate === null) {
    throw new SandboxError('SANDBOX_INVALID_MODULE', 'The provider module does not export getStreams.');
  }
  runResult.getStreams = candidate as (...args: unknown[]) => Promise<unknown>;
  runResult.trace.wallClockMs = Date.now() - startedAt;
  return runResult;
}

// ---------------------------------------------------------------------------
// Output validation (the module's return value is untrusted data)
// ---------------------------------------------------------------------------

const MAX_OUTPUT_STREAMS = 64;
const MAX_OUTPUT_STRING = 300;

/** Validates + bounds the getStreams output shape (never trusts it). */
export function validateSandboxOutput(output: unknown): SandboxStreamOutput[] {
  if (!Array.isArray(output)) return [];
  const streams: SandboxStreamOutput[] = [];
  for (const entry of output) {
    if (streams.length >= MAX_OUTPUT_STREAMS) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
    if (url.length === 0 || url.length > 2048) continue;
    if (!/^https?:\/\//i.test(url) && !url.toLowerCase().startsWith('magnet:')) continue;
    streams.push({
      name: typeof record['name'] === 'string' ? record['name'].slice(0, MAX_OUTPUT_STRING) : null,
      title: typeof record['title'] === 'string' ? record['title'].slice(0, MAX_OUTPUT_STRING) : null,
      url,
      quality: typeof record['quality'] === 'string' ? record['quality'].slice(0, 40) : null,
      size: typeof record['size'] === 'string' ? record['size'].slice(0, 40) : null,
    });
  }
  return streams;
}

/** Runs one getStreams call inside the sandbox with the wall-clock race. */
export async function runGetStreams(
  sandbox: SandboxRunResult,
  args: [string, string, number | null, number | null],
  timeoutMs: number,
): Promise<SandboxStreamOutput[]> {
  if (sandbox.getStreams === null) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => sandbox.getStreams!(...args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SandboxError('SANDBOX_TIMEOUT', 'The provider exceeded its execution budget.')), timeoutMs);
      }),
    ]);
    const streams = validateSandboxOutput(result);
    // The validated output becomes the trace's evidence (the compiler
    // consumes it as the anti-hallucination ground truth).
    sandbox.trace.output = streams;
    return streams;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
