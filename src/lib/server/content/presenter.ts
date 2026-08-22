import type { MediaItem } from '$data/content';
import type { NormalizedMediaItem } from './types';

function neutralImage(label: string, mode: 'poster' | 'backdrop') {
  const width = mode === 'poster' ? 720 : 1280;
  const height = mode === 'poster' ? 1080 : 720;
  const safeLabel = label.replace(/[<>&"']/g, '');
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#171a24"/><circle cx="${width / 2}" cy="${height / 2 - 34}" r="42" fill="#8b5cf6" opacity=".2"/><path d="M${width / 2 - 18} ${height / 2 - 34}l36 0M${width / 2} ${height / 2 - 52}v36" stroke="#a78bfa" stroke-width="4" stroke-linecap="round"/><text x="50%" y="${height / 2 + 58}" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="22">${safeLabel}</text></svg>`)}`;
}

export function toMediaItem(item: NormalizedMediaItem): MediaItem {
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    type: item.type,
    maturity: item.maturity,
    runtime: item.runtime,
    rating: item.rating,
    genres: item.genres,
    description: item.description,
    poster: item.poster || neutralImage(item.title, 'poster'),
    backdrop: item.backdrop || neutralImage(item.title, 'backdrop'),
    accent: item.accent,
    progress: item.progress,
    progressLabel: item.progressLabel,
    status: item.status,
    episodes: item.episodes,
    seasons: item.seasons,
    tags: item.tags,
    trailerKey: item.trailerKey,
    externalIds: item.externalIds
  };
}
