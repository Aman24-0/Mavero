import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewport = await readFile(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');
const shell = await readFile(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const controls = await readFile(new URL('../src/lib/components/player/PlayerControls.svelte', import.meta.url), 'utf8');

assert.match(viewport, /import\('hls\.js'\)/);
assert.match(viewport, /import\('dashjs'\)/);
assert.match(viewport, /canPlayType\('application\/vnd\.apple\.mpegurl'\)/);
assert.match(viewport, /hlsInstance\?\.destroy\(\)/);
assert.match(viewport, /dashInstance\?\.reset\(\)/);
assert.match(viewport, /on:error=\{\(\) => dispatch\('error'\)\}/);
assert.match(viewport, /dispatch\('audiotracks'/);
assert.match(viewport, /export function selectAudioTrack/);
assert.match(viewport, /kind="captions"/);
assert.match(viewport, /sandbox=\{sandboxAttribute\}/);
assert.match(shell, /on:audiotracks=\{handleAudioTracks\}/);
assert.match(shell, /viewport\?\.selectAudioTrack\(trackId\)/);
assert.match(shell, /class:landscape-controls-collapsed/);
assert.match(controls, /export let audioTracks/);
assert.match(controls, /onAudioTrack/);

console.log('Native player contract tests passed: browser-only HLS/DASH loaders, lifecycle cleanup, media error dispatch, audio-track hook, captions, sandboxed embeds, and Landscape preservation.');
