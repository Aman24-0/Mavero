import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// MAVERO — Icon / PWA Asset Regression Test
//
// Verifies the redesigned Mavero app icon assets, manifest references,
// and all icon references across the codebase.

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const repoRoot = new URL('../', import.meta.url).pathname;
const iconsDir = join(repoRoot, 'static', 'icons');

// ============================================================
// 1. Icon asset files exist
// ============================================================
console.log('\n1. Icon asset files exist');

const requiredIcons = [
  { file: 'mavero-192.png', minSize: 1024, desc: '192x192 PWA manifest icon' },
  { file: 'mavero-512.png', minSize: 4096, desc: '512x512 PWA manifest icon' },
  { file: 'mavero-maskable-512.png', minSize: 4096, desc: '512x512 maskable PWA icon' },
  { file: 'mavero-apple-touch.png', minSize: 1024, desc: '180x180 Apple touch icon' },
  { file: 'favicon-32.png', minSize: 100, desc: '32x32 browser favicon' },
  { file: 'favicon-16.png', minSize: 100, desc: '16x16 browser favicon' },
  { file: 'mavero-icon-source.svg', minSize: 500, desc: 'SVG source artwork' },
];

for (const { file, minSize, desc } of requiredIcons) {
  const fullPath = join(iconsDir, file);
  assert.ok(existsSync(fullPath), `${file} exists (${desc})`);
  const stat = statSync(fullPath);
  assert.ok(stat.size >= minSize, `${file} is >= ${minSize} bytes (got ${stat.size})`);
}
ok('All required icon asset files exist with reasonable sizes');

// ============================================================
// 2. Manifest is valid JSON with correct icon references
// ============================================================
console.log('\n2. Manifest valid with correct icon references');

