-- MAV-FOCUSED — Add poster_path + backdrop_path to media_items.
--
-- Stores TMDB poster/backdrop relative paths (e.g. "/abc123.jpg") on the
-- canonical media_items row so the admin Media Library can render posters
-- without requesting TMDB on every page open.
--
-- Backward-compatible: nullable columns, no existing data modified.
-- The UI constructs the full image URL from the TMDB image configuration
-- + the stored relative path.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.media_items
  ADD COLUMN IF NOT EXISTS poster_path text;
ALTER TABLE public.media_items
  ADD COLUMN IF NOT EXISTS backdrop_path text;

-- Add CHECK constraints for reasonable path lengths.
ALTER TABLE public.media_items
  DROP CONSTRAINT IF EXISTS media_items_poster_path_check;
ALTER TABLE public.media_items
  ADD CONSTRAINT media_items_poster_path_check CHECK (poster_path IS NULL OR (length(poster_path) >= 1 AND length(poster_path) <= 500));

ALTER TABLE public.media_items
  DROP CONSTRAINT IF EXISTS media_items_backdrop_path_check;
ALTER TABLE public.media_items
  ADD CONSTRAINT media_items_backdrop_path_check CHECK (backdrop_path IS NULL OR (length(backdrop_path) >= 1 AND length(backdrop_path) <= 500));
