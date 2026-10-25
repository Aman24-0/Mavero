/**
 * PiP capability detection — MAVERO player redesign (Phase 4).
 *
 * Capability-driven, honest PiP support. Three DISTINCT mechanisms are
 * deliberately not conflated (task spec §2):
 *
 * 1. Native video PiP (`video.requestPictureInPicture()`)
 *    SUPPORTED and PRESERVED for DIRECT sources. The playback surface is
 *    Mavero's own <video> element; PiP continues the exact same element, so
 *    playback, progress and cleanup behave. Entry points: the PlayerControls
 *    PiP button (direct sources only) → PlayerViewport.requestPictureInPicture().
 *
 * 2. Complete-player Document Picture-in-Picture
 *    (`window.documentPictureInPicture.requestWindow(...)`)
 *    DETECTED but NOT OFFERED. Honest architectural limitation: the player
 *    lifecycle is a route component — navigating within the SPA unmounts
 *    PlayerShell and stops playback — and embed playback lives in a
 *    cross-origin iframe that cannot be reparented into a PiP window without
 *    a full reload (session/position lost; MAVERO policy also forbids
 *    cross-origin DOM manipulation). Moving direct video into a second
 *    window would duplicate or restart the session. None of these paths can
 *    deliver continuous playback, so no Document PiP control is rendered.
 *    The detector exists so tests and future capability gating can probe the
 *    API without re-deriving its shape.
 *
 * 3. Embedded-provider PiP
 *    PROVIDER-OWNED. The iframe `allow` list already includes
 *    `picture-in-picture`, so providers that implement their own PiP can
 *    offer it inside their frame. Mavero cannot detect, trigger or observe
    * it cross-origin — and never manipulates provider DOM. No Mavero PiP
 *    button is shown for embed sources (honest fallback: ordinary playback).
 *
 * All probes are pure and browser-safe (no-op outside `window`).
 */

export type PipCapability = {
  /** Native HTMLVideoElement PiP (direct sources) — offered where true. */
  nativeVideoPip: boolean;
  /** Document PiP API present — detected only; NOT offered for playback. */
  documentPipApiPresent: boolean;
};

/** Detect Document PiP API presence (Chrome/Edge desktop). */
export function detectDocumentPipApi(target: unknown = globalThis.window): boolean {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as { documentPictureInPicture?: { requestWindow?: unknown } };
  return typeof candidate.documentPictureInPicture?.requestWindow === 'function';
}

/** Detect native video-element PiP for a concrete element. */
export function detectNativeVideoPip(video: HTMLVideoElement | undefined, doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  if (!doc || !video) return false;
  return Boolean(doc.pictureInPictureEnabled && 'requestPictureInPicture' in video);
}

/** Full capability snapshot for the current browser context. */
export function pipCapabilities(video: HTMLVideoElement | undefined): PipCapability {
  return {
    nativeVideoPip: detectNativeVideoPip(video),
    documentPipApiPresent: detectDocumentPipApi(),
  };
}
