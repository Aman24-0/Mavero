/**
 * MAVERO — Test Provider backend (Permanent Adapter Plan Phase 3 — plan §15/§9).
 *
 * The admin "Test Provider" action for CloudStream AND Nuvio extensions:
 * binds the extension's EXECUTABLE adapter (native code registry first,
 * then the generated artifact registry — plan §16 precedence) and runs a
 * bounded representative resolution through the STANDARD resolver machinery
 * (the same bounded orchestrator, deadlines, diagnostics and normalization
 * Downloader 2 uses). Results surface as normalized link views + the
 * last_tested_at / last_test_error bookkeeping on the extension row.
 *
 * The test NEVER requires the normal Downloader 2 user flow (plan §9) and
 * NEVER contacts the external Builder (test-what-you-ship: native and
 * generated adapters are tested identically, locally, server-side).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { MaveroCloudStreamAdapter } from '$lib/server/cloudstream/types/runtime';
import type { CloudStreamDownloadLinkView, ProviderTestCaseView, ProviderTestResultView } from '$lib/shared/cloudstream-types';
import { resolveCloudStream } from '$lib/server/cloudstream/resolver/service';
import { executableAdapterForExtension } from '$lib/server/extensions/adapter-registry';
import { generatedAdapterFromArtifactRow, type GeneratedAdapterArtifactRow } from './generated-registry';
import type { SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';

export type { ProviderTestCaseView, ProviderTestResultView };

type CloudStreamClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Test inputs (representative cases — plan §8: known TMDB ids; TV with
// season + episode)
// ---------------------------------------------------------------------------

export type ProviderTestMovieInput = {
  tmdbId: string;
  title: string;
  year?: number;
  imdbId?: string;
};

export type ProviderTestEpisodeInput = ProviderTestMovieInput & {
  season: number;
  episode: number;
};

export type ProviderTestInputs = {
  movie: ProviderTestMovieInput;
  episode: ProviderTestEpisodeInput | null;
};

/**
 * The default representative cases (plan §8 "use several known TMDB IDs" —
 * one universally-indexed movie; the admin can override per test run). The
 * imdb id matters: moviesdrive-family providers search by it.
 */
export const DEFAULT_TEST_INPUTS: ProviderTestInputs = {
  movie: { tmdbId: '27205', title: 'Inception', year: 2010, imdbId: 'tt1375666' },
  episode: null,
};

/** Bounded validation of admin-supplied test inputs (never trusts input). */
export function parseProviderTestInputs(raw: {
  testTmdbId?: string;
  testTitle?: string;
  testYear?: string;
  testImdbId?: string;
  testSeason?: string;
  testEpisode?: string;
}): ProviderTestInputs {
  const tmdbId = (raw.testTmdbId ?? '').trim();
  const title = (raw.testTitle ?? '').trim();
  const year = Number.parseInt(raw.testYear ?? '', 10);
  const season = Number.parseInt(raw.testSeason ?? '', 10);
  const episode = Number.parseInt(raw.testEpisode ?? '', 10);
  const imdbId = (raw.testImdbId ?? '').trim();
  const movie: ProviderTestMovieInput =
    tmdbId.length > 0 && tmdbId.length <= 32 && title.length > 0 && title.length <= 200
      ? {
          tmdbId,
          title,
          ...(Number.isInteger(year) && year >= 1900 && year <= 2100 ? { year } : {}),
          ...(imdbId.length > 0 && imdbId.length <= 32 ? { imdbId } : {}),
        }
      : DEFAULT_TEST_INPUTS.movie;
  const parsedEpisode =
    Number.isInteger(season) && season >= 1 && season <= 100
      && Number.isInteger(episode) && episode >= 1 && episode <= 1000
      ? { ...movie, season, episode }
      : null;
  return { movie, episode: parsedEpisode };
}

// ---------------------------------------------------------------------------
// Test outcome (admin view)
// ---------------------------------------------------------------------------

export type ProviderTestOutcome =
  | { ok: true; result: ProviderTestResultView }
  | { ok: false; code: string; message: string };

