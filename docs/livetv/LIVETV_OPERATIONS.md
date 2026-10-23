# MAVERO Unified Live TV — Operations Runbook (Phase 7; status refreshed by Phase 8)

**Status (Phase 8 refresh, 2026-10-23):** the Phase 7 hardening is MERGED to `main` (PR #23) and passed the Phase 8 release QA (`LIVETV_RELEASE_CHECKLIST.md`). The scheduler is **CONFIGURED — per the owner's report: `LIVETV_SCHEDULER_CRON`/`LIVETV_SCHEDULER_SECRET` set in Netlify, the migration applied via the SQL Editor, the Netlify project reconnected — but the production build and the FIRST scheduled tick are NOT yet verified** (the agent session holds no production credentials and never observed a deploy). Complete checklist items §3–§5 of `LIVETV_RELEASE_CHECKLIST.md` after the next production deploy; §1 below remains the exact activation/verification reference. `unified_enabled` remains **FALSE** (owner-reported; verify with §9).

**Audience:** the owner/operator. Every procedure below assumes admin access to the Mavero Admin UI, the Supabase SQL Editor, and the Netlify site settings.

---

## 1. Scheduled refresh — configuration and verification

### What exists

| Piece | Where | State |
|---|---|---|
| Tick orchestration (planner + bounded executor) | `src/lib/server/livetv/scheduler.ts` | shipped |
| Authenticated tick endpoint | `POST /api/livetv/scheduler/tick` | shipped (fail-closed until configured) |
| Netlify scheduled function | `netlify/functions/livetv-scheduler.mjs` (generated at build) | emitted ONLY when `LIVETV_SCHEDULER_CRON` is set at build time; OWNER-REPORTED `@hourly` — confirm via the deploy log line or Site configuration → Functions |
| Shared secret | `LIVETV_SCHEDULER_SECRET` (server-side env) | OWNER-REPORTED configured; never print the value; verify by the §1.5 endpoint check only |
| Per-source intervals | optional `refreshIntervalMinutes` (15–10080) in the source/EPG-source `config` jsonb | absent ⇒ default 720 min (12 h) |
| Persistent history | `livetv_refresh_history` table (migration `20261122000000`) | OWNER-REPORTED applied (SQL Editor); verify with the §6 queries |

### Activation steps (owner)

1. **Apply the migration** (§6 below) — the scheduler and the admin diagnostics read `livetv_refresh_history`; without the table the tick still runs but records nothing durable.
2. **Set the secret** in Netlify site env (server-side, never client-visible): `LIVETV_SCHEDULER_SECRET` = a long random value (e.g. `openssl rand -hex 32`). Never place it in URLs, logs, commits, or the repo.
3. **Choose the cadence** and set the build-time env: `LIVETV_SCHEDULER_CRON` = a 5-field cron expression (or Netlify descriptor `@hourly`/`@daily`). The scheduled function is emitted at the next build ONLY when this variable exists — no variable ⇒ no schedule, nothing pretends otherwise. An invalid value FAILS the build (loud, not silent).
4. **Deploy.** The generated function runs the same bounded tick in-process (no secret over the wire). External schedulers can instead POST to `/api/livetv/scheduler/tick` with `Authorization: Bearer <secret>`.
5. **Verify:**
   - `curl -i -X POST https://<site>/.netlify/functions/livetv-scheduler` is NOT how it is invoked (the platform schedules it); instead check the admin ops status endpoint (§3) for `subsystems.refresh.lastTickAt` after the first scheduled window.
   - Manual endpoint check: `curl -i -X POST https://<site>/api/livetv/scheduler/tick -H "Authorization: Bearer $SECRET"` → `200 { ok, result: { … } }`. A missing secret env ⇒ `503 SCHEDULER_UNCONFIGURED`; a wrong secret ⇒ `401` **before any database or upstream work**.
   - The generator log line during build states plainly: `scheduler implemented but NOT scheduled` when the cron env is absent.

### Rollback (scheduler)

Remove `LIVETV_SCHEDULER_CRON` from the build env and redeploy — no scheduled function is emitted (a stale artifact from a previous configured build is marked `*.stale-removed` by the generator; delete it in the deploy if present). Optionally also clear `LIVETV_SCHEDULER_SECRET` (the endpoint then answers 503 unconfigured). History data may be kept or dropped (`drop table if exists public.livetv_refresh_history;`) — nothing else references it.

### Tick bounds (why one invocation is safe)

8 s wall-clock budget (inside the 10 s sync-function cap); ≤3 playlist/API + ≤2 EPG sources per tick, sequential; per-source in-flight guard (keyed by the resolved source id); a 120 s history-backed duplicate window (cross-instance); per-source intervals with deterministic hash(slug) jitter (±10 %, ≤30 min); consecutive-failure backoff ×2ᵏ capped ×8; in-run retry: at most 2 attempts, transient failures only, budget-gated. Sources that cannot start inside the remaining budget are **deferred** (left due; the next tick picks them up — refreshes are idempotent).

---

## 2. Identifying a failed source

1. Open **Admin → System → Live TV** (Overview tab) — the instance-local "recent activity" list shows the newest outcomes on the serving instance.
2. For the cross-instance, durable view call `GET /api/admin/livetv/ops/status` (admin session required): `sources[]` / `epgSources[]` list, **stalest-first**, per subject: `lastAttemptAt`, `lastSuccessAt`, `consecutiveFailures`, `lastErrorCategory`, `lastStatus` (and `guideWindowEndAt` for EPG freshness).
3. Error categories are the bounded taxonomy (`timeout`, `network`, `http_error`, `blocked_url`, `invalid_source_config`, `empty_document`, `decompression_too_large`, …) — deliberately NOT message text. Configuration, URLs, credentials and provider payloads are never in the response.

### Interpreting common categories

| Category | Meaning | First action |
|---|---|---|
| `timeout` | upstream exceeded its deadline (45 s source / 60 s guide) | retry once via manual refresh; if persistent, check the provider status |
| `http_error` | upstream answered non-2xx (429/5xx are classified transient and retried once in-run) | check the provider; a 429 storm means the interval is too aggressive — raise `refreshIntervalMinutes` |
| `network` | DNS/connect/read failure | verify the host is up; check for provider-side geo/outage |
| `blocked_url` | the SSRF guard rejected the destination (private/reserved address, credentials, metadata IP) | do NOT disable the guard; fix the configured URL |
| `invalid_source_config` | config failed validation | fix via the admin source editor |
| `too_large` / `decompression_too_large` | document exceeded 8 MiB / 12 MiB (compressed) or the 16 MiB decompressed budget | the feed is oversized — contact the provider or use a smaller playlist |
| `unsupported_media_type` | the endpoint returned HTML (an error/player page) | the provider URL is stale — re-check |
| `empty_document` / `structure_invalid` | XMLTV document empty or malformed | inspect the provider feed |

---

## 3. Inspecting sanitized diagnostics

- **Durable per-attempt records:** `GET /api/admin/livetv/ops/status` aggregates the newest ≤300 history rows (admin-only via RLS + requireAdmin).
- **Raw recent outcome payloads** (bounded, per-instance): `GET /api/admin/livetv/sources/status` and `GET /api/admin/livetv/epg/status` — counts, bounded entry/ingestion error samples (static reasons, URL-stripped), skip-reason histograms.
- **What is NEVER in any diagnostic:** upstream URLs with query strings, redirect targets, credentials, signed playback material (`__hdnea__` values), raw provider response bodies, stack traces. Error text is writer-sanitized and CHECK-bounded (category ≤60 chars, message ≤240 chars) at the database level too.

---

## 4. Disabling a problematic source safely

1. Admin → System → Live TV → Sources → toggle **Enabled** off (or set status to `disabled`/`unavailable`).
2. Effect is immediate and total: the scheduler's candidate load applies the SAME eligibility gates as the refresh service (S1 `enabled` + S2 eligible status + adapter availability) — a disabled source is never planned, never fetched.
3. In-flight safety: a refresh that already started completes its current bounded attempt; a disabled source mid-run yields the typed `source_ineligible` outcome on its next attempt. History records the transition honestly (`status: skipped`).
4. No user-facing impact: with `unified_enabled = false` the /live-tv page uses the LiveGT path and never reads registry rows; catalogue rows from the disabled source simply stop being eligible for any future unified activation (Phase 6 exposure rules re-evaluate server-side every read).

---

## 5. Manual preview and refresh (the safe test path)

- **Preview (zero writes):** Admin → source row → Preview (or `POST /api/admin/livetv/sources/preview`): fetch + parse + plan only — the response reports what a real refresh WOULD write. Rate rule `livetvAdminPreview` 12/min.
- **Refresh:** Admin → source row → Refresh (or `POST /api/admin/livetv/sources/refresh`): one bounded attempt (45 s deadline), idempotent ingestion, NO retries (manual refresh is deliberately single-attempt — the admin can re-click; the rate rule bounds storms). Rate rule `livetvAdminRefresh` 6/min.
- EPG twins: `livetvAdminEpgRefresh` 6/min, `livetvAdminEpgPreview` 12/min.
- Manual and scheduled runs are fully separate trigger types in history (`trigger_type: manual | scheduled`) — a manual run never consumes scheduler capacity and vice versa.

---

## 6. Database: applying / rolling back the Phase 7 migration

**State: NOT applied anywhere.** The owner applies it manually per `docs/supabase-migration-runbook.md` (SQL Editor):

```sql
-- Apply (idempotent):  supabase/migrations/20261122000000_livetv_refresh_history.sql
```

Verify afterwards:

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relname = 'livetv_refresh_history';  -- relrowsecurity = true
select policyname from pg_policies where tablename = 'livetv_refresh_history';      -- one *_admin_all policy
```

**Rollback** (fully additive table; nothing references it):

```sql
drop table if exists public.livetv_refresh_history;
```

Retention is automatic once the scheduler runs (best-effort sweep at tick end): rows older than 30 days are deleted in bounded batches (500 × ≤40 per call; convergent). Without the scheduler, run `applyLivetvHistoryRetention` via any code path or prune manually — the table grows by ≤1 row per refresh attempt.

---

## 7. Recovering from specific upstream failures

- **Upstream timeout:** the attempt aborts at its deadline (typed `timeout`, classified transient). Scheduled runs retry ONCE in-run (budget permitting), then the source's due date backs off ×2 per consecutive failure (capped ×8) — a dead upstream self-throttles, never storms. Manual runs never auto-retry.
- **HTTP 429:** the bounded `Retry-After` (≤60 s, delta-seconds or HTTP-date; garbage falls back to backoff) is honored for the single in-run retry when it fits the tick budget; otherwise the source defers to the next tick. Persistent 429s ⇒ raise the source's `refreshIntervalMinutes`.
- **HTTP 5xx:** same transient path as 429 (without Retry-After).
- **Malformed playlist / oversized feed / dead EPG source:** typed permanent failures (`invalid_payload`, `too_large`, `empty_document`, `structure_invalid`) — NOT retried (retrying cannot help). Fix the configuration or the provider, then use Preview to validate before the next real refresh.
- **EPG stale/incorrect data:** guide rows are never deleted by a refresh (report-only staleness); a failed guide refresh leaves the last good snapshot serving and the guide reads honestly empty only where data is genuinely missing. Force a fresh import with a manual EPG refresh; retention sweeps strictly-past windows only.

---

## 8. Responding to a suspected SSRF / security event

1. The guard stack (stage-1 URL guard → stage-2 DNS guard per hop → connect-time re-validation → redirect cap → byte caps → content-type gates) is re-pinned by `scripts/livetv_phase7_fetch_hardening_test.ts`. A guard rejection yields `blocked_url`/`invalid_url` in history — the private hop is NEVER fetched (suite-proven).
2. If a source's history shows `blocked_url`: someone configured (or a provider redirected to) a private/reserved/metadata address. Inspect the source's config URL in the Admin UI, disable the source, and audit who changed it (admin actions are authenticated).
3. No module in `src/lib/server/livetv/` performs a raw fetch outside `fetch-safe.ts` (suite-pinned). If an incident suggests otherwise, re-run `pnpm exec tsx --tsconfig ./jsconfig.json scripts/livetv_phase7_fetch_hardening_test.ts` — a failing §7 pin names the offending module.
4. Scheduler auth anomalies (401s on the tick endpoint) appear in the Netlify function logs only as the non-disclosing code `SCHEDULER_UNAUTHORIZED` — no secret material is logged. Rotating `LIVETV_SCHEDULER_SECRET` immediately invalidates leaked copies (redeploy not required for the endpoint; the scheduled function needs no secret).

---

## 9. Verifying `unified_enabled` stays FALSE

```sql
select unified_enabled from public.livetv_config_meta where id = 1;  -- expect false
```

Application-side parity: the admin ops status endpoint reports `subsystems.unified.enabled` (boolean, fail-closed on any read error). Phase 7 code NEVER writes this row; the Phase 5 fail-closed flag semantics and the 30 s flag cache are untouched (existing suites stay green).

---

## 10. Evidence to collect before escalating a provider incident

1. `GET /api/admin/livetv/ops/status` output (bounded, sanitized — safe to attach).
2. The source's recent history rows: `select * from public.livetv_refresh_history where subject_id = '<uuid>' order by started_at desc limit 20;` (sanitized by design).
3. A Preview result for the affected source (dry-run counts + static reasons).
4. The provider's own status/health page reference and the configured `refreshIntervalMinutes`.
5. Timeline correlation: `trigger_type` distribution (was the failure scheduled-only, manual-only, or both?).

---

## 11. Failure drills (deterministic, offline — executed as unit tests)

No production incident was simulated; every drill below is a deterministic test with mock clocks/DBs/fetchers (the honest scope of this phase). All drills PASS in CI (`pnpm run test:livetv`).

| # | Drill | Evidence (suite + check) | Result |
|---|---|---|---|
| 1 | Upstream refresh timeout | `livetv_phase7_retry_test` §1.1/§4 (typed `timeout` classification + bounded fetch deadline) & `livetv_phase7_fetch_hardening_test` §6.1 | PASS |
| 2 | Oversized playlist | `livetv_phase7_fetch_hardening_test` §5.1–§5.3 (mid-stream cap abort + stream cancellation + content-length pre-check) | PASS |
| 3 | Malformed XMLTV / dead EPG source | `livetv_phase7_retry_test` §1.6 (`empty_document`/`structure_invalid` permanent — no retry) + Phase 3 parse-cap suites (unchanged, green) | PASS |
| 4 | Repeated HTTP 429/5xx | `livetv_phase7_retry_test` §1.2–§1.4 (transient classification), §2.10–§2.14 + §3 (bounded Retry-After), §5 (max attempts + budget); scheduler backoff `livetv_phase7_scheduler_test` §3.12–§3.13 | PASS |
| 5 | Source disabled while refresh is running | `livetv_phase7_scheduler_test` §4.12 (ineligible sources never planned) + refresh-service eligibility gates (Phase 2 suites green) + history `skipped` mapping (`livetv_phase7_history_test` §1.9) | PASS |
| 6 | Unauthorized scheduler invocation | `livetv_phase7_scheduler_test` §1.1–§1.13 (fail-closed unset env, wrong/absent secret, timing-safe path) + endpoint order pins (`livetv_phase7_health_test` §3.4–§3.5: rejection BEFORE any work) | PASS |
| 7 | Sanitization of signed URL/token-bearing errors | `livetv_phase7_redaction_test` §1–§3 + §5 (unique fake values never survive; redirect targets never echoed) + `livetv_phase7_history_test` §2 | PASS |
| 8 | Duplicate scheduler invocation | `livetv_phase7_scheduler_test` §5.1–§5.4 (in-flight guard → ONE upstream fetch; typed in-progress outcome; history-backed window) | PASS |
| 9 | Partial ingestion failure | `livetv_phase7_history_test` §1.10 (`partial` status mapping) + Phase 2 per-item isolation suites (unchanged, green) | PASS |
| 10 | Database unavailable during history persistence | `livetv_phase7_history_test` §3.1–§3.6 (refresh SUCCEEDS, `historyPersisted:false` reported honestly, no partial row, throwing client contained) | PASS |

---

## 12. Rate limits and resource controls (review result)

- Manual admin refresh/preview: **unchanged** (6/min, 12/min; EPG twins identical).
- NEW: `livetvSchedulerTick` 4/min per identity — a leaked secret still cannot drive unbounded work; each tick is additionally budget-bounded (8 s) and duplicate-window-guarded.
- No existing limit was raised or loosened. All rules keep 60 s windows — a suite-asserted invariant (`evictExpired`'s documented assumption).
- Per-source/global concurrency: sequential execution per tick (global per-invocation limit 1) + per-source in-flight guard + cross-instance duplicate window. Expensive parsing stays within the established caps (M3U 20k entries / XMLTV 5k channels + 50k programmes / 16 MiB decompressed). History reads are capped (≤300 rows); history writes are bounded by design (1 row/attempt) and swept at 30 days.
- Retry storms: impossible by construction — one retry layer (scheduler only), max 2 attempts in-run, ×8-capped cross-tick backoff, budget-gated everywhere, CI never sleeps (injected clocks).
