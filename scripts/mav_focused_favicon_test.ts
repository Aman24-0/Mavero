/**
 * MAVERO — Favicon configuration regression suite (focused audit fix, 2026-10).
 *
 * Confirmed root cause (verified live against production 2026-10-13):
 *   - https://maveroweb.space/favicon.ico returned the SvelteKit 404 page
 *     (HTTP 404, content-type text/html) instead of an image. Googlebot's
 *     standard favicon lookup hits GET /favicon.ico at the site root
 *     REGARDLESS of <link rel="icon"> tags elsewhere — so the missing
 *     /favicon.ico is why Google Search renders a generic globe icon
 *     for the site.
 *   - https://maveroweb.space/manifest.webmanifest was served with
 *     content-type application/octet-stream (Netlify's default for
 *     unknown extensions). Some browsers/PWA validators treat this as a
 *     malformed manifest — affecting PWA installability.
 *
 * Behaviour after the fix:
 *   - static/favicon.ico exists at the site root (SvelteKit serves
 *     static/ at the root). It is a multi-resolution .ico (16/32/48)
 *     built from the EXISTING brand PNG favicons — no new branding is
 *     invented.
 *   - app.html declares /favicon.ico as the explicit primary favicon
 *     (FIRST <link rel="icon"> tag, sizes="any").
 *   - netlify.toml serves /favicon.ico with content-type image/x-icon
 *     and long-cache headers; the PNG favicons at /icons/* get the
 *     same long-cache policy.
 *   - netlify.toml serves /manifest.webmanifest with content-type
 *     application/manifest+json (RFC 9239).
 *   - The existing PNG favicons + apple-touch-icon + manifest stay
 *     intact (no regression on the existing icon paths).
 *
 * Note: this suite is a STATIC-CODE + FILE-PRESENCE audit. It does NOT
 * fetch the production origin (the production origin will only reflect
 * these changes after the next deploy). The deploy is out of scope.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
const readBinary = (p: string) => readFileSync(resolve(root, p));

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n1 — static/favicon.ico exists at the site root');
{
  const icoPath = 'static/favicon.ico';
  ok(existsSync(resolve(root, icoPath)), '1a. static/favicon.ico exists (SvelteKit serves static/ at the site root)');
  if (existsSync(resolve(root, icoPath))) {
    const buf = readBinary(icoPath);
    // ICO file magic bytes: 00 00 01 00 (reserved=0, type=1=icon).
    ok(buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00, '1b. the file starts with the ICO magic bytes (00 00 01 00) — a valid Windows icon');
    const frameCount = buf.readUInt16LE(4);
    ok(frameCount >= 3, `1c. the .ico contains at least 3 frames (16/32/48 — got ${frameCount})`);
    // Parse the ICONDIRENTRY array to verify the embedded sizes.
    const sizes: number[] = [];
    for (let i = 0; i < frameCount; i += 1) {
      const entryOffset = 6 + i * 16;
      const w = buf[entryOffset] === 0 ? 256 : buf[entryOffset];
      const h = buf[entryOffset + 1] === 0 ? 256 : buf[entryOffset + 1];
      if (w === h) sizes.push(w);
    }
    ok(sizes.includes(16) && sizes.includes(32) && sizes.includes(48), `1d. the .ico embeds 16x16, 32x32 and 48x48 frames — got [${sizes.join(',')}]`);
    // Reasonable upper-bound file size: a multi-resolution ICO is typically
    // a few KB. Anything over 100KB would be suspicious (probably a
    // 512x512 PNG wrapped in ICO, which is wasteful for a favicon).
    const sizeKB = statSync(resolve(root, icoPath)).size / 1024;
    ok(sizeKB < 100, `1e. the .ico is a sensible size (<100KB — got ${sizeKB.toFixed(1)}KB)`);
  }
}

console.log('\n2 — app.html declares /favicon.ico as the primary favicon');
{
  const appHtml = read('src/app.html');
  // Strip HTML comments first so the "FIRST <link rel=icon>" is the first
  // ACTUAL tag, not a tag mentioned inside a comment.
  const appHtmlNoComments = appHtml.replace(/<!--[\s\S]*?-->/g, '');
  // The .ico link must be FIRST in the icon list (Google's documented
  // preference — legacy crawlers pick the first <link rel="icon">).
  const firstIconLinkMatch = appHtmlNoComments.match(/<link\s+rel="icon"[^>]*?>/);
  ok(firstIconLinkMatch !== null, '2a. at least one <link rel="icon"> tag exists in app.html (after stripping comments)');
  if (firstIconLinkMatch) {
    ok(firstIconLinkMatch[0].includes('href="/favicon.ico"'), `2b. the FIRST <link rel="icon"> tag points at /favicon.ico — got: ${firstIconLinkMatch[0]}`);
    ok(firstIconLinkMatch[0].includes('sizes="any"'), `2c. the primary favicon declares sizes="any" (Google's preferred attribute) — got: ${firstIconLinkMatch[0]}`);
  }
  // The existing PNG + apple-touch favicons are preserved.
  ok(appHtml.includes('href="/icons/favicon-32.png"'), '2d. the 32x32 PNG favicon is preserved');
  ok(appHtml.includes('href="/icons/favicon-16.png"'), '2e. the 16x16 PNG favicon is preserved');
  ok(appHtml.includes('href="/icons/mavero-192.png"'), '2f. the 192x192 PNG favicon is preserved');
  ok(appHtml.includes('rel="apple-touch-icon"'), '2g. the apple-touch-icon is preserved');
  ok(appHtml.includes('href="/manifest.webmanifest"'), '2h. the manifest link is preserved');
}

console.log('\n3 — netlify.toml sets the correct content-type for /favicon.ico and the manifest');
{
  const netlify = read('netlify.toml');
  // /favicon.ico: content-type image/x-icon + immutable cache.
  const icoHeaderStart = netlify.indexOf('for = "/favicon.ico"');
  ok(icoHeaderStart > -1, '3a. netlify.toml has a headers rule for /favicon.ico');
  if (icoHeaderStart > -1) {
    const icoHeader = netlify.slice(icoHeaderStart, icoHeaderStart + 400);
    ok(/content-type\s*=\s*"image\/x-icon"/.test(icoHeader), '3b. /favicon.ico is served with content-type image/x-icon');
    ok(/cache-control\s*=\s*"public,\s*max-age=31536000,\s*immutable"/.test(icoHeader), '3c. /favicon.ico is cached immutable for a year');
  }
  // /icons/*: immutable cache (the PNG favicons stay cached too).
  ok(/for\s*=\s*"\/icons\/\*"/.test(netlify), '3d. netlify.toml has a headers rule for /icons/*');
  // /manifest.webmanifest: content-type application/manifest+json (RFC 9239).
  const manifestHeaderStart = netlify.indexOf('for = "/manifest.webmanifest"');
  ok(manifestHeaderStart > -1, '3e. netlify.toml has a headers rule for /manifest.webmanifest');
  if (manifestHeaderStart > -1) {
    const manifestHeader = netlify.slice(manifestHeaderStart, manifestHeaderStart + 600);
    ok(/content-type\s*=\s*"application\/manifest\+json"/.test(manifestHeader), '3f. /manifest.webmanifest is served with content-type application/manifest+json (RFC 9239)');
  }
}

console.log('\n4 — the manifest references the existing brand PNG icons');
{
  const manifest = read('static/manifest.webmanifest');
  ok(manifest.includes('/icons/mavero-192.png'), '4a. the manifest references /icons/mavero-192.png');
  ok(manifest.includes('/icons/mavero-512.png'), '4b. the manifest references /icons/mavero-512.png');
  ok(manifest.includes('/icons/mavero-maskable-512.png'), '4c. the manifest references the maskable icon');
  // The manifest is unchanged by this fix — only its MIME type changed.
  ok(manifest.includes('"short_name": "MAVERO"'), '4d. the manifest retains the existing short_name');
}

console.log('\n5 — the brand PNG favicons still exist (no regression on the existing icon set)');
{
  ok(existsSync(resolve(root, 'static/icons/favicon-16.png')), '5a. static/icons/favicon-16.png exists');
  ok(existsSync(resolve(root, 'static/icons/favicon-32.png')), '5b. static/icons/favicon-32.png exists');
  ok(existsSync(resolve(root, 'static/icons/mavero-192.png')), '5c. static/icons/mavero-192.png exists');
  ok(existsSync(resolve(root, 'static/icons/mavero-512.png')), '5d. static/icons/mavero-512.png exists');
  ok(existsSync(resolve(root, 'static/icons/mavero-apple-touch.png')), '5e. static/icons/mavero-apple-touch.png exists');
  ok(existsSync(resolve(root, 'static/icons/mavero-maskable-512.png')), '5f. static/icons/mavero-maskable-512.png exists');
  ok(existsSync(resolve(root, 'static/icons/mavero-icon-source.svg')), '5g. the brand\'s authoritative SVG source is preserved');
}

console.log('\n6 — no second <link rel="manifest"> and no duplicate <link rel="icon"> href');
{
  const appHtml = read('src/app.html');
  // Exactly one manifest link.
  const manifestLinks = (appHtml.match(/<link rel="manifest"[^>]*>/g) ?? []);
  ok(manifestLinks.length === 1, `6a. exactly one <link rel="manifest"> tag — got ${manifestLinks.length}`);
  // No duplicate hrefs in the icon links.
  const iconHrefs = (appHtml.match(/<link rel="icon"[^>]*href="([^"]+)"/g) ?? [])
    .map((m) => m.match(/href="([^"]+)"/)![1]);
  const uniqueHrefs = new Set(iconHrefs);
  ok(uniqueHrefs.size === iconHrefs.length, `6b. every <link rel="icon"> href is unique — got [${iconHrefs.join(', ')}]`);
  // The apple-touch-icon link is unique too.
  const appleLinks = (appHtml.match(/<link rel="apple-touch-icon"[^>]*>/g) ?? []);
  ok(appleLinks.length === 1, `6c. exactly one <link rel="apple-touch-icon"> — got ${appleLinks.length}`);
}

console.log('\n7 — robots.txt + sitemap route are untouched (regression guard)');
{
  const robots = read('static/robots.txt');
  ok(robots.includes('Sitemap: https://maveroweb.space/sitemap.xml'), '7a. robots.txt still references the production sitemap');
  ok(robots.includes('Disallow: /admin'), '7b. robots.txt still disallows /admin');
  // The sitemap route handler is unchanged.
  const sitemap = read('src/routes/sitemap.xml/+server.ts');
  ok(sitemap.includes("'/movies'") && sitemap.includes("'/tv-shows'") && sitemap.includes("'/anime'") && sitemap.includes("'/'"), '7c. the sitemap still emits the verified static public pages only');
  // The sitemap source must NOT include the fixture catalog import (only the
  // remediation comments name it). Strip comments before asserting.
  const sitemapCode = sitemap
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  ok(!sitemapCode.includes('$lib/data/content'), '7d. the sitemap does NOT import the fixture catalog (no regression on Issue 1)');
}

console.log(`\nmav_focused_favicon_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