export type ProviderTestDeps = {
  /** Injectable fetcher (tests never touch the real network). */
  fetcher?: typeof fetch;
  /** Injectable DNS resolver (tests). */
  dnsResolver?: SafeDnsResolver;
  /** Per-adapter timeout override (tests). */
  adapterTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Shared machinery: one representative resolution through the standard
// resolver (used by BOTH the test action and the build promotion test)
// ---------------------------------------------------------------------------

export type RepresentativeResolution = {
  cases: ProviderTestCaseView[];
  links: CloudStreamDownloadLinkView[];
  passed: boolean;
};

/**
 * Runs the representative movie (and optional episode) cases for ONE bound
 * adapter through the standard bounded resolver. This is the SAME
 * machinery Downloader 2 uses — the test result is what production would
 * actually produce (never a synthetic probe).
 */
export async function runRepresentativeResolution(
  adapter: MaveroCloudStreamAdapter,
  inputs: ProviderTestInputs,
  deps: ProviderTestDeps = {},
): Promise<RepresentativeResolution> {
  const cases: ProviderTestCaseView[] = [];
  const links: CloudStreamDownloadLinkView[] = [];

  const runCase = async (episode: ProviderTestEpisodeInput | null): Promise<void> => {
    const request = {
      media: {
        tmdbId: inputs.movie.tmdbId,
        title: inputs.movie.title,
        ...(inputs.movie.year !== undefined ? { year: inputs.movie.year } : {}),
      },
      ...(episode !== null ? { season: episode.season, episode: episode.episode } : {}),
      adapterIds: [adapter.id],
    };
    const result = await resolveCloudStream(request, {
      ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
      ...(deps.dnsResolver !== undefined ? { dnsResolver: deps.dnsResolver } : {}),
      ...(deps.adapterTimeoutMs !== undefined ? { adapterTimeoutMs: deps.adapterTimeoutMs } : {}),
      adapterInstances: new Map([[adapter.id.toLowerCase(), adapter]]),
    });
    const group = result.groups.find((candidate) => candidate.adapterId === adapter.id);
    const linksFound = group?.links.length ?? 0;
    const passed = linksFound > 0;
    cases.push({
      kind: episode !== null ? 'episode' : 'movie',
      passed,
      note: passed
        ? null
        : group?.failure !== undefined
          ? group.failure.message
          : 'The adapter returned no links for this case.',
      linksFound,
      durationMs: result.durationMs,
    });
    if (group !== undefined) {
      for (const link of group.links.slice(0, 12)) {
        links.push({
          url: link.url,
          kind: link.kind,
          provider: link.provider,
          sourceName: link.sourceName,
          ...(link.quality !== undefined ? { quality: link.quality } : {}),
          ...(link.codec !== undefined ? { codec: link.codec } : {}),
          ...(link.container !== undefined ? { container: link.container } : {}),
          ...(link.filename !== undefined ? { filename: link.filename } : {}),
          ...(link.sizeBytes !== undefined ? { sizeBytes: link.sizeBytes } : {}),
          ...(link.host !== undefined ? { host: link.host } : {}),
          ...(link.extractor !== undefined ? { extractor: link.extractor } : {}),
        });
      }
    }
  };

  await runCase(null);
  if (inputs.episode !== null && adapter.resolveEpisode !== undefined) {
    await runCase(inputs.episode);
  }

  return { cases, links, passed: cases.every((testCase) => testCase.passed) };
}

// ---------------------------------------------------------------------------
// The admin Test Provider action
// ---------------------------------------------------------------------------

/** The extension row projection the test action needs. */
type TestExtensionRow = {
  id: string;
  repository_id: string;
  internal_name: string;
  name: string | null;
  integration_type: string;
  plugin_status: number | null;
  adapter_state: string;
  enabled: boolean;
  generated_adapter_version: number | null;
};

/**
 * Tests one extension's provider resolution. Binding precedence: NATIVE
 * code registry first (plan §16), then the generated artifact registry
 * (only for adapter_state='generated' rows with an active version).
 */
export async function testExtensionProvider(
  client: CloudStreamClient,
  extensionId: string,
  rawInputs: {
    testTmdbId?: string;
    testTitle?: string;
    testYear?: string;
    testSeason?: string;
    testEpisode?: string;
  } = {},
  deps: ProviderTestDeps = {},
): Promise<ProviderTestOutcome> {
  if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 200) {
    return { ok: false, code: 'EXTENSION_NOT_FOUND', message: 'The extension could not be found.' };
  }

  const { data: row, error: rowError } = await client
    .from('cloudstream_extensions')
    .select('id, repository_id, internal_name, name, integration_type, plugin_status, adapter_state, enabled, generated_adapter_version')
    .eq('id', extensionId)
    .maybeSingle();
  if (rowError !== null) {
    return { ok: false, code: 'INTERNAL_ERROR', message: 'The extension could not be loaded.' };
  }
  if (row === null) {
    return { ok: false, code: 'EXTENSION_NOT_FOUND', message: 'The extension could not be found.' };
  }
  const extension = row as unknown as TestExtensionRow;

  // Bind the executable adapter (native FIRST, then generated).
  const inputs = parseProviderTestInputs(rawInputs);
  let adapter: MaveroCloudStreamAdapter | null = executableAdapterForExtension(extension);
  let adapterKind: 'native' | 'generated' = 'native';
  if (adapter === null && extension.adapter_state === 'generated' && extension.generated_adapter_version !== null) {
    const artifact = await loadActiveArtifact(client, extension);
    if (artifact !== null) {
      adapter = generatedAdapterFromArtifactRow(artifact);
      adapterKind = 'generated';
    }
  }
  if (adapter === null) {
    const state = extension.adapter_state;
    const message = state === 'runtime_required'
      ? 'This provider cannot be converted into a permanent Mavero adapter and remains disabled.'
      : state === 'adapter_required' || state === 'failed'
        ? 'No adapter exists yet for this provider — create one first.'
        : `This provider has no executable adapter in the ${state} state.`;
    await recordTestOutcome(client, extension.id, message);
    return { ok: false, code: 'ADAPTER_NOT_AVAILABLE', message };
  }

  const resolution = await runRepresentativeResolution(adapter, inputs, deps);
  const result: ProviderTestResultView = {
    passed: resolution.passed,
    testedAt: new Date().toISOString(),
    adapterKind,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    cases: resolution.cases,
    links: resolution.links,
  };

  await recordTestOutcome(
    client,
    extension.id,
    resolution.passed
      ? null
      : (resolution.cases.find((testCase) => !testCase.passed)?.note ?? 'The provider test found no links.'),
  );
  return { ok: true, result };
}

/** Loads the ACTIVE artifact row for one generated extension row. */
async function loadActiveArtifact(
  client: CloudStreamClient,
  extension: TestExtensionRow,
): Promise<GeneratedAdapterArtifactRow | null> {
  const canonicalKey = `${extension.integration_type}:${extension.internal_name.trim().toLowerCase()}`;
  const { data, error } = await client
    .from('cloudstream_adapter_artifacts')
    .select('canonical_key, integration_type, provider_id, adapter_version, strategy, artifact, artifact_hash')
    .eq('canonical_key', canonicalKey)
    .eq('adapter_version', extension.generated_adapter_version as number)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return data as unknown as GeneratedAdapterArtifactRow;
}

/** Writes the last_tested_at / last_test_error bookkeeping (bounded). */
async function recordTestOutcome(
  client: CloudStreamClient,
  extensionId: string,
  errorText: string | null,
): Promise<void> {
  try {
    await client
      .from('cloudstream_extensions')
      .update({
        last_tested_at: new Date().toISOString(),
        ...(errorText !== null ? { last_test_error: errorText.slice(0, 1000) } : { last_test_error: null }),
      })
      .eq('id', extensionId);
  } catch {
    // Bookkeeping failures never fail the test action itself.
  }
}
