-- Prevent duplicate history events when the client retries visibility or progress writes.
create unique index if not exists watch_history_user_event_unique_idx
  on public.watch_history (user_id, event_key);
