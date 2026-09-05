import type { PlayerEvent, PlayerEventHandler } from '../events';

/**
 * Phase 3: shared utilities for postMessage-based provider adapters.
 *
 * These helpers enforce the browser-safety rules:
 *   - Only listen while the adapter is active (destroyed flag).
 *   - Validate `event.origin` against the provider's documented origin.
 *   - Validate message shape before parsing.
 *   - Never execute arbitrary data as code.
 *   - Never trust arbitrary message fields blindly.
 *   - Silently drop messages from unrelated origins/unknown shapes.
 *
 * IMPORTANT: Mavero NEVER inspects cross-origin iframe DOM. These utilities
 * work entirely through the standard `window.addEventListener('message')`
 * API — the iframe posts messages TO the parent window, and the parent
 * validates origin + shape before processing.
 */

/**
 * Safely parse a message event's data. Handles:
 *   - Plain objects (returned as-is if they pass the type guard).
 *   - JSON strings (parsed via JSON.parse, validated).
 *   - null/undefined/numbers/booleans (rejected — return null).
 *
 * Returns the parsed object or null if the data is not a valid object.
 * NEVER throws — malformed JSON or wrong types return null.
 */
export function safeParseMessage<T>(data: unknown, isShape: (value: unknown) => value is T): T | null {
  if (data === null || data === undefined) return null;
  // If the data is already an object (modern postMessage), validate directly.
  if (typeof data === 'object' && !Array.isArray(data)) {
    return isShape(data) ? data : null;
  }
  // If the data is a string, try parsing as JSON (VidY posts JSON strings).
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return isShape(parsed) ? parsed : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Create a type guard for a record with a specific `type` string field.
 * Used to validate that a postMessage payload matches a provider's expected
 * message type (e.g. `{ type: 'PLAYER_EVENT' }` for VidLink).
 */
export function isMessageOfType<T extends string>(
  value: unknown,
  typeField: keyof Record<string, unknown>,
  expectedType: T,
): value is Record<string, unknown> & { [K in typeof typeField]: T } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record[typeField] === expectedType;
}

/**
 * Extract a numeric field from a record. Returns null if the field is
 * missing, not a finite number, or negative (for time values).
 */
export function extractNumber(record: Record<string, unknown>, field: string, allowNegative = false): number | null {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!allowNegative && value < 0) return null;
  return value;
}

/**
 * Extract a string field from a record. Returns null if the field is
 * missing or not a string.
 */
export function extractString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Base class for postMessage-based provider adapters.
 *
 * Provides:
 *   - Origin-validated `window.message` listener registration/teardown.
 *   - A `destroyed` flag that prevents late events from reaching the handler.
 *   - An `emit(event)` method that forwards normalized PlayerEvents to the
 *     registered handler (dropped if destroyed).
 *   - A `canHandleByOrigin(source, origin)` helper for URL-origin matching.
 *
 * Subclasses MUST implement:
 *   - `handleMessage(event: MessageEvent)` — parse the provider-specific
 *     payload and call `this.emit(normalizedEvent)` for each recognized
 *     message. Unknown shapes are silently dropped.
 *
 * Subclasses MUST set:
 *   - `readonly origin` — the provider's documented HTTPS origin (e.g.
 *     `'https://vidlink.pro'`). Messages from any other origin are dropped.
 */
export abstract class PostMessageAdapterBase {
  /** The provider's documented HTTPS origin. Messages from other origins are dropped. */
  protected abstract readonly origin: string;

  protected handler: PlayerEventHandler | undefined;
  protected destroyed = true;
  private messageListener: ((event: MessageEvent) => void) | undefined;

  /**
   * Check if a source URL belongs to this provider by comparing the origin.
   * Pure predicate — does not mutate state.
   */
  protected canHandleByOrigin(source: { url: string | null; type: string }, origin: string): boolean {
    if (source.type !== 'embed') return false;
    if (typeof source.url !== 'string' || !source.url) return false;
    try {
      const url = new URL(source.url);
      return url.origin.toLowerCase() === origin.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Register the `window.message` listener. Called by the subclass's
   * `load()` implementation. The listener validates `event.origin` against
   * `this.origin` and calls `handleMessage()` only for matching origins.
   */
  protected startListening(): void {
    this.destroyed = false;
    this.messageListener = (event: MessageEvent) => {
      if (this.destroyed) return;
      // Origin validation — the primary security boundary.
      if (event.origin !== this.origin) return;
      this.handleMessage(event);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.messageListener);
    }
  }

  /**
   * Remove the `window.message` listener and clear the handler.
   * Called by the subclass's `destroy()` implementation. After this returns,
   * no further message events can reach the handler.
   */
  protected stopListening(): void {
    this.destroyed = true;
    if (this.messageListener && typeof window !== 'undefined') {
      window.removeEventListener('message', this.messageListener);
    }
    this.messageListener = undefined;
    this.handler = undefined;
  }

  /**
   * Set the event handler. Returns an unsubscribe function.
   */
  onEvent(handler: PlayerEventHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  /**
   * Emit a normalized PlayerEvent to the registered handler.
   * Late events after `destroy()` are dropped.
   */
  protected emit(event: PlayerEvent): void {
    if (this.destroyed) return;
    this.handler?.(event);
  }

  /**
   * Subclass hook: parse a provider-specific message and emit normalized
   * events. Called ONLY for messages whose `event.origin` matches
   * `this.origin`. Unknown message shapes MUST be silently dropped (do NOT
   * throw — that would crash the message listener).
   */
  protected abstract handleMessage(event: MessageEvent): void;
}

/**
 * Get the origin from a URL string, or null if the URL is invalid.
 * Used by `canHandle()` implementations.
 */
export function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
