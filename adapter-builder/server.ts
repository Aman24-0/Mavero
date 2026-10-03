/**
 * MAVERO Adapter Builder Service — standalone HTTP entry point (plan §2/§4/§5/§7).
 *
 * A BUILD-TIME-ONLY service: it receives authorized adapter-generation
 * requests from Mavero's admin orchestration, analyzes the provider
 * (sandboxed for Nuvio, family-knowledge for CloudStream), generates the
 * constrained declarative DSL artifact, LIVE-TESTS it through the SAME
 * interpreter the Mavero runtime uses, and returns the validated artifact.
 *
 * HARD RULES (plan §3):
 *   * No Downloader 2 runtime routes exist on this service AT ALL.
 *   * Never serves stream links, never proxies provider pages.
 *   * No database, no filesystem writes, no secrets except BUILDER_SECRET.
 *
 * RUN (deployable to Render / Oracle / any host — target is configuration):
 *   BUILDER_SECRET=... pnpm exec tsx --tsconfig ./jsconfig.json adapter-builder/server.ts
 *
 * API:
 *   GET  /health  → { ok, builderVersion, uptimeSeconds }
 *   POST /build   → AdapterBuildResponse (closed error taxonomy, no stack
 *                   traces, no internal details — plan §5 auth + §14 limits)
 *
 * AUTH (plan §5):
 *   * Authorization: Bearer <shared secret> — timing-safe compare of the
 *     sha256 digests (length-independent).
 *   * Replay protection: requestId LRU (2048 entries) + requestedAt
 *     timestamp skew bound (±15 min default).
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readBuilderConfig, BUILDER_VERSION, type BuilderConfig } from './config';
import { BUILDER_CONTEXT_TIMEOUT_MS } from './context';
import {
  createModuleSandbox,
  runGetStreams,
  SandboxError,
  type SandboxFetchDeps,
  type SandboxTrace,
} from './sandbox';
import { compileNuvioSpec } from './nuvio-compiler';
import { matchCloudStreamFamily, buildFamilySpec } from './cloudstream-families';
import { createBuilderRuntimeContext } from './context';
import { lookupCloudStreamAdapterInstance } from '$lib/server/cloudstream/adapters/registry';
import {
  validateAdapterArtifact,
  canonicalArtifactId,
  type AdapterAnalysis,
  type AdapterBuilderErrorCode,
  type AdapterBuildRequest,
  type AdapterBuildResponse,
  type AdapterTestCase,
  type AdapterTestCaseResult,
  type DeclarativeAdapterSpec,
  type PermanentAdapterArtifact,
} from '$lib/shared/adapter-artifact';
import { resolveMovieWithSpec, resolveEpisodeWithSpec } from '$lib/server/extensions/builder/dsl-interpreter';
import { cloudStreamSafeFetch } from '$lib/server/cloudstream/security/http';
import { assertSafeManifestUrl } from '$lib/server/streaming/stremio/ssrf';

// ---------------------------------------------------------------------------
// Auth + replay protection
// ---------------------------------------------------------------------------

const REQUESTED_AT_SKEW_MS = 15 * 60_000;
const REPLAY_LRU_MAX = 2048;

/** LRU-ish replay window: Map insertion order + TTL eviction. */
class ReplayWindow {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}

  /** True when the id is fresh (records it). */
  admit(requestId: string, now: number): boolean {
    // Evict expired entries from the front (insertion-ordered).
    while (this.seen.size > 0) {
      const [oldestId, oldestAt] = this.seen.entries().next().value as [string, number];
      if (now - oldestAt <= this.ttlMs) break;
      this.seen.delete(oldestId);
    }
    if (this.seen.has(requestId)) return false;
    this.seen.set(requestId, now);
    if (this.seen.size > REPLAY_LRU_MAX) {
      const oldestId = this.seen.keys().next().value as string;
      this.seen.delete(oldestId);
    }
    return true;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Timing-safe bearer check (digest comparison — length independent). */
function bearerMatches(authorization: string | undefined, secret: string): boolean {
  if (secret.length === 0 || authorization === undefined) return false;
  const prefix = 'Bearer ';
  if (authorization.length < prefix.length || authorization.slice(0, prefix.length) !== prefix) return false;
  const provided = authorization.slice(prefix.length);
  return timingSafeEqual(Buffer.from(sha256Hex(provided), 'hex'), Buffer.from(sha256Hex(secret), 'hex'));
}

// ---------------------------------------------------------------------------
// Request validation (bounded shape — never trusts input)
// ---------------------------------------------------------------------------

function validateBuildRequest(body: unknown): { ok: true; request: AdapterBuildRequest } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'The build request must be a JSON object.' };
  }
  const raw = body as Record<string, unknown>;
  for (const field of ['requestId', 'requestedAt'] as const) {
    if (typeof raw[field] !== 'string' || (raw[field] as string).length === 0 || (raw[field] as string).length > 128) {
      return { ok: false, message: 'The build request identity fields are invalid.' };
    }
  }
  if (raw['integrationType'] !== 'cloudstream' && raw['integrationType'] !== 'nuvio') {
    return { ok: false, message: 'The integration type must be cloudstream or nuvio.' };
  }
  const provider = raw['provider'];
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    return { ok: false, message: 'The provider block is required.' };
  }
  const p = provider as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || p['id'].length === 0 || p['id'].length > 200) {
    return { ok: false, message: 'The provider id is invalid.' };
  }
  if (typeof p['mediaTypes'] !== 'object' || !Array.isArray(p['mediaTypes']) || p['mediaTypes'].length === 0 || p['mediaTypes'].length > 2) {
    return { ok: false, message: 'The provider media types are invalid.' };
  }
  for (const mediaType of p['mediaTypes'] as unknown[]) {
    if (mediaType !== 'movie' && mediaType !== 'tv') {
      return { ok: false, message: 'The provider media types are invalid.' };
    }
  }
  const test = raw['test'];
  if (test === null || typeof test !== 'object' || Array.isArray(test)) {
    return { ok: false, message: 'The test block is required.' };
  }
  const t = test as Record<string, unknown>;
  const movie = t['movie'];
  if (movie === null || typeof movie !== 'object' || Array.isArray(movie)) {
    return { ok: false, message: 'The movie test case is required.' };
  }
  const m = movie as Record<string, unknown>;
  if (typeof m['tmdbId'] !== 'string' || m['tmdbId'].length === 0 || m['tmdbId'].length > 32) {
    return { ok: false, message: 'The movie test case tmdbId is invalid.' };
  }
  if (typeof m['title'] !== 'string' || m['title'].length === 0 || m['title'].length > 200) {
    return { ok: false, message: 'The movie test case title is invalid.' };
  }
  if (m['year'] !== undefined && (typeof m['year'] !== 'number' || !Number.isInteger(m['year']) || (m['year'] as number) < 1900 || (m['year'] as number) > 2100)) {
    return { ok: false, message: 'The movie test case year is invalid.' };
  }
  if (m['imdbId'] !== undefined && (typeof m['imdbId'] !== 'string' || (m['imdbId'] as string).length > 32)) {
    return { ok: false, message: 'The movie test case imdbId is invalid.' };
  }
  if (t['episode'] !== null && t['episode'] !== undefined) {
    const episode = t['episode'];
    if (episode === null || typeof episode !== 'object' || Array.isArray(episode)) {
      return { ok: false, message: 'The episode test case is invalid.' };
    }
    const e = episode as Record<string, unknown>;
    if (typeof e['tmdbId'] !== 'string' || e['tmdbId'].length === 0 || e['tmdbId'].length > 32
      || typeof e['title'] !== 'string' || e['title'].length === 0 || e['title'].length > 200
      || typeof e['season'] !== 'number' || !Number.isInteger(e['season']) || (e['season'] as number) < 1 || (e['season'] as number) > 100
      || typeof e['episode'] !== 'number' || !Number.isInteger(e['episode']) || (e['episode'] as number) < 1 || (e['episode'] as number) > 1000) {
      return { ok: false, message: 'The episode test case is invalid.' };
    }
  }
  if (typeof raw['requestedAdapterVersion'] !== 'number' || !Number.isInteger(raw['requestedAdapterVersion']) || (raw['requestedAdapterVersion'] as number) < 1 || (raw['requestedAdapterVersion'] as number) > 1_000_000) {
    return { ok: false, message: 'The requested adapter version is invalid.' };
  }
  return { ok: true, request: body as AdapterBuildRequest };
}

