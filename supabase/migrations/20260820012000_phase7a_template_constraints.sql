-- MAVERO Phase 7A: correct inert template structural checks
-- Use character-position checks instead of backslash-sensitive regex literals.

alter table public.streaming_sources drop constraint if exists streaming_sources_movie_template_check;
alter table public.streaming_sources drop constraint if exists streaming_sources_series_template_check;
alter table public.streaming_sources drop constraint if exists streaming_sources_anime_template_check;

alter table public.streaming_sources
  add constraint streaming_sources_movie_template_check
  check (movie_template is null or (position(chr(10) in movie_template) = 0 and position(chr(13) in movie_template) = 0));

alter table public.streaming_sources
  add constraint streaming_sources_series_template_check
  check (series_template is null or (position(chr(10) in series_template) = 0 and position(chr(13) in series_template) = 0));

alter table public.streaming_sources
  add constraint streaming_sources_anime_template_check
  check (anime_template is null or (position(chr(10) in anime_template) = 0 and position(chr(13) in anime_template) = 0));
