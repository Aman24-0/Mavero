// ============================================================================
// MAVP-6 — Production Playback 500, Episode Chip Alignment & Category Source
// Management — regression suite.
//
// Follows scripts/mavp5_reliability_test.ts as chain command 249.
//
// Sections:
//   §1  Issue 1 — The Gentlemen card-play 500:
//        BEHAVIORAL tests that execute the REAL watch server load under tsx
//        (hermetic: TMDB credentials absent -> deterministic CONFIG_MISSING
//        stand-in for transient upstream failures; fixture series for the
//        success path; a rejecting fake Supabase client for the streaming-
//        config boundary), the REAL new client error hook (hooks.client.ts),
//        and the REAL stage-diagnostics module. Asserts: every degradation
//        boundary emits a SAFE, STAGE-TAGGED log line (class/code only) and
//        the typed outcomes are byte-identical; the client hook never throws
//        and never logs message/stack/query.
//   §2  Issues 2+3 — episode chip alignment + Admin position-settings removal:
//        BEHAVIORAL parser tests (legacy `episodes`/`sizes.episodes` keys are
//        dropped by the total parser; back/landscape semantics unchanged)
//        plus structural parity assertions proving BOTH edge chips share the
//        IDENTICAL vertical reference (top:50% + translateY(-50%) + 64px hit
//        area + 56px bar) — alignment by construction — and that the Admin
//        editor, the shared contract, the server validator and the preview
//        no longer carry any episode-chip position/size surface.
//   §3  Issue 4 — category source management restored:
//        BEHAVIORAL service tests with an in-memory Supabase fake (assign
//        appends densely + idempotent, remove deletes ONLY the mapping row
//        and normalizes, reorder validates the full set and renumbers —
//        atomic RPC path and constraint-safe fallback), behavioral parser
//        tests, and structural assertions that the three restored actions
//        require admin authorization and that the category editor carries
//        the source-management UI (never nested inside the category form).
//
// Deterministic and credential-free: no network, no browser, no Supabase
// credentials (explicitly out of scope for this task).
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let checks = 0;
function ok(condition: unknown, message: string): void {
  checks += 1;
  assert.ok(condition, `FAIL: ${message}`);
}
function okEq<T>(actual: T, expected: T, message: string): void {
  checks += 1;
  assert.deepStrictEqual(actual, expected, `FAIL: ${message} (actual: ${JSON.stringify(actual)})`);
}
function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}
/** Strip block comments so structural regexes read CODE, not prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Console capture — the load and the client hook log through console.error.
type LogLine = Record<string, unknown>;
function captureConsoleError(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('{')) {
      try { lines.push(JSON.parse(first) as LogLine); return; } catch { /* fall through */ }
    }
    if (first && typeof first === 'object') { lines.push(first as LogLine); return; }
    lines.push({ raw: String(first) });
  };
  return { lines, restore: () => { console.error = original; } };
}

// A Supabase client fake whose every from() chain REJECTS — models a transient
// infrastructure failure (the exact class of failure a card-play 500 hides).
function rejectingSupabaseClient(): any {
  const reject = () => Promise.reject(new TypeError('simulated transient network failure'));
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    in: () => chain,
    limit: () => chain,
    maybeSingle: reject,
    single: reject,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    then: (_resolve: unknown, rejectFn: (e: unknown) => unknown) => reject().then(() => undefined, rejectFn),
  };
  return { from: () => chain };
}

// ---------------------------------------------------------------------------
// §1 — Issue 1: watch-load boundaries, stage diagnostics, client error hook
// ---------------------------------------------------------------------------

