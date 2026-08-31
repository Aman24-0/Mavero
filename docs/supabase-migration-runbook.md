# MAVERO Supabase Migration Runbook

**Purpose:** Step-by-step procedure for applying the Mavero Supabase migration chain to a database that is missing required schema. This is the safe, exact procedure for fixing databases that report errors like `relation "public.streaming_providers" does not exist` when applying provider migrations (Vidsrc, VidLink, NHDAPI, SuperEmbed, etc.).

---

## When to use this runbook

Use this runbook when:

- A provider migration fails with `ERROR: 42P01: relation "public.streaming_providers" does not exist`.
- A provider migration fails with `ERROR: 42P01: relation "public.streaming_sources" does not exist`.
- The Mavero Admin Providers/Sources pages (`/admin/providers`, `/admin/sources`) show no providers.
- The `/api/playback/resolve` endpoint returns `INTERNAL_RESOLUTION_ERROR` for every source.
- You are setting up a fresh Supabase project for Mavero and need to apply the full schema.

**Do NOT use this runbook if** your database already has `public.streaming_providers` and `public.streaming_sources`. If those tables already exist, jump to [Applying only new provider migrations](#applying-only-new-provider-migrations).

---

## Root cause

The Mavero provider/source migrations (Phase 7D/7E/7F) all `INSERT` into `public.streaming_providers` and `public.streaming_sources`. Those tables — and the entire streaming registry schema — are created by the **Phase 7A migration chain**. If the Phase 7A chain has not been applied to your database, every provider migration will fail with `relation ... does not exist`.

This is **not a bug in the provider migration**. The provider migration is correct. The database is simply behind the repository migration history.

The application code already expects these tables to exist:
- `src/lib/server/streaming/admin-service.ts` — Admin CRUD on `streaming_providers`, `streaming_sources`, `streaming_categories`, `streaming_source_categories`.
- `src/lib/server/streaming/public-config.ts` — Public reads from the mirror tables `streaming_public_providers`, `streaming_public_sources`, etc.
- `src/lib/server/resolver/service.ts` — Resolver reads `streaming_sources` and `streaming_providers` directly via the service-role client.
- `src/lib/server/supabase/database.types.ts` — TypeScript types include all streaming tables.

Without the Phase 7A schema, the **entire streaming layer** is non-functional — not just SuperEmbed.

---

## Migration dependency chain

All migrations are **idempotent** (`create table if not exists`, `drop trigger if exists`, `create or replace`). Re-applying them to a database that already has the schema is a safe no-op. Apply them in this exact timestamp order:

| # | File | What it creates |
|---|---|---|
| 1 | `20260820000000_phase5_auth_sync.sql` | `public.profiles`, `public.set_updated_at()`, `public.watch_progress`, `public.watch_history`, `public.favorites`, auth triggers, RLS. **Required dependency** for Phase 7A (uses `set_updated_at()` and `profiles`). |
| 2 | `20260820010000_phase7a_streaming_registry.sql` | `public.streaming_config_meta`, **`public.streaming_providers`**, **`public.streaming_sources`**, `public.streaming_categories`, `public.streaming_source_categories`, `bump_streaming_config_version()`, `is_admin()`, triggers, RLS, indexes. |
| 3 | `20260820011000_phase7a_public_views.sql` | Initial `streaming_public_*` views + grants. |
| 4 | `20260820012000_phase7a_template_constraints.sql` | Corrected `movie_template`/`series_template`/`anime_template` newline constraints. |
| 5 | `20260820013000_phase7a_security_invoker_views.sql` | Security-invoker views + least-privilege anon column grants. |
| 6 | `20260820014000_phase7a_public_mirror_tables.sql` | Materialized `streaming_public_*` mirror tables + `refresh_streaming_public_config()` function + triggers. |
| 7 | `20260820015000_phase7a_public_mirror_tables.sql` | Byte-identical duplicate of #6 (harmless no-op if #6 already ran). |
| 8 | `20260820016000_phase7a_revoke_base_public.sql` | Revokes anon access from base registry tables. |
| 9 | `20260820017000_phase7a_public_refresh_where.sql` | Refreshed `refresh_streaming_public_config()` with explicit predicates. |
| 10 | `20260821010000_phase7a_migration_repair.sql` | Fixes `is_admin()` and `refresh_streaming_public_config()` security attributes. |

After step 10, the streaming registry schema is complete. Then apply provider migrations in timestamp order:

| # | File | What it seeds |
|---|---|---|
| 11 | `20260820018000_phase7d_vidsrc_experimental.sql` | Vidsrc provider + source. |
| 12 | `20260821020000_phase7e_vidlink_experimental.sql` | VidLink provider + source. |
| 13 | `20260821030000_phase7e_sandbox_policy.sql` | Backfills `sandbox_policy: required` on existing embed sources. |
| 14 | `20260821040000_phase7e_peachify_experimental.sql` | Peachify. |
| 15 | `20260821050000_phase7e_rivestream_experimental.sql` | RiveStream. |
| 16 | `20260821060000_phase7e_nxsha_experimental.sql` | Nxsha. |
| 17 | `20260821070000_phase7e_nhdapi_experimental.sql` | NHDAPI. |
| 18 | `20260821080000_phase7e_mapple_experimental.sql` | Mapple. |
| 19 | `20260821090000_phase7e_cinesrc_experimental.sql` | CineSrc. |
| 20 | `20260821100000_phase7e_vidphantom_experimental.sql` | VidPhantom. |
| 21 | `20260821110000_phase7e_yapgrid_experimental.sql` | YapGrid. |
| 22 | `20260821120000_phase7e_vidapi_tw_experimental.sql` | VidAPI.tw. |
| 23 | `20260821130000_phase7e_vidapi_qzz_experimental.sql` | VidAPI.qzz.io. |
| 24 | `20260822000000_phase7f_provider_health.sql` | `streaming_provider_health` table + RLS. Required by the resolver health service. |
| 25 | `20260824000000_phase7e_superembed_experimental.sql` | SuperEmbed seapi.link API provider + source. |
| 26 | `20260824010000_phase7e_superembed_multiembed_experimental.sql` | SuperEmbed multiembed.mov iframe provider + source. |

Non-streaming migrations (`20260821000000_my_list_status.sql`, `20260822093000_persistent_favorite_deletions.sql`, `20260823080000_harden_favorite_deletion_rls.sql`, `20260823081000_harden_history_idempotency.sql`) can be applied in the same timestamp order; they touch account/favorites/history tables, not the streaming registry.

---

## Safe procedure (Supabase SQL Editor)

The Mavero repo does not use the Supabase CLI (`config.toml` is absent). Migrations are applied manually via the Supabase Dashboard SQL Editor.

### Step 0 — Verify which tables already exist

Before applying anything, check what your database already has. Run this in the Supabase SQL Editor:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'profiles', 'watch_progress', 'watch_history', 'favorites',
    'streaming_config_meta', 'streaming_providers', 'streaming_sources',
    'streaming_categories', 'streaming_source_categories',
    'streaming_public_providers', 'streaming_public_sources',
    'streaming_public_categories', 'streaming_public_source_categories',
    'streaming_provider_health'
  )
