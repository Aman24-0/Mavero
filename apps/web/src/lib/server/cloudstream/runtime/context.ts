/**
 * MAVERO CloudStream runtime context (CS-2 — plan §25 task 4, §40.6/AC-003).
 *
 * The runtime context is the ONLY network surface adapters and extractors
 * ever see. It wires together:
 *   * the SSRF-safe HTML fetcher (`security/http.ts`, D-006 primitives),
 *   * the SSRF-safe JSON facade (`security/fetch.ts`, CS-1),
 *   * cheerio parsing,
 *   * extractor dispatch (`extractors/index.ts`),
 *   * a redaction-safe diagnostics sink,
 *   * the per-resolution deadline signal (abort propagation into every
 *     in-flight fetch).
 *
 * Adapters are stateless: one context is created PER RESOLUTION (per
 * adapter) and carries that resolution's deadline + diagnostics scope.
 * Tests inject fetchers/DNS resolvers — the normal test chain never
 * touches the real network.
 */

import * as cheerio from 'cheerio';
import type {
  CloudStreamDiagnosticEvent,
  CloudStreamDiagnosticSink,
  CloudStreamFetchOptions,
  CloudStreamHtmlResult,
  CloudStreamRedirectResult,
  CloudStreamRuntimeContext,
} from '../types/runtime';
import { fetchCloudStreamPage, fetchCloudStreamRedirect, resolveCloudStreamRedirectChain } from '../security/http';
import { fetchCloudStreamJson } from '../security/fetch';
import { runCloudStreamExtractor } from '../extractors';
import { currentBaseUrl } from './dynamic-urls';
import type { CloudStreamExtractedLink } from '../normalize/links';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

export type CloudStreamRuntimeDeps = {
  /** Adapter id owning this resolution scope (diagnostics attribution). */
  adapterId: string;
  /** The resolution deadline — every context fetch aborts with it. */
  signal: AbortSignal;
  /** Injectable fetcher (tests). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests never hit the real network). */
  dnsResolver?: SafeDnsResolver;
  /** Per-fetch timeout override (default 10s). */
  timeoutMs?: number;
  /** Per-fetch response cap override (default 2 MiB). */
  maxBytes?: number;
  /** Injectable clock (tests). */
  now?: () => number;
};

/** In-memory redaction-safe diagnostics sink (one per resolution scope). */
function createDiagnosticsSink(): CloudStreamDiagnosticSink {
  const events: CloudStreamDiagnosticEvent[] = [];
  return {
    record(event: CloudStreamDiagnosticEvent): void {
      // Hard bound: a resolution records at most 256 events (memory guard).
      if (events.length >= 256) return;
      events.push(event);
    },
    events(): readonly CloudStreamDiagnosticEvent[] {
      return [...events];
    },
  };
}

/**
 * Creates one runtime context for a resolution scope. The context is
 * deliberately inert until a fetch/parsing call is made — no network I/O
 * happens at construction time.
 */
export function createCloudStreamRuntimeContext(deps: CloudStreamRuntimeDeps): CloudStreamRuntimeContext {
  const now = deps.now ?? Date.now;
  const diagnostics = createDiagnosticsSink();

  const context: CloudStreamRuntimeContext = {
    signal: deps.signal,
    now,

    async fetchHtml(url: string, opts: CloudStreamFetchOptions = {}): Promise<CloudStreamHtmlResult> {
      const started = now();
      let success = false;
      let status: number | undefined;
      try {
        const result = await fetchCloudStreamPage(url, {
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
          ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
          signal: deps.signal,
        });
        success = true;
        status = result.status;
        return result;
      } finally {
        diagnostics.record({
          adapterId: deps.adapterId,
          stage: 'load',
          durationMs: Math.max(0, now() - started),
          success,
          ...(success ? {} : { failureCategory: 'LOAD_FAILED' }),
          ...(status !== undefined ? { httpStatus: status } : {}),
        });
      }
    },

    async fetchJson(url: string, opts: CloudStreamFetchOptions = {}): Promise<unknown> {
      const started = now();
      let success = false;
      try {
        const result = await fetchCloudStreamJson(url, {
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          // Permanent Adapter Plan Phase 1: the adapter deadline now cancels
          // JSON fetches exactly like HTML fetches (the runtime context is
          // the ONLY network surface — every path observes the deadline).
          signal: deps.signal,
        });
        success = true;
        return result.body;
      } finally {
        diagnostics.record({
          adapterId: deps.adapterId,
          stage: 'search',
          durationMs: Math.max(0, now() - started),
          success,
          ...(success ? {} : { failureCategory: 'SEARCH_FAILED' }),
        });
      }
    },

    async fetchRedirect(url: string, opts: CloudStreamFetchOptions = {}): Promise<CloudStreamRedirectResult> {
      const started = now();
      let success = false;
      let status: number | undefined;
      try {
        const result = await fetchCloudStreamRedirect(url, {
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
          signal: deps.signal,
        });
        success = true;
        status = result.status;
        return result;
      } finally {
        diagnostics.record({
          adapterId: deps.adapterId,
          stage: 'bypass',
          durationMs: Math.max(0, now() - started),
          success,
          ...(success ? {} : { failureCategory: 'LOAD_FAILED' }),
          ...(status !== undefined ? { httpStatus: status } : {}),
        });
      }
    },

    async resolveRedirects(url: string): Promise<string | null> {
      const started = now();
      let finalUrl: string | null = null;
      try {
        finalUrl = await resolveCloudStreamRedirectChain(url, {
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
          signal: deps.signal,
        });
        return finalUrl;
      } finally {
        diagnostics.record({
          adapterId: deps.adapterId,
          stage: 'bypass',
          durationMs: Math.max(0, now() - started),
          success: finalUrl !== null,
        });
      }
    },

    async resolveBaseUrl(base: string, source: string): Promise<string> {
      return currentBaseUrl(base, source, {
        ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
        ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        // Phase 1: urls.json resolution is also deadline-bound.
        signal: deps.signal,
      });
    },

    parseHtml(html: string): cheerio.CheerioAPI {
      // cheerio is server-only; the context is only ever constructed on the
      // server (this module lives under $lib/server).
      return cheerio.load(html);
    },

    async runExtractor(url: string, opts: { label?: string } = {}): Promise<CloudStreamExtractedLink[]> {
      return runCloudStreamExtractor(url, context, { adapterId: deps.adapterId, label: opts.label });
    },

    diagnostics,
  };

  return context;
}