// ---------------------------------------------------------------------------
// Nuvio module fetching (bounded + SSRF-guarded)
// ---------------------------------------------------------------------------

async function fetchNuvioModuleSource(
  moduleUrl: string | null | undefined,
  config: BuilderConfig,
  deps: BuilderExecuteDeps = {},
): Promise<{ source: string; sourceRevision: string }> {
  // NOTE: JSON bodies may omit the key entirely (undefined) as well as send
  // null — both are the same honest "missing source" (never a 500).
  if (moduleUrl == null || moduleUrl.length === 0) {
    throw new BuildFailure('BUILD_SOURCE_UNAVAILABLE', 'The provider module URL is missing.');
  }
  let url: URL;
  try {
    url = assertSafeManifestUrl(moduleUrl);
  } catch {
    throw new BuildFailure('BUILD_SOURCE_UNAVAILABLE', 'The provider module URL is not a safe http(s) URL.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const fetcher = deps.fetcher ?? cloudStreamSafeFetch;
    const response = await fetcher(url.toString(), { signal: controller.signal } as RequestInit) as Response;
    if (!response.ok) {
      throw new BuildFailure('BUILD_SOURCE_UNAVAILABLE', 'The provider module could not be downloaded.');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > config.limits.moduleMaxBytes) {
      throw new BuildFailure('BUILD_RESOURCE_LIMIT', 'The provider module exceeds the size limit.');
    }
    const source = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (source.trim().length === 0) {
      throw new BuildFailure('BUILD_SOURCE_UNAVAILABLE', 'The provider module is empty.');
    }
    return { source, sourceRevision: sha256Hex(source) };
  } catch (error) {
    if (error instanceof BuildFailure) throw error;
    throw new BuildFailure('BUILD_SOURCE_UNAVAILABLE', 'The provider module could not be downloaded.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Build error (closed taxonomy; converts sandbox errors too)
// ---------------------------------------------------------------------------

export class BuildFailure extends Error {
  readonly code: AdapterBuilderErrorCode;
  readonly verdict?: 'REQUIRES_RUNTIME' | 'UNSUPPORTED';
  constructor(code: AdapterBuilderErrorCode, message: string, verdict?: 'REQUIRES_RUNTIME' | 'UNSUPPORTED') {
    super(message);
    this.name = 'BuildFailure';
    this.code = code;
    if (verdict !== undefined) this.verdict = verdict;
  }
}

function sandboxErrorToBuildFailure(error: SandboxError): BuildFailure {
  switch (error.code) {
    case 'SANDBOX_FORBIDDEN_PATTERN':
      return new BuildFailure('BUILD_INVALID_REQUEST', 'The provider module requires a capability the builder refuses to host.', 'UNSUPPORTED');
    case 'SANDBOX_BUDGET_EXCEEDED':
      return new BuildFailure('BUILD_RESOURCE_LIMIT', 'The provider exceeded its analysis budget.');
    case 'SANDBOX_TIMEOUT':
      return new BuildFailure('BUILD_TIMEOUT', 'The provider exceeded its analysis timeout.');
    case 'SANDBOX_INVALID_MODULE':
      return new BuildFailure('BUILD_UNSUPPORTED_PROVIDER', 'The provider module does not expose the expected interface.', 'UNSUPPORTED');
    default:
      return new BuildFailure('BUILD_GENERATION_FAILED', 'The provider module could not be analyzed.');
  }
}

// ---------------------------------------------------------------------------
// Live test (the shared interpreter + builder context — test-what-you-ship)
// ---------------------------------------------------------------------------

type LiveTestCase = {
  movie: AdapterTestCase;
  episode: AdapterTestCase | null;
};

async function runLiveTest(
  spec: DeclarativeAdapterSpec,
  adapterId: string,
  cases: LiveTestCase,
  timeoutMs: number,
  expectedOutputUrls: string[] | null,
  deps: BuilderExecuteDeps = {},
): Promise<{ cases: AdapterTestCaseResult[]; passed: boolean; antiHallucination: boolean }> {
  // Each case is individually bounded by its own controller+timer below
  // (movie: timeoutMs; episode: timeoutMs) — the total is therefore bounded
  // at 2×timeoutMs. (Phase 5 cleanup: the previous version constructed an
  // additional overall AbortController whose signal nothing consumed — dead
  // decoration, removed.)
  const results: AdapterTestCaseResult[] = [];
  let passed = true;
  let antiHallucination = true;

  try {
    // Movie case (always required).
    {
      const controller = new AbortController();
      const movieTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const ctx = createBuilderRuntimeContext({
          adapterId,
          signal: controller.signal,
          timeoutMs: BUILDER_CONTEXT_TIMEOUT_MS,
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
        });
        const startedAt = Date.now();
        const result = await resolveMovieWithSpec(spec, {
          tmdbId: cases.movie.tmdbId,
          title: cases.movie.title,
          ...(cases.movie.year !== undefined ? { year: cases.movie.year } : {}),
          deadline: controller.signal,
        }, ctx, {
          adapterId,
          displayName: spec.output.sourceName,
          sourceName: spec.output.sourceName,
        });
        const linksFound = result.links.length;
        const casePassed = linksFound > 0;
        if (!casePassed) passed = false;
        // Anti-hallucination: when the module's observed outputs are known,
        // the interpreted result must OVERLAP them — exact URL, same host, or
        // the same REGISTRABLE LABEL (the module's own extraction chain and
        // the Mavero-owned extractor registry legitimately land on sibling
        // domains of the same service: pixeldrain.com vs pixeldrain.dev).
        if (expectedOutputUrls !== null && expectedOutputUrls.length > 0) {
          const hostLabel = (value: string): string => {
            try {
              const parts = new URL(value).hostname.split('.');
              return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
            } catch {
              return '';
            }
          };
          const overlap = result.links.some((link) =>
            expectedOutputUrls.some((expected) => {
              if (link.url === expected) return true;
              try {
                const linkHost = new URL(link.url).hostname;
                const expectedHost = new URL(expected).hostname;
                if (linkHost === expectedHost) return true;
                return hostLabel(link.url) !== '' && hostLabel(link.url) === hostLabel(expected);
              } catch {
                return false;
              }
            }),
          );
          if (!overlap) antiHallucination = false;
        }
        results.push({
          kind: 'movie',
          passed: casePassed,
          note: casePassed ? null : 'The generated adapter found no links for the representative movie case.',
          linksFound,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      } finally {
        clearTimeout(movieTimer);
      }
    }

    // Episode case (only when the spec has an episode block AND a case exists).
    if (spec.episode !== undefined && cases.episode !== null) {
      const controller = new AbortController();
      const episodeTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const ctx = createBuilderRuntimeContext({
          adapterId,
          signal: controller.signal,
          timeoutMs: BUILDER_CONTEXT_TIMEOUT_MS,
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
        });
        const startedAt = Date.now();
        const result = await resolveEpisodeWithSpec(spec, {
          tmdbId: cases.episode.tmdbId,
          title: cases.episode.title,
          year: cases.episode.year,
          deadline: controller.signal,
          season: cases.episode.season!,
          episode: cases.episode.episode!,
        }, ctx, {
          adapterId,
          displayName: spec.output.sourceName,
          sourceName: spec.output.sourceName,
        });
        const linksFound = result.links.length;
        const casePassed = linksFound > 0;
        if (!casePassed) passed = false;
        results.push({
          kind: 'episode',
          passed: casePassed,
          note: casePassed ? null : 'The generated adapter found no links for the representative episode case.',
          linksFound,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      } finally {
        clearTimeout(episodeTimer);
      }
    } else if (spec.episode !== undefined && cases.episode === null) {
      // Spec claims tv support but no episode case was supplied — the tv
      // claim cannot be verified, so demote at assembly time (below).
    }
  } finally {
    // The per-case timers were cleared in their own finally blocks; nothing
    // else leaks (the removed overall controller owned no resources).
  }

  return { cases: results, passed, antiHallucination };
}

// ---------------------------------------------------------------------------
// The build pipeline
// ---------------------------------------------------------------------------

export type BuilderExecuteDeps = {
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests). */
  dnsResolver?: import('$lib/server/streaming/stremio/ssrf').SafeDnsResolver;
};

export async function executeBuild(
  request: AdapterBuildRequest,
  config: BuilderConfig,
  deps: BuilderExecuteDeps = {},
): Promise<AdapterBuildResponse> {
  const adapterId = canonicalArtifactId(request.integrationType, request.provider.id);

  // ---------------------------------------------------------------------
  // CloudStream: family knowledge base (.cs3 is NEVER fetched/executed).
  // ---------------------------------------------------------------------
  if (request.integrationType === 'cloudstream') {
    // Native precedence defense-in-depth (plan §16): the exact native ids
    // are refused by the Builder too, not only by Mavero's orchestration.
    if (lookupCloudStreamAdapterInstance(request.provider.id) !== null) {
      throw new BuildFailure('BUILD_UNSUPPORTED_PROVIDER', 'A native Mavero adapter already exists for this provider.', 'REQUIRES_RUNTIME');
    }
    const family = matchCloudStreamFamily(request.provider.id);
    if (family === null) {
      throw new BuildFailure(
        'BUILD_UNSUPPORTED_PROVIDER',
        'This CloudStream provider cannot be analyzed server-side; the .cs3 plugin requires the native CloudStream runtime.',
        'REQUIRES_RUNTIME',
      );
    }
    let spec = buildFamilySpec(family, request.provider.name ?? request.provider.id);
    let mediaTypes: Array<'movie' | 'tv'> = ['movie', 'tv'];
    let verdict: AdapterAnalysis['verdict'] = 'SUPPORTED';

    // Live test BOTH cases; a failing episode case demotes coverage honestly.
    const test = await runLiveTest(spec, adapterId, {
      movie: request.test.movie,
      episode: request.test.episode,
    }, config.limits.testTimeoutMs, null, deps);
    if (!test.passed) {
      // Retry demoted (movie-only) before failing outright — episode walks
      // are the brittle part of clone sites.
      if (test.cases.some((result) => result.kind === 'episode' && !result.passed)) {
        const demoted: DeclarativeAdapterSpec = { ...spec };
        delete (demoted as { episode?: unknown }).episode;
        const demotedTest = await runLiveTest(demoted, adapterId, { movie: request.test.movie, episode: null }, config.limits.testTimeoutMs, null, deps);
        if (demotedTest.passed) {
          spec = demoted;
          mediaTypes = ['movie'];
          verdict = 'PARTIALLY_SUPPORTED';
          return assembleArtifact(request, spec, adapterId, {
            verdict,
            notes: `${family.label}: episode resolution did not pass the live test; the adapter covers movies only (honest partial coverage).`,
            endpoints: familyEndpoints(family),
            sourceRevision: '',
            analyzedAt: new Date().toISOString(),
          }, { cases: demotedTest.cases, passed: true, testedAt: new Date().toISOString() }, mediaTypes, config);
        }
      }
      throw new BuildFailure('BUILD_TEST_FAILED', 'The generated adapter did not pass the live test against this provider.');
    }
    return assembleArtifact(request, spec, adapterId, {
      verdict,
      notes: `${family.label}: DSL generated from the source-verified family template and live-tested.`,
      endpoints: familyEndpoints(family),
      sourceRevision: '',
      analyzedAt: new Date().toISOString(),
    }, { cases: test.cases, passed: true, testedAt: new Date().toISOString() }, mediaTypes, config);
  }

  // ---------------------------------------------------------------------
  // Nuvio: bounded module fetch → sandbox analysis → trace compilation →
  // live verification through the shared interpreter.
  // ---------------------------------------------------------------------
  const { source, sourceRevision } = await fetchNuvioModuleSource(request.provider.moduleUrl, config, deps);

  const tmdbStub = {
    title: request.test.movie.title,
    ...(request.test.movie.year !== undefined ? { year: request.test.movie.year } : {}),
    ...(request.test.movie.imdbId !== undefined ? { imdbId: request.test.movie.imdbId } : {}),
  };
  const sandboxDeps: SandboxFetchDeps = {
    tmdbStub,
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
  };

  let trace: SandboxTrace;
  try {
    const sandbox = await createModuleSandbox(source, request, config.limits, sandboxDeps);
    try {
      await runGetStreams(sandbox, [request.test.movie.tmdbId, 'movie', null, null], config.limits.buildTimeoutMs);
      trace = sandbox.trace;
    } finally {
      sandbox.dispose();
    }
  } catch (error) {
    if (error instanceof SandboxError) throw sandboxErrorToBuildFailure(error);
    throw new BuildFailure('BUILD_GENERATION_FAILED', 'The provider module could not be analyzed.');
  }

  // Compile the DSL from the observed trace (evidence-based).
  const compile = await compileNuvioSpec(request, trace, {
    refetchJson: async (url, headers) => {
      const ctx = createBuilderRuntimeContext({
        adapterId,
        signal: new AbortController().signal,
        ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
        ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
      });
      return ctx.fetchJson(url, headers !== undefined ? { headers } : undefined);
    },
    refetchHtml: async (url, headers) => {
      const ctx = createBuilderRuntimeContext({
        adapterId,
        signal: new AbortController().signal,
        ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
        ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
      });
      const page = await ctx.fetchHtml(url, headers !== undefined ? { headers } : undefined);
      return page.html;
    },
    parseHtml: (html) => {
      const ctx = createBuilderRuntimeContext({ adapterId, signal: new AbortController().signal });
      return ctx.parseHtml(html);
    },
  });
  if (!compile.ok) {
    throw new BuildFailure('BUILD_UNSUPPORTED_PROVIDER', compile.reason, compile.verdict);
  }

  // Live test + anti-hallucination through the shared interpreter.
  const test = await runLiveTest(compile.spec, adapterId, {
    movie: request.test.movie,
    episode: null,
  }, config.limits.testTimeoutMs, compile.evidence.outputUrls, deps);
  if (!test.passed || !test.antiHallucination) {
    throw new BuildFailure('BUILD_TEST_FAILED', 'The compiled adapter did not reproduce the provider behavior in live verification.');
  }

  const endpoints: AdapterAnalysis['endpoints'] = compile.evidence.domainsDocument !== null
    ? [
        { host: hostOf(compile.evidence.searchUrl), purpose: 'search' as const },
        ...(compile.evidence.detailUrl !== null ? [{ host: hostOf(compile.evidence.detailUrl), purpose: 'detail' as const }] : []),
        { host: hostOf(compile.evidence.domainsDocument), purpose: 'domains-config' as const },
      ]
    : [
        { host: hostOf(compile.evidence.searchUrl), purpose: 'search' as const },
        ...(compile.evidence.detailUrl !== null ? [{ host: hostOf(compile.evidence.detailUrl), purpose: 'detail' as const }] : []),
      ];

  return assembleArtifact(request, compile.spec, adapterId, {
    verdict: compile.verdict,
    notes: compile.notes,
    endpoints: endpoints.slice(0, 8),
    sourceRevision,
    analyzedAt: new Date().toISOString(),
  }, { cases: test.cases, passed: true, testedAt: new Date().toISOString() }, ['movie'], config);
}

function familyEndpoints(family: { fallbackUrl: string; dynamicKey: string }): AdapterAnalysis['endpoints'] {
  return [
    { host: hostOf(family.fallbackUrl), purpose: 'search' },
    { host: 'raw.githubusercontent.com', purpose: 'domains-config' },
  ];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/** Assembles + validates the final artifact (never returns an invalid one). */
function assembleArtifact(
  request: AdapterBuildRequest,
  spec: DeclarativeAdapterSpec,
  adapterId: string,
  analysis: AdapterAnalysis,
  testReport: { cases: AdapterTestCaseResult[]; passed: boolean; testedAt: string },
  mediaTypes: Array<'movie' | 'tv'>,
  _config: BuilderConfig,
): AdapterBuildResponse {
  const artifact: PermanentAdapterArtifact = {
    schemaVersion: 1,
    kind: 'permanent-adapter',
    strategy: 'declarative',
    adapterId,
    integrationType: request.integrationType,
    providerId: request.provider.id,
    providerName: request.provider.name,
    adapterVersion: request.requestedAdapterVersion,
    generatedAt: new Date().toISOString(),
    sourceUrl: request.integrationType === 'nuvio' ? request.provider.moduleUrl : request.provider.pluginUrl,
    mediaTypes,
    language: request.provider.language,
    spec,
    analysis,
    testReport,
    builderVersion: BUILDER_VERSION,
  };
  const issues = validateAdapterArtifact(artifact);
  if (issues.length > 0) {
    throw new BuildFailure('BUILD_VALIDATION_FAILED', 'The generated artifact did not pass schema validation.');
  }
  return { ok: true, result: { analysis, artifact }, builderVersion: BUILDER_VERSION };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function jsonResponse(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Reads the request body with a hard cap; discards (drains) over-cap bytes. */
function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<
  { ok: true; body: Buffer } | { ok: false; code: AdapterBuilderErrorCode; message: string }
> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return; // keep draining (bounded by the transport + kill timer)
      total += chunk.length;
      if (total > maxBytes) {
        over = true;
        resolve({ ok: false, code: 'BUILD_RESOURCE_LIMIT', message: 'The request body exceeds the size limit.' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on('error', () => {
      if (!over) resolve({ ok: false, code: 'BUILD_INVALID_REQUEST', message: 'The request body could not be read.' });
    });
  });
}

/** Post-response drain for rejected bodies: lets well-behaved clients finish
 * writing, cuts streamers after a short grace period. */
function drainRejectedBody(req: http.IncomingMessage): void {
  req.resume();
  const killTimer = setTimeout(() => req.destroy(), 2_000);
  req.on('end', () => clearTimeout(killTimer));
  req.on('close', () => clearTimeout(killTimer));
}

export function createBuilderServer(config: BuilderConfig): http.Server {
  const replay = new ReplayWindow(config.limits.replayWindowMs);
  const startedAt = Date.now();

  return http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;

    // Health: unauthenticated, minimal, no secrets.
    if (req.method === 'GET' && url === '/health') {
      jsonResponse(res, 200, { ok: true, builderVersion: BUILDER_VERSION, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
      return;
    }

    if (req.method !== 'POST' || url !== '/build') {
      jsonResponse(res, 404, { ok: false, error: { code: 'BUILD_INVALID_REQUEST', message: 'Unknown route.' }, builderVersion: BUILDER_VERSION });
      return;
    }

    // Auth (before reading the body — unauthorized requests get no service).
    if (!bearerMatches(req.headers['authorization'], config.secret)) {
      jsonResponse(res, 401, { ok: false, error: { code: 'BUILD_INVALID_REQUEST', message: 'Unauthorized.' }, builderVersion: BUILDER_VERSION });
      return;
    }

    const handle = async (): Promise<void> => {
      const bodyResult = await readBodyCapped(req, config.limits.bodyMaxBytes);
      if (!bodyResult.ok) {
        const status = bodyResult.code === 'BUILD_RESOURCE_LIMIT' ? 413 : 400;
        jsonResponse(res, status, {
          ok: false,
          error: { code: bodyResult.code, message: bodyResult.message },
          builderVersion: BUILDER_VERSION,
        });
        drainRejectedBody(req);
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyResult.body.toString('utf8'));
      } catch {
        jsonResponse(res, 400, {
          ok: false,
          error: { code: 'BUILD_INVALID_REQUEST', message: 'The request body is not valid JSON.' },
          builderVersion: BUILDER_VERSION,
        });
        return;
      }

      const validated = validateBuildRequest(parsedBody);
      if (!validated.ok) {
        jsonResponse(res, 400, {
          ok: false,
          error: { code: 'BUILD_INVALID_REQUEST', message: validated.message },
          builderVersion: BUILDER_VERSION,
        });
        return;
      }
      const request = validated.request;

      // Replay window + timestamp skew (plan §5 anti-replay).
      const requestedAt = Date.parse(request.requestedAt);
      if (!Number.isFinite(requestedAt) || Math.abs(Date.now() - requestedAt) > REQUESTED_AT_SKEW_MS) {
        jsonResponse(res, 400, {
          ok: false,
          error: { code: 'BUILD_INVALID_REQUEST', message: 'The request timestamp is outside the allowed window.' },
          builderVersion: BUILDER_VERSION,
        });
        return;
      }
      if (!replay.admit(`${request.requestId}:${sha256Hex(JSON.stringify(parsedBody)).slice(0, 32)}`, Date.now())) {
        jsonResponse(res, 409, {
          ok: false,
          error: { code: 'BUILD_INVALID_REQUEST', message: 'This request was already processed.' },
          builderVersion: BUILDER_VERSION,
        });
        return;
      }

      // The build runs under the overall deadline race.
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const buildPromise = executeBuild(request, config);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new BuildFailure('BUILD_TIMEOUT', 'The build exceeded its overall budget.')), config.limits.buildTimeoutMs);
        });
        const response = await Promise.race([buildPromise, timeoutPromise]);
        jsonResponse(res, 200, response as unknown as Record<string, unknown>);
      } catch (error) {
        const failure = error instanceof BuildFailure
          ? error
          : new BuildFailure('BUILD_INTERNAL_ERROR', 'The build failed unexpectedly.');
        const status = failure.code === 'BUILD_TIMEOUT' ? 504
          : failure.code === 'BUILD_INTERNAL_ERROR' ? 500
          : failure.code === 'BUILD_RESOURCE_LIMIT' ? 413
          : failure.code === 'BUILD_SOURCE_UNAVAILABLE' ? 502
          : 422;
        jsonResponse(res, status, {
          ok: false,
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.verdict !== undefined ? { verdict: failure.verdict } : {}),
          },
          builderVersion: BUILDER_VERSION,
        });
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
    };

    handle().catch(() => {
      jsonResponse(res, 500, {
        ok: false,
        error: { code: 'BUILD_INTERNAL_ERROR', message: 'The build failed unexpectedly.' },
        builderVersion: BUILDER_VERSION,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startBuilderServer(config: BuilderConfig): http.Server {
  const server = createBuilderServer(config);
  server.listen(config.port, () => {
    console.info(`[MaveroAdapterBuilder] listening on :${config.port} (version ${BUILDER_VERSION})`);
  });
  return server;
}

// Standalone entry (skipped when imported by tests).
if (process.env['MAVERO_BUILDER_STANDALONE'] === '1' || (process.argv[1] ?? '').endsWith('server.ts')) {
  const config = readBuilderConfig();
  if (config.secret.length === 0) {
    console.error('[MaveroAdapterBuilder] BUILDER_SECRET is required — refusing to start.');
    process.exit(1);
  }
  startBuilderServer(config);
}