order by table_name;
```

Record the output. Any table NOT in the output is missing and must be created by applying the corresponding migration.

### Step 1 — Apply missing migrations in timestamp order

For each migration file in the chain above (steps 1–26), in order:

1. Open the file from `supabase/migrations/` in the Mavero repository.
2. Copy the entire file contents.
3. Paste into the Supabase Dashboard → SQL Editor → New query.
4. Click **Run**.
5. Verify no error. (Warnings like "relation already exists, skipping" are fine — that's the `if not exists` idempotency working.)

**You can safely re-run migrations that already applied.** Every migration in the chain is idempotent. If a migration was already applied, re-running it is a no-op.

**Do NOT skip ahead.** The chain has real dependencies:
- Phase 7A registry (`20260820010000`) requires `public.set_updated_at()` and `public.profiles` from Phase 5 (`20260820000000`).
- Phase 7A public mirror (`20260820014000`) requires the registry tables from `20260820010000`.
- Phase 7A migration repair (`20260821010000`) requires `refresh_streaming_public_config()` from `20260820014000`.
- Phase 7F health (`20260822000000`) requires `streaming_providers` and `streaming_sources`.
- Every provider migration (Phase 7D/7E) requires `streaming_providers` and `streaming_sources`.

### Step 2 — Verify the streaming registry exists

After applying the Phase 7A chain, re-run the verification query from Step 0. You should now see all the streaming tables listed.

### Step 3 — Verify providers were seeded

```sql
select slug, name, status, enabled, integration_type
from public.streaming_providers
order by name;