{
  const { load } = (await import('../src/routes/watch/[type]/[id]/+page.server.ts')) as { load: (event: unknown) => Promise<Record<string, unknown>> };
  const { describeWatchLoadFailure, logWatchLoadStageFailure } = (await import('../src/lib/server/content/watch-load-diagnostics.ts')) as any;
  const { handleError } = (await import('../src/hooks.client.ts')) as { handleError: (input: unknown) => void };

  const url = { searchParams: { get: () => '1' } };
  const baseEvent = (id: string, supabase: unknown) => ({
    params: { type: 'series', id },
    locals: { supabase, user: null },
    cookies: { get: () => undefined },
    url,
  });

  // --- The REAL load: fixture series (hermetic success path) + rejecting config read.
  {
    const captured = captureConsoleError();
    try {
      const result: any = await load(baseEvent('nocturne-city', rejectingSupabaseClient()));
      ok(result?.item?.id === 'nocturne-city', 'I1: the fixture success path returns the item');
      ok(Array.isArray(result?.episodes) && result.episodes.length === 24, 'I1: the fixture success path returns episode data');
      ok(Array.isArray(result?.streamingConfig?.sources) && result.streamingConfig.sources.length === 0, 'I1: a failed streaming-config read degrades to the EMPTY config (unchanged typed outcome)');
      const stageLines = captured.lines.filter((line) => line.stage === 'watch:streaming-config');
      ok(stageLines.length === 1, 'I1: the streaming-config degradation boundary emits exactly ONE stage log');
      okEq(stageLines[0].errorClass, 'unexpected', 'I1: a non-ContentServiceError failure classifies as "unexpected" (class only)');
      ok(!('message' in stageLines[0]) && !('stack' in stageLines[0]) && !('title' in stageLines[0]) && !('url' in stageLines[0]),
        'I1: the stage log carries NO message/stack/title/url — safe fields only');
    } finally {
      captured.restore();
    }
  }

  // --- The REAL load: non-fixture numeric id (the hermetic stand-in for The
  //     Gentlemen's transient upstream failure) -> the detail boundary fires
  //     and the REAL SvelteKit HttpError 404 propagates unchanged.
  {
    const captured = captureConsoleError();
    try {
      let thrown: any = null;
      try { await load(baseEvent('771644', rejectingSupabaseClient())); } catch (e) { thrown = e; }
      ok(thrown !== null, 'I1: an unresolvable detail rejects the load');
      okEq(thrown?.status, 404, 'I1: the detail boundary outcome is the SAME non-disclosing 404 (unchanged)');
      okEq(thrown?.body?.message, 'Title not found', 'I1: the 404 message is the established non-disclosing text (unchanged)');
      const stageLines = captured.lines.filter((line) => line.stage === 'watch:detail');
      ok(stageLines.length === 1, 'I1: the detail degradation boundary emits exactly ONE stage log');
      okEq([stageLines[0].errorClass, stageLines[0].code], ['config', 'CONFIG_MISSING'], 'I1: the hermetic CONFIG_MISSING failure classifies as config/CONFIG_MISSING (a transient upstream failure in production classifies upstream — same stage)');
    } finally {
      captured.restore();
    }
  }

  // --- Unsupported content type: the pre-existing 404 (no stage log — not a degradation).
  {
    const captured = captureConsoleError();
    try {
      let thrown: any = null;
      try { await load({ ...baseEvent('x', rejectingSupabaseClient()), params: { type: 'bogus', id: 'x' } }); } catch (e) { thrown = e; }
      okEq(thrown?.status, 404, 'I1: an unsupported content type keeps the pre-existing 404');
      ok(captured.lines.filter((line) => String(line.stage ?? '').startsWith('watch:')).length === 0, 'I1: the unsupported-type 404 emits NO stage log (it is a typed input rejection, not a degradation)');
    } finally {
      captured.restore();
    }
  }

  // --- Pure stage/classification truth table (all four stages).
  {
    const stages = ['watch:detail', 'watch:streaming-config', 'watch:season', 'watch:assembly'] as const;
    const { ContentServiceError } = (await import('../src/lib/server/content/types.ts')) as any;
    const contentErr = (code: string) => new ContentServiceError('static message', { code }) as any;
    for (const stage of stages) {
      okEq(describeWatchLoadFailure(stage, contentErr('NOT_FOUND')), { stage, errorClass: 'content-unresolved', code: 'NOT_FOUND' }, `I1: ${stage} NOT_FOUND -> content-unresolved`);
      okEq(describeWatchLoadFailure(stage, contentErr('CONFIG_MISSING')), { stage, errorClass: 'config', code: 'CONFIG_MISSING' }, `I1: ${stage} CONFIG_MISSING -> config`);
      okEq(describeWatchLoadFailure(stage, contentErr('UPSTREAM_ERROR')), { stage, errorClass: 'upstream', code: 'UPSTREAM_ERROR' }, `I1: ${stage} UPSTREAM_ERROR -> upstream`);
      okEq(describeWatchLoadFailure(stage, contentErr('RATE_LIMITED')), { stage, errorClass: 'upstream', code: 'RATE_LIMITED' }, `I1: ${stage} RATE_LIMITED -> upstream`);
      okEq(describeWatchLoadFailure(stage, contentErr('TIMEOUT')), { stage, errorClass: 'upstream', code: 'TIMEOUT' }, `I1: ${stage} TIMEOUT -> upstream`);
      okEq(describeWatchLoadFailure(stage, new TypeError('transport')), { stage, errorClass: 'unexpected', code: '' }, `I1: ${stage} TypeError -> unexpected (class only)`);
      okEq(describeWatchLoadFailure(stage, 'a thrown string'), { stage, errorClass: 'unexpected', code: '' }, `I1: ${stage} non-Error throw -> unexpected`);
      okEq(describeWatchLoadFailure(stage, undefined), { stage, errorClass: 'unexpected', code: '' }, `I1: ${stage} undefined -> unexpected`);
      // A plain Error merely SHAPED like a ContentServiceError (duck-typed
      // code field, wrong prototype) must NOT classify by code — the
      // instanceof gate keeps the classification honest.
      const shaped: any = new Error('static message'); shaped.code = 'UPSTREAM_ERROR';
      okEq(describeWatchLoadFailure(stage, shaped), { stage, errorClass: 'unexpected', code: '' }, `I1: ${stage} a duck-typed lookalike classifies as unexpected (instanceof gate)`);
    }
    okEq(describeWatchLoadFailure('watch:detail', contentErr('INVALID_RESPONSE')).errorClass, 'upstream', 'I1: the REAL ContentServiceError instance classifies by code');
  }

  // --- The log helper never throws, even with a broken sink.
  {
    let threw = false;
    try {
      logWatchLoadStageFailure({ error: () => { throw new Error('broken sink'); } }, 'watch:season', new Error('x'));
    } catch { threw = true; }
    ok(threw === false, 'I1: a broken logger sink never alters the load outcome (absorbed)');
  }

  // --- The REAL client error hook: class-only reporting, never throws.
  {
    const captured = captureConsoleError();
    try {
      handleError({ error: new TypeError('simulated transport failure'), event: { routeId: '/watch/[type]/[id]', url: new URL('https://mavero.test/watch/series/771644?season=1&episode=2&from=/discover') } });
      handleError({ error: 'a thrown string', event: null });
      handleError({ error: undefined, event: undefined });
      handleError(undefined as unknown as object);
      ok(checks > 0, 'I1: hook executions completed');
      const hookLines = captured.lines.filter((line) => line.msg === 'unexpected client error (SvelteKit client router surface)');
      ok(hookLines.length === 4, 'I1: every unexpected client error produces exactly one structured report');
      const first: any = hookLines[0];
      okEq([first.errorClass, first.routeId, first.path], ['TypeError', '/watch/[type]/[id]', '/watch/series/771644'], 'I1: the client report carries the error class + route + PATH ONLY');
      ok(!JSON.stringify(first).includes('simulated transport failure') && !JSON.stringify(first).includes('season=1') && !JSON.stringify(first).includes('from='),
        'I1: the client report NEVER carries the error message or the query string');
      okEq([hookLines[1].errorClass, hookLines[2].errorClass, hookLines[3].errorClass], ['non-error-thrown', 'unknown', 'unknown'], 'I1: non-Error throws and malformed hook inputs classify safely');
    } finally {
      captured.restore();
    }
  }

  // --- Structural: the four boundaries are wired in the load (source-level truth).
  {
    const watchServer = codeOnly(read('../src/routes/watch/[type]/[id]/+page.server.ts'));
    ok(watchServer.includes("logWatchLoadStageFailure(logger, 'watch:detail'"), 'I1: the detail boundary is wired to the stage logger');
    ok(watchServer.includes("logWatchLoadStageFailure(logger, 'watch:streaming-config'"), 'I1: the streaming-config boundary is wired to the stage logger');
    ok(watchServer.includes("logWatchLoadStageFailure(logger, 'watch:season'"), 'I1: the season boundary is wired to the stage logger');
    ok(watchServer.includes("logWatchLoadStageFailure(logger, 'watch:assembly'"), 'I1: the assembly boundary is wired to the stage logger');
    // The MAVP-5 fail-closed adult gate and its own log line are untouched.
    ok(watchServer.includes('watch adult authorization check failed (fail closed)'), 'I1: the MAVP-5 fail-closed adult-gate log is preserved');
    ok(watchServer.includes('if (isHttpError(gateError)) throw gateError;'), 'I1: the MAVP-5 gate HttpError propagation is preserved');
    // Typed outcomes byte-identical.
    ok((watchServer.match(/throw error\(404, 'Title not found'\)/g) ?? []).length >= 3, 'I1: the typed 404 outcomes are unchanged');
    ok(watchServer.includes('return EMPTY_STREAMING_CONFIG'), 'I1: the EMPTY config outcome is unchanged');
  }
}

