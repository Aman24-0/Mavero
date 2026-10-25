# Test/runtime stub directories — consolidated mapping table

**Phase 3 3-E (repository-cleanup plan §5 group 3-E; audit §3.3 #5 / §7 P3-5).**
This is the SINGLE mapping table for the three stub directories. The Phase 0
audit flagged them as "three overlapping stub directories", but the fresh
3-E evidence sweep (file diffs, tsconfig mappings, consumer tracing) proved
they are **deliberately different implementations for different resolution
contexts** — not duplicates. They are therefore NOT merged; this document is
the consolidation (one table, explicit per-consumer mappings, semantics
recorded). `scripts/stub_contexts_test.ts` pins the distinction so a future
"dedup" cannot silently break a context.

## Why three directories exist

| Directory | Consumed by | Resolution context |
|---|---|---|
| `scripts/env-stubs/` | `jsconfig.json` | `svelte-check` (`pnpm check`) AND every plain-`tsx` suite run with `--tsconfig ./jsconfig.json` (the default chain form) |
| `scripts/stubs/` | `tsconfig.behavioral.json` (extends `jsconfig.json`, overrides 2 mappings) | behavioral suites run with `--tsconfig ./tsconfig.behavioral.json` (hermetic run: empty env, no `process.env` leakage) |
| `scripts/executor-shims/` | `scripts/build_executor_function.mjs` (alias table, NOT a tsconfig) | the standalone bundled Netlify background function — production semantics (`process.env`) |

## File-by-file table

| File | Resolves | Semantics (deliberate) | Consumers |
|---|---|---|---|
| `scripts/env-stubs/dynamic-private.ts` | `$env/dynamic/private` | `{ ...process.env }` merged with `globalThis.__MAVERO_UPCOMING_TEST_ENV__` at import time (test-injection hook; see its header) | jsconfig surface |
| `scripts/env-stubs/dynamic-public.ts` | `$env/dynamic/public` | public env stub | jsconfig surface |
| `scripts/env-stubs/app-environment.ts` | `$app/environment` | `browser/dev/building = false`, `version = ''` (production posture in plain tsx) | jsconfig surface |
| `scripts/env-stubs/app-navigation.ts` | `$app/navigation` | navigation stub (goto/afterNavigate/invalidate…) for jsconfig-resolved suites | jsconfig surface |
| `scripts/env-stubs/app-forms.ts` | `$app/forms` | `use:enhance`-related stub for jsconfig-resolved suites | jsconfig surface |
| `scripts/stubs/app-environment.ts` | `$app/environment` (override) | typed consts, `version = 'test-stub'` — distinguishes the behavioral run | tsconfig.behavioral suites |
| `scripts/stubs/env-dynamic-private.ts` | `$env/dynamic/private` (override) | **EMPTY env `{}`** — behavioral services see "not configured" (hermetic; no host leakage into tests) | tsconfig.behavioral suites |
| `scripts/executor-shims/env-dynamic-private.ts` | `$env/dynamic/private` (bundle alias) | **`env = process.env`** — in the deployed background function Netlify injects real env vars | `build_executor_function.mjs` only |

## ⚠️ Do NOT "dedupe" these

The three `$env/dynamic/private` implementations MUST stay distinct:

1. **behavioral** `{}` — hermetic tests (a `process.env` mirror would make
   tests depend on the runner host's environment),
2. **executor** `process.env` — production function semantics,
3. **env-stubs** mirror + injection — the general tsx surface (its merge key
   is read by the upcoming-pipeline suites).

`scripts/stub_contexts_test.ts` asserts exactly these three semantics plus
the config-file mappings. If a mapping target moves, update BOTH the config
and that suite (and this table) in the same commit.
