import type { ContentType } from '$data/content';

/**
 * Navigation & Settings Redesign, Phase 4 — shared destination labels.
 *
 * ONE source of truth for how each content destination is presented in
 * user-facing copy (headings, titles, rails, meta). Consumed by
 * ExplorerPage (the Movies / TV Shows / Anime Explorers). Keeping this
 * map shared prevents the "Seriess"-class pluralization drift this
 * redesign already fixed once.
 */
export const DESTINATION_LABELS: Record<ContentType, { plural: string; singular: string; prose: string; description: string }> = {
  movie: {
    plural: 'Movies',
    singular: 'movie',
    prose: 'movies',
    description: 'Browse the latest movies, ranked and ready for tonight.'
  },
  series: {
    plural: 'TV Shows',
    singular: 'TV show',
    prose: 'TV shows',
    description: 'Browse the latest TV shows, ranked and ready for tonight.'
  },
  anime: {
    plural: 'Anime',
    singular: 'anime',
    prose: 'anime',
    description: 'Browse the latest anime, ranked and ready for tonight.'
  }
};

/** Canonical route for each content destination (Phase 1). */
export const DESTINATION_ROUTES: Record<ContentType, string> = {
  movie: '/movies',
  series: '/tv-shows',
  anime: '/anime'
};
