// Production-hardening round — INSTANT embed-iframe teardown on navigation.
//
// THE PROBLEM (user report): with a heavy cross-origin provider embed
// (VidRift / VidCore / vidsrc / cineverse …) playing in the watch page,
// pressing Back took 3-4 seconds. Teardown of the watch route itself is
// already clean (the progress writer flushes are fire-and-forget and
// PlaybackManager.dispose() is synchronous — nothing in the route awaits
// anything), so the delay was NOT app logic: it is the BROWSER's
// browsing-context destruction. When Svelte swaps the DOM at the end of a
// client-side navigation, detaching a live cross-origin <iframe> makes
// the engine synchronously tear down that document — every worker,
// decoder, media element and open connection the provider page spawned —
// inside the SAME task as the navigation's DOM update. Heavy embeds block
// the main thread for seconds, so the back transition visually "hangs".
//
// THE FIX: neutralize the embed BEFORE the navigation's DOM swap. The
// moment a navigation away from the player is confirmed, we set the
// iframe's src to 'about:blank'. That starts an asynchronous unload of
// the provider document immediately — the heavy browsing context releases
// its media decoders and network connections while the router resolves
// the next page — so by the time Svelte detaches the element, the frame
// only hosts an empty about:blank document and its destruction is
// trivial. The frame is also hidden instantly, so the user sees immediate
// navigation feedback (the viewport's dark backdrop + the global nav
// progress bar) instead of a frozen provider page.
//
// We deliberately do NOT remove() the element inside beforeNavigate:
// detaching a LIVE cross-origin frame right there would run the exact
// synchronous destruction we are trying to move off the critical path —
// same jank, just earlier. Neutralize-first (about:blank), let the router
// proceed, then the keyed removal destroys an empty frame.
//
// ARCHITECTURE: a module-scoped registry of the CURRENTLY mounted embed
// iframe. PlayerViewport registers on mount and unregisters on destroy /
// source switch; the watch route calls neutralizeActiveEmbedIframe() from
// beforeNavigate. The registry decouples the deep player component tree
// (PlayerShell → PlayerViewport) from route-level navigation hooks — no
// prop drilling, and it works regardless of how the player is composed.

let activeEmbedIframe: HTMLIFrameElement | null = null;

/**
 * Register the currently-mounted embed iframe (called by PlayerViewport
 * whenever an embed iframe element binds). Registers at most ONE frame —
 * the player viewport renders a single embed at a time; a re-register
 * replaces the previous element (episode/source switches).
 */
export function registerEmbedIframe(iframe: HTMLIFrameElement): void {
  activeEmbedIframe = iframe;
}

/**
 * Unregister an embed iframe (destroy / source switch). Only clears the
 * registration when it still points at THIS element, so a stale
 * unregister can never erase a newer frame's registration.
 */
export function unregisterEmbedIframe(iframe: HTMLIFrameElement): void {
  if (activeEmbedIframe === iframe) activeEmbedIframe = null;
}

/**
 * True while the registered embed iframe is still mounted and has NOT yet
 * been neutralized. The watch route uses this to show instant teardown
 * feedback only when there is actually a heavy embed to tear down.
 */
export function hasActiveEmbedIframe(): boolean {
  return activeEmbedIframe !== null;
}

/**
 * Neutralize the active embed iframe ahead of a navigation:
 *   1. hide it immediately (instant visual feedback — the dark viewport
 *      backdrop + nav progress bar replace the frozen provider page);
 *   2. swap its document for about:blank, which starts the heavy
 *      cross-origin document's unload ASYNCHRONOUSLY and detaches every
 *      decoder/worker/connection it owns from the main thread's critical
 *      path.
 * Returns true when a live embed was neutralized (so the caller can log/
 * surface it); false when no embed is mounted (direct-HLS playback or a
 * non-player route — nothing to do).
 */
export function neutralizeActiveEmbedIframe(): boolean {
  const iframe = activeEmbedIframe;
  if (!iframe) return false;
  activeEmbedIframe = null;
  try {
    iframe.style.visibility = 'hidden';
    // about:blank is same-origin, empty and instant to unload — the
    // provider document begins tearing down NOW, off the navigation's
    // critical path. Removing srcdoc (if any) avoids a race where the
    // srcdoc content re-fills the frame.
    iframe.removeAttribute('srcdoc');
    iframe.setAttribute('src', 'about:blank');
  } catch {
    // The frame may already be mid-teardown — the Svelte unmount will
    // remove it regardless.
  }
  return true;
}