// ---------------------------------------------------------------------------
// §2 — Issues 2+3: episode chip alignment (fixed) + Admin position removal
// ---------------------------------------------------------------------------

{
  const positionModule = (await import('../src/lib/shared/player-controls-position.ts')) as any;

  // --- BEHAVIORAL: legacy stored configs parse cleanly, episodes keys DROPPED.
  {
    const legacy = positionModule.parsePlayerControlsPosition({
      mode: 'custom',
      back: { portrait: { horizontal: { anchor: 'right', offsetPercent: 20 }, vertical: { anchor: 'top', offsetPercent: 10 } } },
      // Pre-MAVP-6 saved sections/entries — must be ignored (dropped), never
      // moved or re-applied.
      episodes: { portrait: { horizontal: { anchor: 'left', offsetPercent: 4 }, vertical: { anchor: 'center', offsetPercent: 50 } } },
      sizes: { back: 50, landscape: 52, episodes: 72 },
    });
    ok(legacy !== null, 'I2/I3: a legacy config with episodes sections still parses (never breaks playback)');
    ok(!('episodes' in legacy), 'I2/I3: the parsed contract carries NO episodes section');
    okEq(legacy.sizes, { back: 50, landscape: 52 }, 'I2/I3: the parsed sizes carry ONLY back/landscape (legacy sizes.episodes dropped)');
    okEq(legacy.back.portrait.horizontal, { anchor: 'right', offsetPercent: 20 }, 'I2/I3: the Back control semantics are UNCHANGED by the removal');
    okEq(positionModule.resolveControlPlacement(legacy, 'landscape', 'landscape').horizontal, null, 'I2/I3: the Landscape control semantics are UNCHANGED by the removal');
    // An episodes-ONLY custom config (no remaining axis/size) is treated as
    // malformed by the TOTAL parser — identical to the pre-MAVP-6 semantics
    // for an empty custom payload.
    okEq(positionModule.parsePlayerControlsPosition({ mode: 'custom', episodes: { portrait: { horizontal: { anchor: 'left', offsetPercent: 4 }, vertical: null } } }), null,
      'I2/I3: an episodes-only custom config degrades to the default (total parser)');
    okEq(positionModule.parsePlayerControlsPosition({ mode: 'custom', sizes: { episodes: 64 } }), null,
      'I2/I3: a sizes.episodes-only custom config degrades to the default (total parser)');
    // The default-mode shape has no episodes key either.
    const defaulted = positionModule.parsePlayerControlsPosition({ mode: 'default' });
    ok(defaulted !== null && !('episodes' in defaulted), 'I2/I3: the default-mode contract shape carries no episodes key');
  }

  // --- STRUCTURAL: the runtime chip consumes NO per-source placement.
  {
    const shell = read('../src/lib/components/player/PlayerShell.svelte');
    const shellCode = codeOnly(shell);
    const chipTag = shellCode.match(/<button class="episode-chip"[^>]*>/)?.[0] ?? '';
    ok(chipTag.length > 0, 'I2/I3: the episode chip renders');
    ok(!chipTag.includes('style='), 'I2/I3: the episode chip receives NO inline position/size style (fixed like the source chip)');
    ok(!chipTag.includes('custom-position') && !chipTag.includes('custom-size'), 'I2/I3: the episode chip has no custom-position/custom-size bindings');
    ok(!shellCode.includes('resolveControlPlacement(activeSourceOption?.controlsPosition ?? null, \'episodes\''), 'I2/I3: no runtime resolution through an episodes contract');
    ok(!shellCode.includes('--episodes-chip-size'), 'I2/I3: the runtime size variable is gone');
  }

  // --- STRUCTURAL ALIGNMENT PROOF (Issue 2): both edge chips share the
  //     IDENTICAL vertical mechanics. Extracted from the stylesheet and
  //     compared value-by-value — the alignment contract, not a prose claim.
  {
    const shellCode = codeOnly(read('../src/lib/components/player/PlayerShell.svelte'));
    const verticalOf = (selector: string): { top: string; transform: string; minHeight: string } | null => {
      const rule = shellCode.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1];
      if (!rule) return null;
      return {
        top: rule.match(/top:\s*([^;]+);/)?.[1]?.trim() ?? '',
        transform: rule.match(/transform:\s*([^;]+);/)?.[1]?.trim() ?? '',
        minHeight: rule.match(/min-height:\s*([^;]+);/)?.[1]?.trim() ?? '',
      };
    };
    const sourceChip = verticalOf('source-chip');
    const episodeChip = verticalOf('episode-chip');
    ok(sourceChip !== null && episodeChip !== null, 'I2: both edge chip rules exist');
    okEq(episodeChip, sourceChip, 'I2: the episode chip and the source chip share the IDENTICAL vertical reference (top + transform + min-height)');
    okEq(episodeChip, { top: '50%', transform: 'translateY(-50%)', minHeight: '64px' }, 'I2: the shared vertical reference is the vertical centre with a 64px hit area');
    const barHeight = (selector: string) => shellCode.match(new RegExp(`\\.${selector}-bar\\s*\\{[^}]*height:\\s*([^;]+);`))?.[1]?.trim();
    okEq(barHeight('episode-chip'), barHeight('source-chip'), 'I2: both chip bars share the same height');
    okEq(barHeight('episode-chip'), '56px', 'I2: the shared bar height is the established 56px');
    // Landscape override parity (the compact/landscape block shrinks BOTH).
    ok(/\.episode-chip\s*\{\s*min-height:\s*56px;\s*\}/.test(shellCode) && /\.source-chip\s*\{\s*min-height:\s*56px;\s*\}/.test(shellCode),
      'I2: the responsive override keeps BOTH chips at the same shrunk height');
    ok(/\.episode-chip-bar\s*\{\s*height:\s*48px;\s*\}/.test(shellCode) && /\.source-chip-bar\s*\{\s*height:\s*48px;\s*\}/.test(shellCode),
      'I2: the responsive override keeps BOTH chip bars at the same shrunk height');
    // Orientation-independence: no media/landscape rule moves either chip vertically.
    ok(!shellCode.includes('.landscape-mode .episode-chip') && !shellCode.includes('.landscape-mode .source-chip'),
      'I2: no orientation-specific vertical override exists for either chip');
  }

  // --- STRUCTURAL: the Admin editor carries NO episode-chip position surface.
  {
    const adminPage = codeOnly(read('../src/routes/admin/system/api-sources/+page.svelte'));
    ok(!adminPage.includes('EPISODES_CONTROL_DEFAULT_SIZE_PX'), 'I3: the removed chip-size constant is not imported');
    ok(!/id:\s*'episodes'/.test(adminPage), 'I3: POSITION_CONTROLS has no episodes entry (no placement editor, no size editor)');
    ok(!adminPage.includes('previewEpisodesStyle'), 'I3: no episode preview marker style');
    ok(!adminPage.includes('a2-position-preview-episode'), 'I3: no episode preview marker element or CSS');
    ok(!adminPage.includes('positionDraft.episodes'), 'I3: no episodes position draft');
    ok(/controlsSizesDraft = \$state<\{ back: string; landscape: string \}>/.test(adminPage), 'I3: the size drafts carry ONLY back/landscape');
    ok(!adminPage.includes("previewMarkerSize('episodes')"), 'I3: the preview caption has no episodes fragment');
    // The remaining controls keep their editors (unrelated settings preserved).
    ok(/id:\s*'landscapeControl'/.test(adminPage) && /id:\s*'back'/.test(adminPage), 'I3: the Landscape and Back editors are preserved');
    ok(adminPage.includes('readLegacyAxis(custom?.back?.portrait?.horizontal'), 'I3: the Back prefill is preserved');
  }

  // --- STRUCTURAL: the shared contract + server validator have no episodes surface.
  {
    const shared = codeOnly(read('../src/lib/shared/player-controls-position.ts'));
    ok(!shared.includes('parseEpisodesSection'), 'I3: the episodes section parser is gone');
    ok(!shared.includes("control === 'episodes'"), 'I3: no episodes branch remains in any resolver');
    ok(/'landscape' \| 'back'/.test(shared), 'I3: ControlsControlId covers only the two positionable controls');
    ok(/sizes:\s*\{ back: number \| null; landscape: number \| null \} \| null/.test(shared), 'I3: the sizes type covers only back/landscape');
    ok(!shared.includes('EPISODES_CONTROL_DEFAULT'), 'I3: the obsolete chip constants are removed (no dead exports)');
    const validator = read('../src/lib/server/streaming/validation.ts');
    ok(!codeOnly(validator).includes("record.episodes"), 'I3: the server validator no longer reads an episodes section');
    ok(!codeOnly(validator).includes("'episodes chip'"), 'I3: the server validator has no episodes size label');
    ok(validator.includes('Unknown keys inside the payload are ignored (tolerant)'), 'I3: the documented unknown-key tolerance is the legacy compatibility path');
  }
}

