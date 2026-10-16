# MAVERO — Supabase Security, Performance & Migration Remediation Report

**Branch:** `supabase-remediation` (from `main` @ `ed90050`)
**Migration:** `supabase/migrations/20261118000000_supabase_remediation_security_performance.sql`
**Production project:** Supabase ref `whekhqimzrafhsrmswbn` (Data API `https://whekhqimzrafhsrmswbn.supabase.co`)
**Scope discipline:** Vixolity untouched (deliberately disabled); leaked-password protection untouched (plan limitation); no production reset/drop/truncate; no history fabrication; no unrelated UX/provider work.

---

## 1. Baseline

| Item | State at start |
|---|---|
| Repository | `main` @ `ed90050` (audit(vixolity) round), working tree clean, synced with `origin/main` |
| Feature branch | `supabase-remediation` created from `ed90050` for this round |
| Live access channel available here | **Data API only** (service-role REST/OpenAPI on the `public` schema). **No** Management API token, **no** direct Postgres connection, **no** SQL execution channel |
| Live access channels NOT available | Advisors (Management API), `supabase_migrations.schema_migrations`, `pg_stat_user_indexes`, arbitrary SQL |

Live-state verification was therefore performed **through the Data API** and is exact for what it covers: every public table (41 exposed), every exposed RPC (16) with its argument signature, and the full column lists of the eleven tables in scope. Catalog-level facts (policies, grants, function attributes, index usage statistics) were verified **on an embedded PostgreSQL applying the real repository migration chain** (see §5), and the advisor results cited in this report are the ones supplied by the production audit in the task description.

**Live objects probed (evidence, read-only):**

