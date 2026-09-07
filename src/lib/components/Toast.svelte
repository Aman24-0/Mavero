<script lang="ts">
  // Reusable app-wide toast host. Mounted ONCE in the root +layout.svelte
  // so any caller (DetailPage, My List, future surfaces) can `showToast(...)`
  // and have it appear above the floating bottom nav.
  //
  // Accessibility:
  //   - success/info toasts live inside an aria-live="polite" region.
  //   - error toasts live inside a separate role="alert" region so screen
  //     readers announce them immediately.
  //   - Each toast is a button-like article so it can be focused and
  //     dismissed with the keyboard (Enter/Space/Escape).
  //
  // Positioning:
  //   - Sits above the floating bottom nav (mobile) and the bottom-right
  //     of the viewport on desktop.
  //   - Does NOT block normal interaction — pointer-events: none on the
  //     host layer, pointer-events: auto on each toast.
  //
  // Motion:
  //   - prefers-reduced-motion disables the slide-in animation.
  //   - Auto-dismiss timing is unchanged (content accessibility, not motion).

  import { CheckCircle2, AlertCircle, Info, X } from 'lucide-svelte';
  import { subscribe, dismissToast, pauseToast, resumeToast, type ToastItem } from '$lib/client/toast.svelte';

  // Mirror the toast queue into a local `$state` array so Svelte 5
  // re-renders the component whenever the queue changes. The toast module
  // is a plain TS module (no `$state` at module scope) so it can be
  // imported from tests / non-Svelte contexts; we bridge to reactivity
  // here via `subscribe`.
  let queue = $state<ToastItem[]>([]);
  subscribe((next) => { queue = next; });

  // Track hover/focus start times so resume can restore the remaining TTL.
  const hoveredAt = new Map<number, number>();
  const DEFAULT_TTL = 3200;
  const ERROR_TTL = 5200;

  function ttlFor(variant: string): number {
    return variant === 'error' ? ERROR_TTL : DEFAULT_TTL;
  }

  function onEnter(id: number) {
    pauseToast(id);
    hoveredAt.set(id, Date.now());
  }
  function onLeave(id: number, variant: string) {
    const startedAt = hoveredAt.get(id);
    hoveredAt.delete(id);
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const remaining = Math.max(400, ttlFor(variant) - elapsed);
    resumeToast(id, remaining);
  }

  function onKeydown(event: KeyboardEvent, id: number) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dismissToast(id);
    }
  }

  let successToasts = $derived(queue.filter((t) => t.variant !== 'error'));
  let errorToasts = $derived(queue.filter((t) => t.variant === 'error'));
</script>

<div class="toast-host" aria-hidden={queue.length === 0}>
  <!-- Error toasts: separate role="alert" region so screen readers announce them. -->
  {#if errorToasts.length}
    <div class="toast-region toast-region-error" role="alert">
      {#each errorToasts as toast (toast.id)}
        <article
          class="toast toast-error"
          tabindex="0"
          aria-label={toast.message}
          onpointerenter={() => onEnter(toast.id)}
          onpointerleave={() => onLeave(toast.id, toast.variant)}
          onfocus={() => onEnter(toast.id)}
          onblur={() => onLeave(toast.id, toast.variant)}
          onkeydown={(e) => onKeydown(e, toast.id)}
        >
          <span class="toast-icon" aria-hidden="true"><AlertCircle size={16} /></span>
          <span class="toast-message">{toast.message}</span>
          <button class="toast-close" type="button" aria-label="Dismiss notification" onclick={() => dismissToast(toast.id)}>
            <X size={14} />
          </button>
        </article>
      {/each}
    </div>
  {/if}

  <!-- Success/info toasts: aria-live="polite" so screen readers don't interrupt. -->
  {#if successToasts.length}
    <div class="toast-region toast-region-polite" aria-live="polite" aria-atomic="false">
      {#each successToasts as toast (toast.id)}
        <article
          class="toast toast-{toast.variant}"
          tabindex="0"
          aria-label={toast.message}
          onpointerenter={() => onEnter(toast.id)}
          onpointerleave={() => onLeave(toast.id, toast.variant)}
          onfocus={() => onEnter(toast.id)}
          onblur={() => onLeave(toast.id, toast.variant)}
          onkeydown={(e) => onKeydown(e, toast.id)}
        >
          <span class="toast-icon" aria-hidden="true">
            {#if toast.variant === 'success'}<CheckCircle2 size={16} />{:else}<Info size={16} />{/if}
          </span>
          <span class="toast-message">{toast.message}</span>
          <button class="toast-close" type="button" aria-label="Dismiss notification" onclick={() => dismissToast(toast.id)}>
            <X size={14} />
          </button>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .toast-host {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    /* Above the floating bottom nav (z-index 50) and below dialogs (z-index 100). */
    z-index: 70;
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    width: min(calc(100% - 24px), 480px);
    display: grid;
    gap: 8px;
    /* Host layer does not block interaction; each toast re-enables pointer events. */
    pointer-events: none;
  }
  .toast-region { display: grid; gap: 8px; }
  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 11px 12px 11px 13px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 12px;
    background: rgba(20, 20, 24, .94);
    backdrop-filter: blur(14px);
    box-shadow: 0 12px 36px rgba(0, 0, 0, .55);
    color: #f5f5f5;
    font-size: .76rem;
    line-height: 1.4;
    font-weight: 600;
    animation: toast-in 200ms cubic-bezier(.22, 1, .36, 1);
    /* focus ring for keyboard dismiss */
  }
  .toast:focus-visible {
    outline: 2px solid #f5f5f5;
    outline-offset: 2px;
  }
  .toast-icon {
    display: grid;
    place-items: center;
    color: #35d68f;
    flex: 0 0 auto;
  }
  .toast-error {
    border-color: rgba(255, 176, 32, .42);
    background: rgba(34, 26, 16, .96);
  }
  .toast-error .toast-icon { color: #ffb020; }
  .toast-info .toast-icon { color: #c7c7cc; }
  .toast-message {
    flex: 1 1 auto;
    min-width: 0;
    word-break: break-word;
  }
  .toast-close {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255, 255, 255, .06);
    cursor: pointer;
    flex: 0 0 auto;
    transition: background 160ms ease, color 160ms ease;
  }
  .toast-close:hover { background: rgba(255, 255, 255, .12); color: #f5f5f5; }
  .toast-close:active { transform: scale(.94); }

  /* Desktop: anchor bottom-right (no floating bottom nav there). */
  @media (min-width: 641px) {
    .toast-host {
      left: auto;
      right: clamp(14px, 4vw, 28px);
      transform: none;
      bottom: calc(28px + env(safe-area-inset-bottom, 0px));
      width: min(calc(100% - 56px), 420px);
    }
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px) scale(.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
