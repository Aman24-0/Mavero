-- Phase 6b — Optimize user_streaming_credentials RLS init-plan usage.
--
-- Supabase Performance Advisor reports:
--   auth_rls_initplan: public.user_streaming_credentials
--   policy: "Users manage own streaming credentials"
--   Current expression: auth.uid() = user_id
--
-- The bare auth.uid() form evaluates once per ROW, not once per STATEMENT.
-- The Supabase-recommended initplan-safe form (select auth.uid()) evaluates
-- once per statement, producing a better query plan.
--
-- This table was created outside of the tracked migrations (likely via the
-- Supabase dashboard or a now-deleted migration). It exists in the
-- production database but not in the repository's supabase/migrations/
-- directory. This migration is ADDITIVE: it drops and recreates the
-- existing policy with the optimized expression, preserving the EXACT same
-- authorization semantics.
--
-- PRESERVED:
--   * Policy name: "Users manage own streaming credentials"
--   * TO authenticated
--   * FOR ALL (select + insert + update + delete)
--   * USING: user identity check
--   * WITH CHECK: user identity check
--   * RLS enabled on the table (not altered here)
--   * No new grants or revokes
--   * No table schema changes
--
-- The ONLY change is: auth.uid() → (select auth.uid()) in both USING
-- and WITH CHECK clauses.

drop policy if exists "Users manage own streaming credentials" on public.user_streaming_credentials;

create policy "Users manage own streaming credentials"
on public.user_streaming_credentials
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