- `direct_play_sources` — **exists in production only**. 17 columns (id, media_type, tmdb_id, season, episode, provider, stream_url, stream_type, proxy_url, extraction_mode, extraction_duration_ms, expires_at, last_verified_at, failure_count, status, created_at, updated_at). **0 rows.** Referenced by **no repository migration** (`rg direct_play_sources supabase/` → none), no `src/` code, no `database.types.ts` entry, and no git history (`git log --all -S direct_play_sources` → empty). Verdict: **out-of-band experimental table**; treated as server-only (§3.A), not dropped (production data decisions out of scope).
- `device_pairing_requests` — 21 columns = exactly the union of `20260928000000_device_pairing_requests.sql` + `20261003000000_device_pairing_exchange_lease.sql`. **2 rows live.** All application access verified server-side: `src/lib/server/auth/device-pairing.ts` accepts only `SupabaseAdminClient` (service role) and `src/routes/api/auth/device-pairing/info/+server.ts` builds its own service-role client from `privateEnv`.
- The three ordering RPCs exist with the exact signatures `reorder_category_sources(uuid, uuid[])`, `set_addon_position(uuid, integer)`, `set_downloader_source_position(text, integer)`; every call site in `src/` uses the **session-scoped request client** (`locals.supabase` — the admin user's own JWT), verified at `src/routes/admin/system/content-rules/+page.server.ts:202`, `src/routes/admin/system/integrations/+page.server.ts:207-210`. **No service-role caller exists anywhere in the repo** (the `service_role` EXECUTE grant on the downloader RPC is unused).
- `user_preferences` (3 cols), `download_providers` (15 cols incl. `type`), `streaming_default_source_slots` (4 cols), `streaming_default_sources` (3 cols), `media_assets` (25 cols incl. `provider_folder_mapping_id`), `media_operations` (13 cols incl. `upload_operation_id`) — all present with current shapes, confirming the production schema is **current with the repository head** even where migration history is missing (§2).

---

## 2. Migration-history reconciliation

**Observed discrepancy:** the production audit reported **34 entries** in the live migration history, while the repository contains **93 migration files**.

**Root cause (evidence-based):** this project does not use the Supabase CLI (`config.toml` absent) — `docs/supabase-migration-runbook.md` documents that migrations are applied **manually via the Dashboard SQL Editor**, which does **not** write `supabase_migrations.schema_migrations`. The 34 recorded entries can only be a subset (recorded by whatever tool produced them early in the project's life); the repository is the source of truth, not the history table.

**Reconciliation performed without the history table:**

1. **Effects-presence audit (live, read-only):** all 41 public tables and all 16 public RPCs that the 93 migrations should produce are present with current shapes (§1). The five most version-sensitive objects were checked explicitly: the device-pairing lease/manual-handle columns (20261003000000+20261004000000), `download_providers.type` (20261007000000), the slot table (20261107000000), the analytics tables (20261008000000) and the CloudStream tables (20261101000000-03) — all present. This establishes that **production schema = repository head**, even though the recorded history is incomplete.
2. **No replay, no history fabrication:** per constraints, no old migration was altered, nothing was marked applied, and no backfill of `supabase_migrations` was attempted (it is unreachable from here anyway). The new corrective migration is purely additive with a version that sorts after the newest repository file.
3. **Migration version choice:** `20261118000000` — deliberately **not** derived from the machine clock (2026-10-17), because repository migrations dated in the future relative to it (`20261117000000_vidstuck_cc_embed_origins.sql`) would sort *after* a machine-dated file and reorder application semantics. The chosen version sorts immediately after the newest existing file.
4. **Pre-existing integrity findings (documented, NOT "fixed" by rewriting history):**
   - **Duplicate version prefixes:** `20261004000000_…` ×2 (device RPC fix + unified downloader global order) and `20261012000000_…` ×2 (link-reactivate actions + source-category unique assignment). Any CLI-based tooling would reject these; the manual SQL Editor workflow is why it never surfaced. Left untouched (already deployed); recorded here.
   - **`20260820015000_phase7a_public_mirror_tables.sql` is NOT a harmless duplicate:** its leading `drop view if exists public.streaming_public_…` statements raise `"…" is not a view` once `20260820014000` has created the mirror **tables**. The regression test proves the two files are comment-identical (so the duplicate adds no schema effect) and skips it, documenting the reason. The runbook's "byte-identical duplicate / harmless no-op" claim does not hold when the file is applied after its twin.
   - **Version-order replay trap:** `20261004000000_unified_downloader_global_order.sql` contains a first-run backfill that reads `cloudstream_repositories` / `cloudstream_extensions` — created by the **later-versioned** `20261101000000` / `20261101000002`. In pure version order on a fresh database this migration fails at the backfill. The chain was applied in dependency order to production (which is why it works there); the regression test replicates that order with an explanatory comment.
   - **Out-of-band objects:** `direct_play_sources` + `update_direct_play_sources_updated_at()` exist only in production (evidence §1). The migration hardens the function unconditionally (CREATE OR REPLACE is safe with or without the table) and guards the table-scoped statements behind `to_regclass` so a fresh replay of the repository chain is a clean no-op.

**Types:** the migration changes no table shapes (policies/functions/indexes only), so `database.types.ts` required no regeneration.

---

## 3. Security findings — remediation record

### A. RLS enabled with no policies — FIXED (server-only posture documented in-catalog)

- `device_pairing_requests`: RLS stays **enabled**; all privileges revoked from `anon` and `authenticated`; `service_role`/ownership untouched; an explicit **RESTRICTIVE** deny-all policy (`device_pairing_requests_deny_client … for all to anon, authenticated using (false) with check (false)`) documents the intent and keeps the table sealed even if a permissive policy is added later. Server-side operations are unaffected (service role bypasses RLS and keeps its grants) — verified behaviorally in §5 and by the pairing dry-call checks in `docs/supabase-remediation-verification.sql`.
- `direct_play_sources`: same treatment (restrictive deny-all + privilege revocation), **conditional on table existence** so fresh replays of the repository chain (which never creates this table) are no-ops. No public access policy was invented; the table is closed, not populated with access paths.

### B. Mutable search_path — FIXED

`update_direct_play_sources_updated_at()` is replaced (CREATE OR REPLACE — same OID, live trigger binding preserved) with `security invoker`, `set search_path = pg_catalog`, and body `new.updated_at := now()`. The behavior contract ("set NEW.updated_at, return NEW") is preserved; the change additionally removes the session-TimeZone wall-clock round-trip (`timezone('utc', now())` → re-cast) — the same RC-3 defect class the device-RPC migration fixed — and client EXECUTE is revoked from PUBLIC/anon/authenticated (trigger invocation needs no EXECUTE; mirrors the `bump_download_providers_config_version` precedent).

### C. SECURITY DEFINER RPCs — FIXED (converted to SECURITY INVOKER)

`reorder_category_sources`, `set_addon_position`, `set_downloader_source_position` — all three are now `SECURITY INVOKER`. Security proof:

1. **In-body gate preserved verbatim:** each function starts with `if not (select public.is_admin()) then raise … 42501`. `is_admin()` is itself SECURITY INVOKER (since `20260821010000_phase7a_migration_repair.sql`) reading `public.profiles` via `profiles_select_own`, so it evaluates correctly for any authenticated caller under INVOKER.
2. **Every touched table carries an admin-only RLS contract:** `streaming_categories` + `streaming_source_categories` (phase7a), `streaming_addons` (20260918000000), `downloader_source_order` (20261004000000) — each has a `*_admin_all FOR ALL to authenticated USING/WITH CHECK ((select public.is_admin()))` policy, and `authenticated` holds the table grants (Supabase default privileges). An admin's internal reads/writes therefore pass RLS unchanged; a non-admin never reaches them (42501 first); `service_role` bypasses RLS as before.
3. **Call-path proof:** the application calls all three RPCs exclusively through the session client (§1) — the admin's own JWT — so the exact production path is what the regression test exercises (`set role authenticated` + admin JWT subject → success; ordinary user → 42501; anon → denied).
4. **Least privilege:** `authenticated` keeps EXECUTE (admin UI depends on it); `anon` stays revoked; the **unused** `service_role` EXECUTE grant on `set_downloader_source_position` is revoked (post-conversion such calls would be rejected by the is_admin() gate anyway — `auth.uid()` is null in service contexts — so the grant misrepresented the real contract).
5. **Not weakened:** validation, transaction safety, two-phase/dense-renumber writes, `SELECT … FOR UPDATE` serialization and transaction-scoped advisory locks are untouched; negative tests confirm the original error codes/messages (42501, 22023, range messages).

### D. Leaked-password protection — INTENTIONAL EXCEPTION (unchanged)

Unavailable on the current Supabase plan; not attempted, not changed. Recorded as a plan limitation, not an application defect. It will remain reported by the advisor; that is the expected end state.

---

## 4. Performance findings — remediation record

### A. Missing foreign-key indexes — FIXED

| FK | New index |
|---|---|
| `device_pairing_requests.approved_by_user_id → auth.users(id)` | `device_pairing_requests_approved_by_user_id_idx` |
| `media_assets.provider_folder_mapping_id → provider_folder_mappings(id)` | `media_assets_provider_folder_mapping_id_idx` |
| `media_operations.upload_operation_id → media_upload_operations(id)` | `media_operations_upload_operation_id_idx` |

Plain `CREATE INDEX IF NOT EXISTS` (idempotent, safe to retry) rather than CONCURRENTLY: the project's migration mechanism is the Dashboard SQL Editor, which runs a multi-statement buffer inside one implicit transaction — CONCURRENTLY cannot run in a transaction block. All three tables are small in production (device_pairing_requests held **2 rows** at audit time; media tables are personal-scale), so the brief SHARE lock is the safest supported approach. No redundant indexes were created (verified: no existing index leads with these columns in the repository inventory).

### B. RLS initialization plan — FIXED

`device_sessions_select_own` recreated with the init-plan form `using ((select auth.uid()) = user_id)`. Name, role (`authenticated`), command (`SELECT`), USING semantics (ownership boundary), and the absence of WITH CHECK preserved exactly. Regression test asserts both directions of the ownership boundary (users see only their own sessions; another user's sessions are invisible) plus the catalog form.

### C. Multiple permissive policies — FIXED (effective access matrix unchanged)

| Table | Before | After |
|---|---|---|
| `download_providers` | `select_public` (SELECT, anon+auth, enabled) + `admin_all` (ALL, auth, is_admin) — overlapping for authenticated SELECT | `select_public` (SELECT, **anon**, enabled) + `select_authenticated` (SELECT, **authenticated**, enabled OR is_admin) + `insert/update/delete_admin` (authenticated, is_admin) — **one permissive SELECT per role** |
| `streaming_default_source_slots` | `select_public` (SELECT, anon+auth, true) + `admin_all` (ALL, auth) | `select_public` (SELECT, anon+auth, true) + `insert/update/delete_admin` |
| `streaming_default_sources` | same shape | same consolidation |
| `user_preferences` | `select_own` + `select_admin` (both SELECT authenticated) | single `user_preferences_select_self_or_admin` (own row OR admin); `insert_own`/`update_own` untouched |

**Design note (caught by the regression test):** the merged `download_providers` SELECT policy initially OR-ed `is_admin()` for both roles; that would have **broken every anon read**, because policy expressions evaluate per-row and anon has no EXECUTE on `is_admin()` (revoked since phase7a). The final consolidation is role-split so anon's policy contains no admin-function reference at all. Public configuration reads (`download_providers_public` security-invoker view included) and admin management (including disabled rows) are both preserved — asserted behaviorally for anon, ordinary user, and admin.

### D. Unused indexes (28 reported) — 7 removed (provable redundancy), 21 retained with rationale

Without live `pg_stat_user_indexes`, "unused" alone is not evidence. Action was limited to the subset that is **independently provable** as redundant from definitions alone (exact duplicates of, or strict column prefixes of, valid covering indexes on the same table):

| Dropped | Covered by |
|---|---|
| `media_items_canonical_key_idx` | `media_items_canonical_key_key` UNIQUE (exact duplicate) |
| `media_items_content_type_tmdb_id_season_episode_idx` | `media_items_content_tmdb_season_episode_key` UNIQUE (exact duplicate) |
| `media_items_content_type_tmdb_id_idx` | the same UNIQUE index (strict prefix) |
| `media_folders_canonical_key_idx` | `media_folders_canonical_key_key` UNIQUE (exact duplicate) |
| `media_availability_requests_canonical_key_idx` | `media_availability_requests_canonical_key_key` UNIQUE (exact duplicate) |
| `media_availability_requests_content_type_tmdb_id_idx` | `…_content_type_tmdb_id_season_episode_idx` (strict prefix; retained) |
| `provider_folder_mappings_canonical_folder_id_idx` | `provider_folder_mappings_canonical_provider_key` UNIQUE (prefix) |

Every drop is **guarded**: it executes only while the covering constraint index is verified `indisunique/indisvalid/indisready` (via `pg_index` / `pg_constraint`), so production drift degrades to a safe no-op with a NOTICE. All covering indexes are asserted present post-migration.

**Retained (21+ remaining candidates)** — including the analytics event/session indexes, device-pairing lease paths, provider-health, media availability/status, and streaming-configuration indexes: each serves a plausibly-used lookup/cleanup/analytics path or is a partial index whose predicate the covering index cannot replace (e.g. `device_pairing_secret_hash_idx` is partial on `status='pending'` and remains the hot-path index; the full `device_pairing_secret_hash_all_idx` serves the consume-path lookups across all statuses). None is demonstrably unnecessary; all are kept and listed for a future pass **with** live usage statistics (`pg_stat_user_indexes` / `pg_stat_user_indexes.idx_scan` after a representative traffic window).

---

## 5. Tests and quality gates

**New regression suite:** `scripts/supabase_remediation_migration_test.ts` — **115 checks, all passing** — registered in the `pnpm test` chain (before the DOM-QA script). It applies the **real repository migration chain verbatim** (24 files, dependency-ordered with the two documented ordering quirks) to embedded PostgreSQL (`@electric-sql/pglite` — the repo's established migration-testing pattern), stubs only the Supabase environment (auth schema, client roles with production-equivalent BYPASSRLS/privileges, out-of-band production objects), then:

1. **reproduces every advisor finding on the pre-state** (0 policies, mutable search_path, SECURITY DEFINER RPCs, bare auth.uid(), overlapping policy pairs, missing FK indexes, redundant indexes present);
2. applies the remediation migration in a single transaction;
3. asserts **behavior**, not text: anon/authenticated denial (42501) on both server-only tables, service-role pairing CRUD intact, restrictive deny-all catalogued, trigger still attached and bumping `updated_at` to the true instant, all three RPCs succeeding for an admin end-to-end under RLS (dense renumbering + addon resync verified), ordinary-user 42501 with the original messages, per-role single permissive SELECT policies, user-preference ownership both ways, FK index definitions exact, seven redundant indexes gone with coverings intact;
4. re-applies the migration and asserts byte-identical catalog state (idempotency/safe-retry).

**Existing tests:** run unmodified via `pnpm test` (full chain; results below). No test was deleted or weakened.

**Gates (run on the feature branch):**

| Gate | Result |
|---|---|
| `pnpm check` | **0 errors / 5 warnings** — identical to the recorded baseline |
| `pnpm test` (full chain incl. the new 115-check suite) | **Green through the entire chain**; stops only at the documented **pre-existing** DOM-QA failure (`mav_task2_episode_sheet_dom_qa.mjs`, Playwright strict-mode `.bulk-btn` ambiguity — identical at baseline commits 219b058/3f9a49d; no `src/` change this round). The post-chain season-chip contract suite passes 32/32 (run separately, house convention) |
| `pnpm build` | **exit 0** (vite build + Netlify adapter) |
| Secrets scan | Clean (no keys/tokens in any changed file); `git diff --check` clean |

**Ledger updates (sanctioned, house convention):** `cloudstream_registry_integration_test.ts` migration ledger 16→17 with an explicit remediation posture check (no `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` / `TRUNCATE`, no table create/drop in the migration); `cloudstream_phase4_integration_manager_test.ts` ledger 13→14. Both suites re-run green (180 and 222 checks).

---

## 6. Production deployment status

**The migration has NOT been applied to production.** This environment has no SQL execution channel (§1), and the project's own runbook (`docs/supabase-migration-runbook.md`) prescribes manual Dashboard SQL Editor application. Production is therefore **not yet remediated** — the deliverables are the committed migration, the behavioral proof, and the verification tooling below.

**Apply procedure (when approved):**

1. Supabase Dashboard → SQL Editor → paste `supabase/migrations/20261118000000_supabase_remediation_security_performance.sql` in full → Run (single implicit transaction; idempotent — safe to re-run on partial failure).
2. Run every block of `docs/supabase-remediation-verification.sql` — every row must show `ok = t` (and the four pairing dry-calls must return 0 rows without error).
3. Manually exercise the admin paths once: `/admin/system/content-rules` category reorder, `/admin/system/integrations` addon + downloader ordering, downloader admin CRUD, and a non-admin account's downloader-config read.
4. Re-run **both advisors** (Dashboard → Advisors) and record before/after in this report's log; the remaining expected findings are exactly: leaked-password protection (plan limitation) and the retained unused-index set.

---

## 7. Remaining exceptions and follow-ups

1. **Leaked-password protection** — plan limitation; intentional exception (§3.D).
2. **Retained "unused" indexes** — retained for lack of usage evidence; revisit with live `pg_stat_user_indexes` after a traffic window (§4.D).
3. **`direct_play_sources`** — closed to clients but **not dropped**; if the out-of-band experiment is confirmed dead, dropping table + trigger + function should be a deliberate, separately-approved migration.
4. **Migration-history backfill** — the live `supabase_migrations` history is incomplete (34 vs 93). If the project ever adopts the CLI, a reconciliation pass (e.g. `supabase migration repair` against the real applied set) will be needed; deliberately not fabricated here.
5. **Duplicate version prefixes + the two ordering traps** (§2.4) — documented; fix only if/when the project moves to CLI-based migrations.
6. **Advisor before/after evidence** — the "before" numbers come from the production audit; the "after" run must be captured in the Dashboard after application (§6.4) — it could not be executed from this environment.
7. **SSR CSP delivery gap** — known open item from the Vixolity round (`VIXOLITY_PLAYBACK_AUDIT_REPORT.md`); unrelated to this Supabase round, listed only to keep the release notes complete.

---

## 8. Execution log

- Baseline recorded: `main` @ `ed90050` clean/synced; live probes captured (§1); feature branch `supabase-remediation` created.
- Migration `20261118000000` written (8 sections, idempotent, guarded).
- Regression suite written; **115/115 checks green** on the real chain; registered in `pnpm test`.
- Two consolidation-design defects were caught **by the regression test during development** and fixed before delivery: (a) the merged `download_providers` SELECT policy would have broken anon reads via `is_admin()` EXECUTE denial — replaced with the per-role split; (b) the `provider_folder_mappings` covering-index guard missed the constraint's explicit name — replaced with a `pg_constraint` lookup. Both fixes are pinned by dedicated checks.
- Gates: `pnpm check` 0e/5w; `pnpm build` exit 0; `pnpm test` green to the documented pre-existing DOM-QA failure; season-chip 32/32; secrets scan clean.
- Commit: SHA recorded below; pushed to `origin/supabase-remediation`.

**Changed files (this round):**

- `supabase/migrations/20261118000000_supabase_remediation_security_performance.sql` (new — the corrective migration)
- `scripts/supabase_remediation_migration_test.ts` (new — 115-check behavioral regression suite)
- `docs/supabase-remediation-verification.sql` (new — post-apply live verification + advisor instructions)
- `SUPABASE_REMEDIATION_REPORT.md` (new — this report)
- `scripts/cloudstream_registry_integration_test.ts` (ledger 16→17 + posture check)
- `scripts/cloudstream_phase4_integration_manager_test.ts` (ledger 13→14)
- `package.json` (test-chain registration of the new suite)
- `WORKLOG.md` (round entry)

**Commit SHA:**  on  (parent  on ) — pushed to .