const manifestPath = join(repoRoot, 'static', 'manifest.webmanifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.display, 'standalone', 'manifest display = standalone');
assert.equal(manifest.background_color, '#06060a', 'manifest background_color preserved');
assert.equal(manifest.theme_color, '#06060a', 'manifest theme_color preserved');
assert.equal(manifest.start_url, '/discover', 'manifest start_url preserved');
assert.equal(manifest.scope, '/', 'manifest scope preserved');

// Must have at least 192, 512, and maskable icons.
const icons = manifest.icons;
assert.ok(Array.isArray(icons) && icons.length >= 3, 'manifest has >= 3 icon entries');

const has192 = icons.some((i: any) => i.sizes === '192x192' && i.src === '/icons/mavero-192.png' && i.type === 'image/png');
assert.ok(has192, 'manifest has 192x192 icon pointing to /icons/mavero-192.png');

const has512 = icons.some((i: any) => i.sizes === '512x512' && i.src === '/icons/mavero-512.png' && i.type === 'image/png');
assert.ok(has512, 'manifest has 512x512 icon pointing to /icons/mavero-512.png');

const hasMaskable = icons.some((i: any) => i.sizes === '512x512' && i.src === '/icons/mavero-maskable-512.png' && i.purpose === 'maskable');
assert.ok(hasMaskable, 'manifest has maskable 512x512 icon with purpose=maskable');

// The 192 and 512 icons should have purpose "any" (not "any maskable"
// — maskable is a separate entry now).
const icon192 = icons.find((i: any) => i.sizes === '192x192');
assert.equal(icon192.purpose, 'any', '192 icon purpose = any');
const icon512 = icons.find((i: any) => i.sizes === '512x512' && i.purpose !== 'maskable');
assert.ok(icon512, '512 icon with purpose=any exists');
assert.equal(icon512.purpose, 'any', '512 icon purpose = any');
ok('Manifest valid: 192(any) + 512(any) + 512(maskable) icons, all metadata preserved');

// ============================================================
// 3. Favicon reference exists in app.html
// ============================================================
console.log('\n3. Favicon references in app.html');

const appHtml = readFileSync(join(repoRoot, 'src', 'app.html'), 'utf8');
assert.match(appHtml, /<link rel="icon" type="image\/png" sizes="32x32" href="\/icons\/favicon-32\.png"/,
  'app.html has 32x32 favicon link');
assert.match(appHtml, /<link rel="icon" type="image\/png" sizes="16x16" href="\/icons\/favicon-16\.png"/,
  'app.html has 16x16 favicon link');
assert.match(appHtml, /<link rel="icon" type="image\/png" sizes="192x192" href="\/icons\/mavero-192\.png"/,
  'app.html has 192x192 favicon link');
ok('Favicon references (16/32/192) exist in app.html');

// ============================================================
// 4. Apple touch icon reference exists
// ============================================================
console.log('\n4. Apple touch icon reference');

assert.match(appHtml, /<link rel="apple-touch-icon" href="\/icons\/mavero-apple-touch\.png"/,
  'app.html has apple-touch-icon pointing to mavero-apple-touch.png');
ok('Apple touch icon reference points to mavero-apple-touch.png');

// ============================================================
// 5. Offline page references a valid icon asset
// ============================================================
console.log('\n5. Offline page icon reference');

const offlineHtml = readFileSync(join(repoRoot, 'static', 'offline.html'), 'utf8');
assert.match(offlineHtml, /<img src="\/icons\/mavero-apple-touch\.png"/,
  'offline.html references mavero-apple-touch.png');
// The referenced file must exist.
assert.ok(existsSync(join(iconsDir, 'mavero-apple-touch.png')),
  'mavero-apple-touch.png exists (referenced by offline.html)');
ok('Offline page references a valid icon asset');

// ============================================================
// 6. PwaExperience install banner references a valid icon
// ============================================================
console.log('\n6. PwaExperience icon reference');

const pwaSource = readFileSync(join(repoRoot, 'src', 'lib', 'components', 'PwaExperience.svelte'), 'utf8');
assert.match(pwaSource, /\/icons\/mavero-apple-touch\.png/,
  'PwaExperience references mavero-apple-touch.png');
ok('PwaExperience install banner references a valid icon');

// ============================================================
// 7. SVG source exists and is valid
// ============================================================
console.log('\n7. SVG source artwork');

const svgPath = join(iconsDir, 'mavero-icon-source.svg');
const svgSource = readFileSync(svgPath, 'utf8');
assert.match(svgSource, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
  'SVG has correct xmlns');
assert.match(svgSource, /viewBox="0 0 512 512"/,
  'SVG has 512x512 viewBox');
assert.match(svgSource, /mGradient/,
  'SVG has M gradient definition');
assert.match(svgSource, /#f5f5f5/,
  'SVG uses white/off-white (#f5f5f5) for the M — matches Mavero UI');
assert.match(svgSource, /#d0d0d0/,
  'SVG uses off-white gradient end (#d0d0d0) — subtle depth without color');
assert.match(svgSource, /bgGlass/,
  'SVG has dark glass background');
assert.match(svgSource, /bgClip/,
  'SVG has rounded-square background clip');
// The SVG must contain the M shape (path data).
assert.match(svgSource, /fill="url\(#mGradient\)"/,
  'SVG has M shape with white gradient');
// Must NOT contain purple/violet/neon colors.
assert.doesNotMatch(svgSource, /#9b6dff|#b894ff|#7c4ddb|#d4bfff|#e0ccff/,
  'SVG must NOT contain purple/violet colors (dark/white design only)');
// Must NOT contain a play triangle (removed per design direction).
assert.doesNotMatch(svgSource, /fill="#0d0a18"/,
  'SVG must NOT contain a play triangle cut (play motif removed)');
ok('SVG source artwork valid: white M + dark glass bg, no purple/neon, no play triangle');

// ============================================================
// 8. No old/accidental icon references remain
// ============================================================
console.log('\n8. No old accidental icon references');

// The old mavero-192.png was used for both favicon AND apple-touch-icon.
// Now favicon uses favicon-32/16.png and apple-touch uses
// mavero-apple-touch.png. The mavero-192.png is still used in the
// manifest (purpose=any) and as a 192 favicon — that's correct.
// But it should NOT be used as apple-touch-icon or the sole favicon.
assert.doesNotMatch(appHtml, /<link rel="apple-touch-icon" href="\/icons\/mavero-192\.png"/,
  'app.html does NOT use mavero-192.png as apple-touch-icon (uses mavero-apple-touch.png)');
assert.doesNotMatch(appHtml, /<link rel="icon" href="\/icons\/mavero-192\.png" \/>/,
  'app.html does NOT use mavero-192.png as the sole favicon (uses favicon-32/16 + 192)');
ok('No old accidental icon references (apple-touch + favicon updated)');

// ============================================================
// 9. Service worker caching behavior unchanged
// ============================================================
console.log('\n9. Service worker caching unchanged');

const swSource = readFileSync(join(repoRoot, 'static', 'sw.js'), 'utf8');
assert.match(swSource, /const VERSION = 'mavero-shell-v1'/,
  'SW version unchanged');
assert.match(swSource, /url\.pathname\.startsWith\('\/icons\/'\)/,
  'SW still caches /icons/ on-demand (isSafeStaticRequest)');
// SAFE_ASSETS should still contain the original 4 entries.
assert.match(swSource, /SAFE_ASSETS = \[[\s\S]*?OFFLINE_URL,[\s\S]*?'\/manifest\.webmanifest',[\s\S]*?'\/icons\/mavero-192\.png',[\s\S]*?'\/icons\/mavero-512\.png'/,
  'SW SAFE_ASSETS unchanged (offline + manifest + 192 + 512)');
ok('Service worker caching behavior unchanged (version + SAFE_ASSETS + isSafeStaticRequest)');

// ============================================================
// 10. Manifest remains valid JSON (no syntax errors)
// ============================================================
console.log('\n10. Manifest is valid JSON');

// If we got here, JSON.parse didn't throw. Verify the structure.
assert.ok(typeof manifest === 'object' && manifest !== null, 'manifest is an object');
assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest.name is a non-empty string');
assert.ok(typeof manifest.short_name === 'string' && manifest.short_name.length > 0, 'manifest.short_name is a non-empty string');
assert.ok(Array.isArray(manifest.icons), 'manifest.icons is an array');
for (const icon of manifest.icons) {
  assert.ok(typeof icon.src === 'string', 'each icon has src');
  assert.ok(typeof icon.sizes === 'string', 'each icon has sizes');
  assert.ok(typeof icon.type === 'string', 'each icon has type');
}
ok('Manifest is valid JSON with all required fields');

console.log(`\nIcon / PWA asset tests passed (${passed} check groups).`);
