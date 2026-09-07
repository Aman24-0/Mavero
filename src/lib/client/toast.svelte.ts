// Tiny app-wide toast store.
//
// Design:
//   - One module-level `toasts` array (plain JS, NOT Svelte `$state`) so
//     the module can be imported from non-Svelte contexts (tests, server
//     modules) without requiring the Svelte compiler.
//   - A tiny pub/sub (`subscribe`) lets the Toast.svelte component re-
//     render whenever the queue changes, by mirroring the queue into a
//     local `$state` array inside the component.
//   - Auto-dismiss after a default 3200ms. Callers can override.
//   - Two variants: 'success' (default) and 'error'. Success uses
//     aria-live="polite"; error uses role="alert" so screen readers
//     announce it immediately.
//   - Auto-dismiss is cancelled while the toast is hovered/focused so
//     users can read long messages.
//   - Respects prefers-reduced-motion via the Toast component's CSS
//     (the auto-dismiss timing itself is unchanged — that's a content
//     accessibility concern, not a motion concern).
//
// Intentionally no third-party toast library — this is ~80 lines of
// plain TypeScript + a small bit of DOM in Toast.svelte.

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastItem = {
  id: number;
  variant: ToastVariant;
  message: string;
  // Capture the timer so hover/focus can cancel auto-dismiss.
  timer: ReturnType<typeof setTimeout> | undefined;
};

let nextId = 1;
const _toasts: ToastItem[] = [];

// Pub/sub. Toast.svelte subscribes so it can mirror the queue into a
// reactive `$state` array. Plain listeners (tests) can also subscribe.
type Listener = (queue: ToastItem[]) => void;
const listeners = new Set<Listener>();

function emit() {
  // Snapshot the queue so listeners see a stable reference.
  const snapshot = [..._toasts];
  for (const listener of listeners) listener(snapshot);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  // Emit the current state immediately so the subscriber initializes.
  listener([..._toasts]);
  return () => { listeners.delete(listener); };
}

// Read-only accessor for tests / non-reactive callers.
export function getToasts(): ToastItem[] {
  return [..._toasts];
}

const DEFAULT_DURATION = 3200;
const ERROR_DURATION = 5200;

export function showToast(message: string, variant: ToastVariant = 'success', duration?: number): void {
  if (typeof message !== 'string' || !message.trim()) return;
  const id = nextId++;
  const ttl = duration ?? (variant === 'error' ? ERROR_DURATION : DEFAULT_DURATION);
  const item: ToastItem = { id, variant, message, timer: undefined };
  // Auto-dismiss timer. Stored on the item so hover/focus can cancel it.
  item.timer = setTimeout(() => dismissToast(id), ttl);
  _toasts.push(item);
  // Cap the queue so a runaway caller can't flood the screen.
  while (_toasts.length > 4) {
    const removed = _toasts.shift();
    if (removed?.timer) clearTimeout(removed.timer);
  }
  emit();
}

export function dismissToast(id: number): void {
  const idx = _toasts.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [removed] = _toasts.splice(idx, 1);
  if (removed?.timer) clearTimeout(removed.timer);
  emit();
}

// Internal hooks used by Toast.svelte to pause/resume auto-dismiss.
export function pauseToast(id: number): void {
  const item = _toasts.find((t) => t.id === id);
  if (item?.timer) {
    clearTimeout(item.timer);
    item.timer = undefined;
  }
}

export function resumeToast(id: number, remainingMs: number): void {
  const item = _toasts.find((t) => t.id === id);
  if (!item) return;
  if (item.timer) clearTimeout(item.timer);
  const ttl = Math.max(400, remainingMs);
  item.timer = setTimeout(() => dismissToast(id), ttl);
}

// Convenience wrappers for callers.
export function showSuccessToast(message: string, duration?: number): void {
  showToast(message, 'success', duration);
}

export function showErrorToast(message: string, duration?: number): void {
  showToast(message, 'error', duration);
}

// Exposed for tests.
export const __toastInternals = {
  get queue() { return _toasts; },
  nextId: () => nextId,
  reset() {
    for (const item of _toasts) if (item.timer) clearTimeout(item.timer);
    _toasts.length = 0;
    nextId = 1;
    emit();
  }
};
