-- MAVERO My List management: atomic batch removal of favorites.
--
-- Adds a `public.batch_remove_favorites(p_items jsonb)` RPC that, for each
-- supplied `{contentType, contentId, deletedAt}` identity, atomically:
--   1. validates contentType (movie|series|anime) and non-empty contentId,
--   2. upserts a `favorite_deletions` tombstone (so the title cannot be
--      resurrected by a stale cloud sync),
--   3. deletes the matching `favorites` row,
--   4. deletes ALL `watch_progress` rows for that title (every season:episode,
--      matched via the `contentType:contentId:` progress_key prefix).
--
-- watch_history is intentionally NOT touched — history is a separate,
-- append-only audit log and removing a My List favorite must not erase it.
--
-- The function is SECURITY INVOKER + RLS-scoped: it reads `auth.uid()` for
-- the calling user and never accepts a `user_id` parameter from the client.
-- All operations are filtered to that single user_id, so a forged payload
-- cannot affect another user's library.
--
-- Returns `table(content_type text, content_id text, ok boolean, error text)`
-- so the caller can report partial success per identity (a single bad row
-- does not abort the whole batch).

create or replace function public.batch_remove_favorites(p_items jsonb)
returns table(content_type text, content_id text, ok boolean, error text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  item jsonb;
  v_content_type text;
  v_content_id text;
  v_favorite_key text;
  v_deleted_at timestamptz;
  v_user uuid := auth.uid();
begin
  -- Anonymous / unauthenticated callers get nothing back. The API endpoint
  -- already returns 401 before reaching this function, but defense in depth.
  if v_user is null then
    return;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return;
  end if;

  for item in select * from jsonb_array_elements(p_items)
  loop
    v_content_type := item->>'contentType';
    v_content_id   := item->>'contentId';
    v_deleted_at   := coalesce((item->>'deletedAt')::timestamptz, timezone('utc', now()));

    -- Per-row validation: invalid identities are reported as `ok=false`
    -- but do NOT abort the batch. The transaction commits whatever subset
    -- succeeded.
    if v_content_type not in ('movie', 'series', 'anime')
       or length(trim(coalesce(v_content_id, ''))) = 0 then
      content_type := v_content_type;
      content_id   := v_content_id;
      ok           := false;
      error        := 'invalid identity';
      return next;
      continue;
    end if;

    v_favorite_key := v_content_type || ':' || v_content_id;

    -- 1. Upsert the deletion tombstone (greatest(deleted_at) wins so a
    --    re-delete after a fresh add still suppresses the older add).
    insert into public.favorite_deletions (user_id, favorite_key, content_type, content_id, deleted_at)
    values (v_user, v_favorite_key, v_content_type, v_content_id, v_deleted_at)
    on conflict (user_id, favorite_key) do update
      set content_type = excluded.content_type,
          content_id   = excluded.content_id,
          deleted_at   = greatest(public.favorite_deletions.deleted_at, excluded.deleted_at);

    -- 2. Delete the favorite row (if any). Safe to no-op if absent.
    delete from public.favorites
     where user_id = v_user
       and favorite_key = v_favorite_key;

    -- 3. Delete ALL watch_progress rows for this title (every season:episode).
    --    The progress_key pattern is `contentType:contentId:season:episode`,
    --    so the prefix match gets every episode in one statement.
    delete from public.watch_progress
     where user_id = v_user
       and progress_key like v_favorite_key || ':%';

    -- watch_history is intentionally NOT deleted here. History is a
    -- separate audit log; removing a My List favorite must not erase it.

    content_type := v_content_type;
    content_id   := v_content_id;
    ok           := true;
    error        := null;
    return next;
  end loop;
end;
$$;

-- SECURITY INVOKER means the function runs with the caller's privileges
-- (and is therefore RLS-scoped to the caller's own rows). Only
-- authenticated users can call it.
revoke all on function public.batch_remove_favorites(jsonb) from public, anon;
grant execute on function public.batch_remove_favorites(jsonb) to authenticated;
