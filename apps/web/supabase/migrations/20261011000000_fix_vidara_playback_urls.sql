-- Phase 6 follow-up: fix existing Vidara playback URLs in media_assets.
--
-- Migration 20261010000000_vidara_embed_url_fix.sql updated the
-- streaming_providers.capabilities allowed_embed_origins to include
-- the correct 'https://vidara.to' domain, but it did NOT rewrite the
-- playback_url values already stored on media_assets rows. Those rows
-- still point at the old share/download page
-- 'https://vidara.so/v/<code>' which renders the Vidara landing page
-- instead of the embedded player, so affected assets are unplayable
-- in the Mavero player iframe.
--
-- This migration rewrites every media_assets.playback_url that still
-- uses the old 'https://vidara.so/v/<code>' form to the correct embed
-- form 'https://vidara.to/e/<code>'. It only touches URLs that start
-- with 'https://vidara.so/v/' — all other URLs (Abyss player URLs,
-- already-converted Vidara URLs, any future provider URLs) are left
-- untouched.
--
-- Idempotent: once a URL has been converted to 'https://vidara.to/e/'
-- it no longer matches the WHERE clause, so re-running this migration
-- is a no-op. Safe to run multiple times.

UPDATE public.media_assets
SET playback_url = REPLACE(playback_url, 'https://vidara.so/v/', 'https://vidara.to/e/')
WHERE playback_url LIKE 'https://vidara.so/v/%';