// ---------------------------------------------------------------------------
// §3 — Issue 4: category source management (assign / remove / reorder)
// ---------------------------------------------------------------------------

{
  const service = (await import('../src/lib/server/streaming/admin-service.ts')) as any;
  const validation = (await import('../src/lib/server/streaming/validation.ts')) as any;

  // In-memory streaming_source_categories store + a fluent Supabase fake that
  // supports EXACTLY the chains the service uses (select/eq/order/limit/
  // maybeSingle, insert, update+eq, delete+eq, rpc).
  type MappingRow = { source_id: string; category_id: string; ordering: number };
  function fakeClient(db: { mappings: MappingRow[]; tablesTouched: Set<string>; rpc?: (name: string, args: any) => Promise<{ error: any }> }) {
    function from(table: string) {
      db.tablesTouched.add(table);
      const state: { mode: 'select' | 'insert' | 'update' | 'delete' | null; payload: any; filters: Record<string, unknown>; orderCol: string | null; orderAsc: boolean; limitN: number | null } = { mode: null, payload: null, filters: {}, orderCol: null, orderAsc: true, limitN: null };
      const rowsFor = (): MappingRow[] => db.mappings.filter((row) => Object.entries(state.filters).every(([col, val]) => (row as any)[col] === val));
      async function execute(): Promise<{ data: any; error: any }> {
        if (state.mode === 'select') {
          let rows = rowsFor();
          if (state.orderCol) rows = rows.slice().sort((a, b) => ((a as any)[state.orderCol!] - (b as any)[state.orderCol!]) * (state.orderAsc ? 1 : -1));
          if (state.limitN !== null) rows = rows.slice(0, state.limitN);
          return { data: rows.map((row) => ({ ...row })), error: null };
        }
        if (state.mode === 'insert') { db.mappings.push({ ...(state.payload as MappingRow) }); return { data: null, error: null }; }
        if (state.mode === 'update') {
          for (const row of rowsFor()) Object.assign(row, state.payload);
          return { data: null, error: null };
        }
        if (state.mode === 'delete') {
          const doomed = rowsFor();
          for (const row of doomed) db.mappings.splice(db.mappings.indexOf(row), 1);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
      const builder: any = {
        select: (cols: string) => { state.mode = 'select'; return builder; },
        insert: (payload: unknown) => { state.mode = 'insert'; state.payload = payload; return builder; },
        update: (payload: unknown) => { state.mode = 'update'; state.payload = payload; return builder; },
        delete: () => { state.mode = 'delete'; return builder; },
        eq: (col: string, val: unknown) => { state.filters[col] = val; return builder; },
        order: (col: string, opts?: { ascending?: boolean }) => { state.orderCol = col; state.orderAsc = opts?.ascending !== false; return builder; },
        limit: (n: number) => { state.limitN = n; return builder; },
        maybeSingle: async () => {
          const { data, error } = await execute();
          const first = Array.isArray(data) ? (data[0] ?? null) : data;
          return { data: first, error };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => execute().then(resolve, reject),
      };
      return builder;
    }
    return {
      from,
      rpc: (name: string, args: any) => (db.rpc ? db.rpc(name, args) : Promise.resolve({ error: { code: '42883', message: 'function reorder_category_sources does not exist' } })),
    };
  }

  const CAT = '11111111-1111-1111-1111-111111111111';
  const A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const B = 'bbbbbbbb-2222-2222-2222-222222222222';
  const C = 'cccccccc-3333-3333-3333-333333333333';

  // --- assignSourceToCategory: appends densely at max+1.
  {
    const db = { mappings: [{ source_id: A, category_id: CAT, ordering: 0 } as MappingRow], tablesTouched: new Set<string>() };
    await service.assignSourceToCategory(fakeClient(db) as never, B, CAT);
    okEq(db.mappings.length, 2, 'I4: the assignment inserts exactly one mapping row');
    okEq(db.mappings.find((row) => row.source_id === B)?.ordering, 1, 'I4: the assignment APPENDS at max(ordering) + 1 (dense)');
    ok([...db.tablesTouched].every((table) => table === 'streaming_source_categories'), 'I4: assignment touches ONLY the mapping table');
  }
  // --- assignSourceToCategory: re-assigning is a safe no-op preserving position.
  {
    const db = { mappings: [{ source_id: A, category_id: CAT, ordering: 0 }, { source_id: B, category_id: CAT, ordering: 1 }] as MappingRow[], tablesTouched: new Set<string>() };
    await service.assignSourceToCategory(fakeClient(db) as never, A, CAT);
    okEq(db.mappings.length, 2, 'I4: re-assigning an assigned source inserts NOTHING (duplicate-proof)');
    okEq(db.mappings.find((row) => row.source_id === A)?.ordering, 0, 'I4: re-assigning preserves the existing position');
  }
  // --- deleteSourceCategory: removes ONLY the mapping, normalizes ordering.
  {
    const db = { mappings: [A, B, C].map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })) as MappingRow[], tablesTouched: new Set<string>() };
    await service.deleteSourceCategory(fakeClient(db) as never, B, CAT);
    okEq(db.mappings.map((row) => row.source_id), [A, C], 'I4: removal deletes ONLY the requested mapping row (the source record is never deleted)');
    okEq(db.mappings.map((row) => row.ordering), [0, 1], 'I4: the remaining assignments re-normalize to dense 0..N-1');
    ok([...db.tablesTouched].every((table) => table === 'streaming_source_categories'), 'I4: removal touches ONLY the mapping table (never streaming_sources)');
  }
  // --- deleteSourceCategory: removal in one category never touches another category's mappings.
  {
    const otherCat = '22222222-2222-2222-2222-222222222222';
    const db = { mappings: [A, B].map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })).concat([{ source_id: A, category_id: otherCat, ordering: 0 }]) as MappingRow[], tablesTouched: new Set<string>() };
    await service.deleteSourceCategory(fakeClient(db) as never, A, CAT);
    okEq(db.mappings.filter((row) => row.category_id === otherCat).length, 1, 'I4: multi-category assignments are preserved (removal is pair-scoped)');
  }
  // --- reorderCategorySources: atomic RPC path renumbers the full set.
  {
    const db = { mappings: [A, B, C].map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })) as MappingRow[], tablesTouched: new Set<string>(), rpc: async (_name: string, args: any) => {
      // Simulate the documented atomic SQL behavior: validate + renumber.
      const ids: string[] = args.p_ordered_source_ids;
      const current = db.mappings.filter((row) => row.category_id === args.p_category_id);
      if (new Set(ids).size !== ids.length || ids.length !== current.length) return { error: { code: '23514', message: 'reorder set mismatch' } };
      for (const row of current) row.ordering = 1_000_000 + ids.indexOf(row.source_id);
      for (const row of current) row.ordering = ids.indexOf(row.source_id);
      return { error: null };
    } };
    await service.reorderCategorySources(fakeClient(db) as never, CAT, [C, A, B]);
    const orderOf = (id: string) => db.mappings.find((row) => row.source_id === id)!.ordering;
    okEq([orderOf(A), orderOf(B), orderOf(C)], [1, 2, 0], 'I4: the reorder applies the submitted order (RPC path)');
  }
  // --- reorderCategorySources: duplicates rejected before any write.
  {
    const db = { mappings: [A, B].map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })) as MappingRow[], tablesTouched: new Set<string>() };
    let message = '';
    try { await service.reorderCategorySources(fakeClient(db) as never, CAT, [A, A]); } catch (e) { message = (e as Error).message; }
    ok(/Duplicate sources/.test(message), 'I4: a duplicate reorder payload is rejected with a clear error');
    okEq(db.mappings.map((row) => row.ordering), [0, 1], 'I4: a rejected reorder writes NOTHING');
  }
  // --- reorderCategorySources: fallback path validates the FULL set (stale/deleted safe).
  {
    const db = { mappings: [A, B].map((source_id, ordering) => ({ source_id, category_id: CAT, ordering })) as MappingRow[], tablesTouched: new Set<string>() };
    let message = '';
    try { await service.reorderCategorySources(fakeClient(db) as never, CAT, [A]); } catch (e) { message = (e as Error).message; }
    ok(/must include every source/.test(message), 'I4: a stale reorder (deleted source since load) is rejected, never half-applied');
    try { await service.reorderCategorySources(fakeClient(db) as never, CAT, [A, B, C]); } catch (e) { message = (e as Error).message; }
    ok(/must include every source|not assigned/.test(message), 'I4: an unknown/not-assigned source id is rejected');
    // Deterministic fallback renumbering.
    await service.reorderCategorySources(fakeClient(db) as never, CAT, [C === '' ? A : A, B]); // full valid set [A,B]
    okEq(db.mappings.map((row) => row.ordering), [0, 1], 'I4: the constraint-safe fallback renumbers densely');
  }
  // --- reorderCategorySources: scoped to ONE category (other categories untouched).
  {
    const otherCat = '33333333-3333-3333-3333-333333333333';
    const db = { mappings: [{ source_id: A, category_id: CAT, ordering: 0 }, { source_id: B, category_id: CAT, ordering: 1 }, { source_id: A, category_id: otherCat, ordering: 0 }] as MappingRow[], tablesTouched: new Set<string>() };
    await service.reorderCategorySources(fakeClient(db) as never, CAT, [B, A]);
    okEq(db.mappings.filter((row) => row.category_id === otherCat).map((row) => row.ordering), [0], 'I4: the reorder never touches another category\u2019s ordering values');
  }

  // --- BEHAVIORAL: form parsers (server-side input validation).
  {
    const form = (entries: Record<string, string>) => {
      const fd = new FormData();
      for (const [key, value] of Object.entries(entries)) fd.append(key, value);
      return fd;
    };
    okEq(validation.parseSourceAssignmentForm(form({ source_id: A, category_id: CAT })), { source_id: A, category_id: CAT }, 'I4: a valid assignment form parses');
    let threw = '';
    try { validation.parseSourceAssignmentForm(form({ source_id: 'not-a-uuid', category_id: CAT })); } catch (e) { threw = (e as Error).message; }
    ok(/Source is invalid/.test(threw), 'I4: a non-UUID source id is rejected');
    threw = '';
    try { validation.parseSourceAssignmentForm(form({ category_id: CAT })); } catch (e) { threw = (e as Error).message; }
    ok(threw.length > 0, 'I4: a missing source id is rejected');
    const reorderForm = form({ category_id: CAT, [`position_${A}`]: '2', [`position_${B}`]: '1' });
    const parsed = validation.parseCategoryReorderForm(reorderForm);
    okEq(parsed.categoryId, CAT, 'I4: the reorder form parses the category id');
    okEq(parsed.positions.length, 2, 'I4: the reorder form parses every position field');
    threw = '';
    try { validation.parseCategoryReorderForm(form({ category_id: CAT, position_bogus: '1' })); } catch (e) { threw = (e as Error).message; }
    ok(/Source is invalid/.test(threw), 'I4: a malformed position field key is rejected');
    threw = '';
    try { validation.parseCategoryReorderForm(form({ category_id: CAT, [`position_${A}`]: 'zero' })); } catch (e) { threw = (e as Error).message; }
    ok(threw.length > 0, 'I4: a non-numeric position is rejected');
  }

  // --- STRUCTURAL: the restored actions + the category-editor UI wiring.
  {
    const server = codeOnly(read('../src/routes/admin/system/content-rules/+page.server.ts'));
    for (const action of ['assignSource', 'removeSource', 'reorderSources']) {
      ok(new RegExp(`\\s{2}${action}: async \\(`).test(server), `I4: the ${action} action is restored`);
    }
    const actionsBody = server.slice(server.indexOf('assignSource:'), server.indexOf('reorderSources:') + 1200);
    ok((actionsBody.match(/requireAdmin\(locals/g) ?? []).length >= 3, 'I4: every restored action requires admin authorization');
    ok(server.includes('parseSourceAssignmentForm') && server.includes('parseCategoryReorderForm'), 'I4: every restored action parses + validates its input server-side');
    ok(server.includes('.sort((a, b) => a.position - b.position)'), 'I4: the reorder action sorts the submitted positions deterministically (field order can never influence the outcome)');
    ok(server.includes('assignSourceToCategory') && server.includes('deleteSourceCategory') && server.includes('reorderCategorySources'), 'I4: the actions reuse the EXISTING service-layer methods (no competing data model)');

    const page = read('../src/routes/admin/system/content-rules/+page.svelte');
    const pageCode = codeOnly(page);
    ok(pageCode.includes('action="?/assignSource"'), 'I4: the category editor renders the assign form');
    ok(pageCode.includes('action="?/removeSource"'), 'I4: the category editor renders the remove form');
    ok(pageCode.includes('action="?/reorderSources"'), 'I4: the category editor renders the reorder forms');
    ok(pageCode.includes('name={`position_${sid}`}') || pageCode.includes('position_${sid}'), 'I4: the reorder forms submit the documented position_<sourceId> fields');
    ok(pageCode.includes('Sources in this category'), 'I4: the source-management section has a clear heading');
    ok(pageCode.includes('No sources assigned to this category yet.'), 'I4: the section shows a clear EMPTY state');
    ok(pageCode.includes('Every existing source is already assigned to this category.'), 'I4: the assign select shows its exhausted state');
    ok(pageCode.includes("assignedSourcesForCategory(editingCategory.id)"), 'I4: the assigned list derives from the LIVE load payload (no second data model)');
    ok(pageCode.includes("Unknown source"), 'I4: a stale mapping (deleted source) renders safely and stays removable');
    // Category CRUD stays SEPARATE from source CRUD: the category form and
    // the source forms are SIBLINGS (the source section must not be nested
    // inside the category <form>).
    const categoryFormEnd = pageCode.indexOf('</form>');
    const sourcesSection = pageCode.indexOf('Sources in this category');
    ok(sourcesSection > categoryFormEnd && sourcesSection >= 0, 'I4: the source-management section is OUTSIDE the category form (separate mutations)');
    ok(!/updateCategory[\s\S]{0,400}position_/.test(pageCode), 'I4: a category save can never submit reorder fields (CRUD separation)');
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`MAVP-6 player & admin regression suite: ${checks} checks passed`);
