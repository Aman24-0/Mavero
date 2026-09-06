-- Evaluate auth.uid() once per statement instead of once per row for better RLS query plans.
drop policy if exists favorite_deletions_select_own on public.favorite_deletions;
create policy favorite_deletions_select_own on public.favorite_deletions
  for select using (user_id = (select auth.uid()));

drop policy if exists favorite_deletions_insert_own on public.favorite_deletions;
create policy favorite_deletions_insert_own on public.favorite_deletions
  for insert with check (user_id = (select auth.uid()));

drop policy if exists favorite_deletions_update_own on public.favorite_deletions;
create policy favorite_deletions_update_own on public.favorite_deletions
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists favorite_deletions_delete_own on public.favorite_deletions;
create policy favorite_deletions_delete_own on public.favorite_deletions
  for delete using (user_id = (select auth.uid()));
