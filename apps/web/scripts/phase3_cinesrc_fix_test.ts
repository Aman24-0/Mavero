import assert from 'node:assert/strict';
import type { PlayerSource } from '$lib/shared/player';
import { CineSrcPlayerAdapter } from '$lib/client/player/providers/cinesrc-adapter';
import { CINESRC_CAPABILITIES } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// Phase 3 corrective-fix test: prove CineSrc commands are posted to
// iframe.contentWindow.postMessage() — NOT parent window.postMessage().
//
// This test creates separate spies for:
//   - parent window postMessage (the WRONG target)
//   - iframe.contentWindow.postMessage (the CORRECT target)
//
// Then verifies:
//   1. CineSrc play() calls iframe.contentWindow.postMessage.
//   2. Parent window postMessage is NOT used for the command.
//   3. Correct target origin is supplied ('https://cinesrc.st').
//   4. Correct CineSrc command payload is supplied ({type:'cinesrc:command',
//      command, args, id}).
//   5. Missing iframe/contentWindow returns a safe `not-ready` result.
//   6. Destroy clears the iframe reference — commands after destroy return
//      `not-ready`.

// --- Mock setup ---

// Track every call to each postMessage spy.
let parentWindowPostMessageCalls: { payload: unknown; origin: string }[] = [];
let iframeContentWindowPostMessageCalls: { payload: unknown; origin: string }[] = [];

// Mock iframe contentWindow with a postMessage spy.
const mockContentWindow = {
  postMessage: (payload: unknown, origin: string) => {
    iframeContentWindowPostMessageCalls.push({ payload, origin });
  },
};

// Mock iframe element — contentWindow returns the mock.
const mockIframe = {
  contentWindow: mockContentWindow,
} as unknown as HTMLIFrameElement;

// Mock parent window postMessage (the WRONG target).
const mockParentWindow = {
  postMessage: (payload: unknown, origin: string) => {
    parentWindowPostMessageCalls.push({ payload, origin });
  },
  addEventListener: (_type: string, _listener: (event: unknown) => void) => {},
  removeEventListener: (_type: string, _listener: (event: unknown) => void) => {},
  dispatchEvent: (_event: unknown) => true,
};

// Install mocks globally.
(globalThis as unknown as { window: typeof mockParentWindow }).window = mockParentWindow;

// Minimal MessageEvent mock (not needed for command tests, but required
// for adapter construction).
class MockMessageEvent {
  type: string;
  origin: string;
  data: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown } = {}) {
    this.type = type;
    this.origin = init.origin ?? '';
    this.data = init.data;
  }
}
(globalThis as unknown as { MessageEvent: typeof MockMessageEvent }).MessageEvent = MockMessageEvent;

// --- Tests ---

const adapter = new CineSrcPlayerAdapter();
const events: PlayerEvent[] = [];
adapter.onEvent((event) => events.push(event));

const cinesrcSource: PlayerSource = {
  type: 'embed',
  url: 'https://cinesrc.st/embed/movie/550',
  providerId: 'p-cinesrc',
  sourceId: 's-cinesrc',
  mediaType: 'movie',
};

assert.equal(adapter.canHandle(cinesrcSource), true, 'adapter handles CineSrc source');

// Load the adapter — NO iframe yet (simulates real lifecycle: iframe hasn't rendered).
adapter.load({ source: cinesrcSource });

// --- Test 1: Before setIframe, commands return not-ready ---

parentWindowPostMessageCalls = [];
iframeContentWindowPostMessageCalls = [];

const playResultBeforeIframe = await adapter.play!();
assert.equal(playResultBeforeIframe.ok, false, 'play before iframe: ok=false');
assert.equal(playResultBeforeIframe.reason, 'not-ready', 'play before iframe: reason=not-ready');
assert.equal(parentWindowPostMessageCalls.length, 0, 'parent window postMessage NOT called before iframe');
assert.equal(iframeContentWindowPostMessageCalls.length, 0, 'iframe.contentWindow postMessage NOT called before iframe');

const seekResultBeforeIframe = await adapter.seek!(120);
assert.equal(seekResultBeforeIframe.ok, false, 'seek before iframe: ok=false');
assert.equal(seekResultBeforeIframe.reason, 'not-ready', 'seek before iframe: reason=not-ready');

