# MAVERO Unified Live TV — Release Checklist (Phase 8)

**Status:** Phase 8 release QA executed 2026-10-23 on branch `livetv/phase-8-release-qa` (baseline `50a811d` = the Phase 7 merge, PR #23). Evidence: `LIVETV_WORKLOG.md` entries P8-0…P8-6. **Nothing on this checklist is pre-checked without evidence** — items marked ✅ were verified with recorded evidence; items marked ⬜ are PENDING and MUST be completed by the owner before the release is declared complete. The release is NOT complete until §7 owner sign-off.

**Evidence conventions:** REPOSITORY = this branch's code/diffs. TEST = automated gates run in the Phase 8 session (real exit codes). PRODUCTION = live Netlify/Supabase behavior — only the owner can observe these; no item here may be checked off from code or test evidence alone.

---

## 1. Automated gates — ✅ COMPLETE (TEST evidence, 2026-10-23)

| Gate | Result | Evidence |
|---|---|---|
| `pnpm check` | ✅ exit 0 (0 errors, 5 pre-existing warnings) | P8-1 #1 |
| Full regression chain (the 16 groups of `pnpm test`, executed group-by-group with real exit codes; single-command parity runs in CI on every push/PR) | ✅ all 16 groups exit 0 | P8-1 #2–#17 |
| `pnpm test:livetv` (34 suites: 27 pre-existing + 7 Phase 7) | ✅ exit 0 | P8-1 #13, per-suite counts P8-2 |
| `pnpm build` | ✅ exit 0 (+ honest scheduler no-op line with the cron env unset) | P8-1 #18 |
| Scheduler emission probes (valid cron ⇒ emitted + schedule frozen; invalid cron ⇒ build fails exit 1) | ✅ 0 / 1 as designed | P8-1 #19–#20 |
| `git diff --check` + secret scan + protected-path review | ✅ clean | P8-0, P8-6 |

CI note: the PR branch's GitHub Actions run ("check · build · test") must be green before merge — that is the single-command `pnpm test` confirmation.

## 2. Manual browser / playback matrix — ⬜ PENDING (owner only; NOT RUN in Phase 8 — see P8-3 for why)

Environment requirement: a normal user account, an admin account, desktop Chrome + Firefox + Safari + Edge, one real Android phone, one real iPhone. Never bypass DRM, geo-restrictions or provider access controls; a blocked stream is an HONEST result — record it, do not work around it.

| # | Check | Pass condition |
|---|---|---|
| 2.1 | `/live-tv` renders the LiveGT catalogue | category bar, search, grid all as before Phase 1 |
| 2.2 | Channel select → playback | video starts; fresh resolution each play (no reuse after back-navigation) |
| 2.3 | Fullscreen + orientation (mobile) | LT-16 behavior unchanged; fullscreen analytics event fires |
| 2.4 | Channel switch | clean engine swap, no stale overlay/audio |
| 2.5 | Embed fallback | only after fatal native failure; iframe path works |
| 2.6 | Error states | airplane-mode/offline → honest error, no spinner deadlock; recovery on reconnect |
| 2.7 | Stale-data state | background tab / reconnect shows the honest stale banner per LT-4 |
| 2.8 | Admin → System → Live TV, every tab | loads, CRUD + preview/refresh buttons behave; non-admin gets 403 |
| 2.9 | Admin diagnostics | ops-status view renders bounded/sanitized rows (no URLs/credentials anywhere) |
| 2.10 | Recent channels | row records on first readiness, remove + Clear all work |
| 2.11 | Matrix completion | repeat 2.1–2.6 on every listed browser; 2.3 on both real devices; keyboard-only pass on desktop (tab order, focus rings, Escape) |

Record each row's result (PASS/FAIL + browser + date) directly in this table or an attached note.

## 3. Supabase migration verification — ⬜ PENDING (production check; owner-reported applied)

1. SQL Editor (per `docs/supabase-migration-runbook.md` workflow):
   ```sql
   select relname, relrowsecurity from pg_class
   where relnamespace = 'public'::regnamespace and relname = 'livetv_refresh_history';
   -- expect one row: livetv_refresh_history | true
   select policyname from pg_policies where tablename = 'livetv_refresh_history';
   -- expect exactly: livetv_refresh_history_admin_all
   ```
2. RLS negative check (logged-in non-admin client): `select count(*) from public.livetv_refresh_history;` must ERROR or return 0 — never rows.
3. Confirmed: the migration is idempotent (safe to re-run) and additive (rollback = `drop table if exists public.livetv_refresh_history;` — nothing references it).

## 4. Netlify production deploy verification — ⬜ PENDING

1. Trigger/redeploy production from Netlify (owner action — the code agent never deploys).
2. **Deploy log must contain exactly one scheduler-generator line:**
   - `wrote netlify/functions/livetv-scheduler.mjs (schedule: @hourly)` ⇒ the scheduled function IS in this deploy; or
   - `LIVETV_SCHEDULER_CRON unset — scheduler implemented but NOT scheduled` ⇒ it is NOT (then re-check the env var is set for production builds).
3. Netlify UI: Site configuration → Functions shows `livetv-scheduler` with its schedule.
4. Netlify env: `LIVETV_SCHEDULER_SECRET` present (server-side; presence only — never print or paste the value), `LIVETV_SCHEDULER_CRON=@hourly`.

## 5. Scheduled-function first-tick verification — ⬜ PENDING

1. Wait for the first scheduled window (up to 1 h for `@hourly`).
2. Admin ops status (`GET /api/admin/livetv/ops/status`, admin session): `subsystems.refresh.lastTickAt` is non-null and recent; trigger counts reflect `scheduled`.
3. Manual endpoint check: `curl -i -X POST https://<site>/api/livetv/scheduler/tick -H "Authorization: Bearer $SECRET"` → 200 with a bounded summary; a wrong/absent secret → 401; unconfigured deploy → 503.
4. `livetv_refresh_history` gains rows with `trigger_type='scheduled'` (SQL Editor select as admin).
5. **Reminder:** an hourly TICK ≠ hourly refresh of every source — per-source `refreshIntervalMinutes` (default 720 min) governs due-ness; ≤3 playlist/API + ≤2 EPG sources run per tick; the history-backed duplicate window dedups cross-instance invocations.

## 6. Admin diagnostics verification — ⬜ PENDING (owner)

1. Ops status shows per-source rows (stalest-first) with `lastAttemptAt`/`lastSuccessAt`/`consecutiveFailures`/`lastErrorCategory`; EPG freshness where guide sources exist.
2. Deliberately trigger one manual refresh on the builtin source and confirm a `manual` history row appears (bounded, sanitized).
3. Confirm NO diagnostic surface (ops status, admin status endpoints, function logs) ever shows: full upstream URLs with query strings, signed `__hdnea__` values, credentials, raw provider bodies, stack traces.

## 7. Rollback criteria and procedure — reference (no action unless triggered)

**Roll back if:** playback regressions on `/live-tv` (2.1–2.6 fail on multiple browsers); scheduler storms or repeated 401/5xx in function logs; history writes failing in a way that degrades admin UX; any secret exposure in any surface.

| Layer | Procedure |
|---|---|
| Unified mode (primary lever) | keep `livetv_config_meta.unified_enabled = false` (it already is) — `/live-tv` then behaves exactly as pre-project LiveGT V1 |
| Scheduler | remove `LIVETV_SCHEDULER_CRON` from Netlify build env → redeploy (generator emits nothing; stale artifacts marked `*.stale-removed` — delete if present). Optionally clear the secret (endpoint then answers 503). Per-source backoff/refresh simply stops |
| History table | `drop table if exists public.livetv_refresh_history;` — safe any time (no FK edges; best-effort writes never fail a refresh) |
| Code | revert the deploy to the previous Netlify deploy (all livetv migrations are additive; older code runs fine against the extra tables) |

## 8. Owner sign-off — ⬜ PENDING

- [ ] §2 manual matrix recorded (all rows PASS, or failures triaged)
- [ ] §3 migration verification SQL run and recorded
- [ ] §4 deploy-log line + Functions UI confirmed
- [ ] §5 first-tick evidence recorded (`lastTickAt`, 200 on the manual check, scheduled history rows)
- [ ] §6 diagnostics verified sanitized
- [ ] Known limitations accepted (P8-3 NOT RUN items; instance-local in-flight guards; retention without a scheduler)

Signed-off by: ______________  Date: ________  Notes: ______________
