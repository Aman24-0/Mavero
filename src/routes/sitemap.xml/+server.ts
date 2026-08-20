import { media } from '$lib/data/content';
import type { RequestHandler } from './$types';

const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] ?? character);

export const GET: RequestHandler = ({ url }) => {
  const paths = new Set(['/discover', '/discover/movies', '/discover/series', '/discover/anime']);
  for (const item of media) paths.add(`/${item.type}/${item.id}`);
  const body = [...paths].map((path) => `  <url><loc>${escapeXml(`${url.origin}${path}`)}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' } });
};