// --- Test 2: After setIframe, commands go to iframe.contentWindow ---

adapter.setIframe(mockIframe);
parentWindowPostMessageCalls = [];
iframeContentWindowPostMessageCalls = [];

const playResult = await adapter.play!();
assert.equal(playResult.ok, true, 'play after iframe: ok=true');
assert.equal(iframeContentWindowPostMessageCalls.length, 1, 'iframe.contentWindow.postMessage called exactly once');
assert.equal(parentWindowPostMessageCalls.length, 0, 'parent window.postMessage NOT called (this is the bug we fixed)');

// --- Test 3: Correct target origin ---
const playCall = iframeContentWindowPostMessageCalls[0];
assert.equal(playCall.origin, 'https://cinesrc.st', 'target origin is https://cinesrc.st');

// --- Test 4: Correct command payload ---
const playPayload = playCall.payload as Record<string, unknown>;
assert.equal(playPayload.type, 'cinesrc:command', 'payload type is cinesrc:command');
assert.equal(playPayload.command, 'play', 'payload command is play');
assert.ok(Array.isArray(playPayload.args), 'payload args is an array');
assert.equal((playPayload.args as unknown[]).length, 0, 'play has no args');
assert.ok(typeof playPayload.id === 'number', 'payload id is a number (for correlation)');

// --- Test 5: seek command ---
parentWindowPostMessageCalls = [];
iframeContentWindowPostMessageCalls = [];

const seekResult = await adapter.seek!(120);
assert.equal(seekResult.ok, true, 'seek: ok=true');
assert.equal(iframeContentWindowPostMessageCalls.length, 1, 'seek: iframe.contentWindow.postMessage called');
assert.equal(parentWindowPostMessageCalls.length, 0, 'seek: parent window NOT called');

const seekPayload = iframeContentWindowPostMessageCalls[0].payload as Record<string, unknown>;
assert.equal(seekPayload.command, 'seek', 'seek payload command is seek');
assert.deepEqual(seekPayload.args, [120], 'seek payload args is [120]');

// --- Test 6: setVolume command ---
iframeContentWindowPostMessageCalls = [];
const volumeResult = await adapter.setVolume!(0.5);
assert.equal(volumeResult.ok, true, 'setVolume: ok=true');
const volumePayload = iframeContentWindowPostMessageCalls[0].payload as Record<string, unknown>;
assert.equal(volumePayload.command, 'setVolume', 'setVolume payload command');
assert.deepEqual(volumePayload.args, [0.5], 'setVolume payload args is [0.5]');

// --- Test 7: Destroy clears iframe — commands after destroy return not-ready ---

adapter.destroy();
parentWindowPostMessageCalls = [];
iframeContentWindowPostMessageCalls = [];

const postDestroyPlay = await adapter.play!();
assert.equal(postDestroyPlay.ok, false, 'play after destroy: ok=false');
assert.equal(postDestroyPlay.reason, 'not-ready', 'play after destroy: reason=not-ready');
assert.equal(iframeContentWindowPostMessageCalls.length, 0, 'destroyed adapter does not call iframe.contentWindow');
assert.equal(parentWindowPostMessageCalls.length, 0, 'destroyed adapter does not call parent window');

// --- Test 8: Capabilities unchanged ---
const caps = adapter.getCapabilities();
assert.equal(caps.play, true, 'CineSrc play capability preserved');
assert.equal(caps.seek, true, 'CineSrc seek capability preserved');
assert.equal(caps.volume, true, 'CineSrc volume capability preserved');

console.log('Phase 3 CineSrc command-target fix tests passed: (1) before setIframe commands return not-ready, (2) after setIframe play() calls iframe.contentWindow.postMessage NOT parent window, (3) correct target origin https://cinesrc.st, (4) correct payload {type:cinesrc:command, command, args, id}, (5) seek(120) targets iframe.contentWindow with [120] args, (6) setVolume(0.5) targets iframe.contentWindow, (7) after destroy commands return not-ready and no postMessage is called, (8) capabilities unchanged.');