select source.slug as source_slug, source.name as source_name, source.ordering, source.status, source.enabled,
       provider.slug as provider_slug
from public.streaming_sources source
join public.streaming_providers provider on provider.id = source.provider_id
order by source.ordering, source.name;
```

You should see all seeded providers (Vidsrc, VidLink, NHDAPI, VidAPI.tw, VidAPI.qzz.io, Peachify, RiveStream, Nxsha, Mapple, CineSrc, VidPhantom, YapGrid, SuperEmbed, SuperEmbed Multiembed). All should be `enabled = false` and `status = 'experimental'` by default.

### Step 4 — Refresh the public mirror

The public mirror tables are auto-refreshed by triggers, but you can force a refresh to be certain:

```sql
select public.refresh_streaming_public_config();
```

### Step 5 — Verify the resolver works

The `/api/playback/resolve` endpoint should now return proper resolver errors (e.g. `RESOLUTION_UNAVAILABLE` for disabled sources) instead of `INTERNAL_RESOLUTION_ERROR`. Admin pages (`/admin/providers`, `/admin/sources`) should list all providers.

---

## Applying only new provider migrations

If your database already has `public.streaming_providers` and `public.streaming_sources` (verified via Step 0), you only need to apply new provider migrations. For example, to add SuperEmbed:

1. `20260824000000_phase7e_superembed_experimental.sql` (seapi.link API source)
2. `20260824010000_phase7e_superembed_multiembed_experimental.sql` (multiembed.mov iframe source)

Apply each via the Supabase SQL Editor as described in Step 1. Both are idempotent (`on conflict (slug) do nothing` and `on conflict (provider_id, slug) do nothing`) — re-running them is safe.

---

## What NOT to do

- **Do NOT** create duplicate `streaming_providers` / `streaming_sources` tables in the SuperEmbed migration. The Phase 7A chain owns those tables.
- **Do NOT** drop existing tables to "recreate" them. The migrations are idempotent for a reason.
- **Do NOT** modify unrelated application tables (`profiles`, `watch_progress`, `favorites`, etc.) unless a specific migration in the chain instructs it.
- **Do NOT** skip the Phase 5 migration — Phase 7A depends on `public.set_updated_at()` and `public.profiles` which Phase 5 defines.
- **Do NOT** apply migrations out of order. The dependency chain is real.
- **Do NOT** manually edit a migration file's SQL to "work around" a missing dependency. Apply the missing dependency instead.

---

## Existing data risk

**None.** Every migration in the Mavero chain is designed to be safe for an already-populated database:

- `create table if not exists` — no-op if the table exists.
- `drop trigger if exists` / `drop policy if exists` — no-op if absent, then recreate.
- `create or replace function` / `create or replace view` — replaces in place.
- `on conflict (slug) do nothing` / `on conflict (provider_id, slug) do nothing` — provider seeds are no-ops if the slug already exists.
- `alter table ... add constraint` (with prior `drop constraint if exists`) — safe to re-run.

Applying the full chain to a database that already has some of the schema will not delete any rows, drop any tables, or change any existing provider/source configuration. Existing data is at **no risk**.

---

## Troubleshooting

### "relation public.set_updated_at does not exist"
You skipped Phase 5 (`20260820000000_phase5_auth_sync.sql`). Apply it first.

### "relation public.profiles does not exist"
Same as above — Phase 5 defines `public.profiles`.

### "function public.refresh_streaming_public_config() does not exist"
You skipped `20260820014000_phase7a_public_mirror_tables.sql`. Apply it (it creates the function).

### "permission denied for table streaming_providers"
RLS policies are missing or the user is not authenticated. Apply `20260820010000` (creates policies) and `20260820013000` (security-invoker views). For Admin access, the user must have `role = 'admin'` in `public.profiles`.

### "duplicate key value violates unique constraint streaming_providers_slug_key"
The provider already exists. The migration uses `on conflict (slug) do nothing`, so this should not occur. If it does, you may have a partial application — check the provider table and re-run the migration.

### SuperEmbed migration still fails after Phase 7A
Verify the registry exists:
```sql
select count(*) from public.streaming_providers;
select count(*) from public.streaming_sources;
```
If both return a number (not an error), the registry exists and the SuperEmbed migration should succeed. If it still fails, paste the exact error into the Mavero worklog.
