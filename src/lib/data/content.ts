export type ContentType = 'movie' | 'series' | 'anime';

export type MediaItem = {
  id: string;
  title: string;
  year: number;
  type: ContentType;
  maturity?: string;
  runtime: string;
  rating: number;
  genres: string[];
  description: string;
  poster: string;
  backdrop: string;
  accent: string;
  progress?: number;
  progressLabel?: string;
  resumeHref?: string;
  status?: string;
  episodes?: number;
  seasons?: number;
  tags?: string[];
};

const image = (id: string, width = 900) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=84`;

export const media: MediaItem[] = [
  {
    id: 'afterlight',
    title: 'Afterlight',
    year: 2024,
    type: 'movie',
    maturity: '16+',
    runtime: '2h 08m',
    rating: 8.4,
    genres: ['Sci-Fi', 'Drama', 'Mystery'],
    description: 'After a solar storm rewrites the night sky, a signal begins speaking to the only astronaut still listening.',
    poster: image('photo-1518709268805-4e9042af9f23', 720),
    backdrop: image('photo-1518709268805-4e9042af9f23', 1600),
    accent: '#9877ff',
    tags: ['MAVERO Original', '4K']
  },
  {
    id: 'the-last-signal',
    title: 'The Last Signal',
    year: 2023,
    type: 'movie',
    maturity: '13+',
    runtime: '1h 54m',
    rating: 8.1,
    genres: ['Thriller', 'Drama'],
    description: 'A remote radio operator hears a voice from a place that disappeared decades ago.',
    poster: image('photo-1500530855697-b586d89ba3ee', 720),
    backdrop: image('photo-1500530855697-b586d89ba3ee', 1600),
    accent: '#e09861',
    tags: ['Critics pick']
  },
  {
    id: 'nocturne-city',
    title: 'Nocturne City',
    year: 2022,
    type: 'series',
    maturity: '16+',
    runtime: '3 seasons',
    rating: 8.7,
    genres: ['Crime', 'Drama', 'Neo-noir'],
    description: 'Every secret in the city has a price. A detective with nothing left to lose starts keeping score.',
    poster: image('photo-1519681393784-d120267933ba', 720),
    backdrop: image('photo-1519681393784-d120267933ba', 1600),
    accent: '#6f86c7',
    progress: 61,
    progressLabel: 'S02 E04 · 32m left',
    seasons: 3,
    episodes: 24,
    tags: ['Continue watching']
  },
  {
    id: 'paper-moons',
    title: 'Paper Moons',
    year: 2025,
    type: 'anime',
    maturity: '13+',
    runtime: '12 episodes',
    rating: 9.0,
    genres: ['Fantasy', 'Romance', 'Adventure'],
    description: 'Two archivists discover that every lost memory leaves a moon somewhere in the city.',
    poster: image('photo-1500534314209-a25ddb2bd429', 720),
    backdrop: image('photo-1500534314209-a25ddb2bd429', 1600),
    accent: '#ee91c0',
    status: 'Currently airing',
    episodes: 12,
    tags: ['New episode']
  },
  {
    id: 'emberline',
    title: 'Emberline',
    year: 2024,
    type: 'movie',
    maturity: '16+',
    runtime: '1h 47m',
    rating: 7.9,
    genres: ['Action', 'Drama'],
    description: 'A courier crosses a burning border with one impossible package and no safe place to deliver it.',
    poster: image('photo-1500534623283-312aade485b7', 720),
    backdrop: image('photo-1500534623283-312aade485b7', 1600),
    accent: '#e16e5e',
    tags: ['Trending']
  },
  {
    id: 'atlas-9',
    title: 'Atlas 9',
    year: 2025,
    type: 'series',
    maturity: '13+',
    runtime: '1 season',
    rating: 8.6,
    genres: ['Sci-Fi', 'Adventure'],
    description: 'A missing expedition returns with a map of a world that should not exist.',
    poster: image('photo-1511497584788-876760111969', 720),
    backdrop: image('photo-1511497584788-876760111969', 1600),
    accent: '#69b7b2',
    seasons: 1,
    episodes: 8,
    tags: ['Top rated']
  },
  {
    id: 'velvet-sky',
    title: 'Velvet Sky',
    year: 2024,
    type: 'anime',
    maturity: '13+',
    runtime: '24 episodes',
    rating: 8.8,
    genres: ['Shonen', 'Fantasy'],
    description: 'A sky sailor and a runaway prince chart a course through a storm that remembers their names.',
    poster: image('photo-1519608487953-e999c86e7455', 720),
    backdrop: image('photo-1519608487953-e999c86e7455', 1600),
    accent: '#76a5d9',
    episodes: 24,
    status: 'Complete',
    tags: ['Fan favorite']
  },
  {
    id: 'quiet-geometry',
    title: 'Quiet Geometry',
    year: 2022,
    type: 'movie',
    maturity: '13+',
    runtime: '1h 38m',
    rating: 8.2,
    genres: ['Drama', 'Indie'],
    description: 'A sculptor begins finding tomorrow’s shapes in the dust of an empty gallery.',
    poster: image('photo-1500534623283-312aade485b7', 720),
    backdrop: image('photo-1519681393784-d120267933ba', 1600),
    accent: '#c3a36d',
    tags: ['Because you watched Afterlight']
  },
  {
    id: 'monsoon-radio',
    title: 'Monsoon Radio',
    year: 2025,
    type: 'series',
    maturity: '13+',
    runtime: '2 seasons',
    rating: 8.0,
    genres: ['Comedy', 'Drama'],
    description: 'A late-night radio show becomes the unexpected meeting point for a whole neighborhood.',
    poster: image('photo-1493246507139-91e8fad9978e', 720),
    backdrop: image('photo-1493246507139-91e8fad9978e', 1600),
    accent: '#cf8e6b',
    seasons: 2,
    episodes: 16,
    tags: ['Warm & witty']
  },
  {
    id: 'the-quiet-tide',
    title: 'The Quiet Tide',
    year: 2023,
    type: 'anime',
    maturity: '16+',
    runtime: '13 episodes',
    rating: 8.5,
    genres: ['Mystery', 'Drama'],
    description: 'At low tide, the town’s secrets return to shore. One girl decides to listen.',
    poster: image('photo-1470252649378-9c29740c9fa8', 720),
    backdrop: image('photo-1470252649378-9c29740c9fa8', 1600),
    accent: '#708f9d',
    episodes: 13,
    status: 'Complete',
    tags: ['Slow-burn mystery']
  }
];

export const featured = media[0];
export const continueWatching = media.filter((item) => item.progress);
export const trendingMovies = media.filter((item) => item.type === 'movie');
export const trendingSeries = media.filter((item) => item.type === 'series');
export const trendingAnime = media.filter((item) => item.type === 'anime');

export function getMedia(id: string) {
  return media.find((item) => item.id === id) ?? featured;
}

export function formatType(type: ContentType) {
  return type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Anime';
}
