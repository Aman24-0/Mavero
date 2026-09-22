<script lang="ts">
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  // ============================================================
  // AdminSheet — reusable modal/bottom-sheet primitive for admin forms.
  //
  // Used for BOTH create and edit flows on every admin registry page
  // (Providers, Sources, Downloaders, Categories, Stremio Addons).
  //
  // Behavior:
  //   - Mobile (<640px): full-width bottom sheet anchored to the bottom
  //     of the viewport, max-height: 90dvh, internal scroll.
  //   - Tablet/Desktop (≥640px): centered dialog, bounded max-width 720px.
  //   - Escape closes (after confirming dirty state is OK; the close action
  //     is owned by the caller — AdminSheet just calls onClose).
  //   - Backdrop click closes (only when `closeOnBackdrop` is true — caller
  //     can disable it for create/edit forms with unsaved changes).
  //   - Focus moves into the sheet on open, restored to the trigger on close.
  //   - Tab trap keeps focus inside while open.
  //   - Body scroll lock via the `data-admin-sheet-open` <html> attribute
  //     (handled by app.css global rule).
  //
  // The sheet is purely a presentation primitive. The caller owns:
  //   - title + optional description
  //   - the form/body snippet (real <form method="POST" action="?/...">
  //     so existing server actions stay intact)
  //   - the footer/actions snippet (Cancel + Save buttons)
  //   - the close decision (onClose callback)
  // ============================================================
  let {
    open = false,
    title,
    description = '',
    onClose,
    closeOnBackdrop = true,
    size = 'default',
    children,
    footer = undefined
  }: {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    closeOnBackdrop?: boolean;
    size?: 'default' | 'wide';
    children: Snippet;
    footer?: Snippet;
  } = $props();

  let sheetEl = $state<HTMLElement | undefined>(undefined);
  let lastFocused: HTMLElement | null = null;

  // Lock body scroll + trap focus when the sheet opens; restore on close.
  $effect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;

    // Remember the trigger so we can restore focus on close.
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Lock body scroll.
    document.documentElement.setAttribute('data-admin-sheet-open', '');

    // Move focus into the sheet.
    void tick().then(() => {
      sheetEl?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    });

    // Cleanup when the sheet closes or the component unmounts.
    return () => {
      document.documentElement.removeAttribute('data-admin-sheet-open');
      lastFocused?.focus?.();
      lastFocused = null;
    };
  });

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    // Tab trap — focus stays inside the sheet while it's open.
    if (event.key !== 'Tab' || !sheetEl) return;
    const focusable = [...sheetEl.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdropClick() {
    if (closeOnBackdrop) onClose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="admin-sheet-overlay"
    onclick={handleBackdropClick}
    aria-hidden="true"
  ></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="admin-sheet size-{size}"
    bind:this={sheetEl}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <header class="admin-sheet-head">
      <div class="admin-sheet-titles">
        <h2 class="admin-sheet-title">{title}</h2>
        {#if description}<p class="admin-sheet-desc">{description}</p>{/if}
      </div>
      <button
        class="admin-sheet-close"
        type="button"
        onclick={onClose}
        aria-label={`Close ${title}`}
      >
        <X size={16} />
      </button>
    </header>
    <div class="admin-sheet-body">
      {@render children()}
    </div>
    {#if footer}
      <footer class="admin-sheet-foot">
        {@render footer()}
      </footer>
    {/if}
  </div>
{/if}

<style>
  .admin-sheet-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(5, 7, 8, .75);
    backdrop-filter: blur(4px);
    animation: sheet-fade-in var(--motion-fast) var(--ease-out);
  }

  .admin-sheet {
    position: fixed;
    z-index: 81;
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: sheet-slide-up var(--motion-normal) var(--ease-out);
  }

  /* Mobile default — full-width bottom sheet anchored to the bottom of
     the viewport. Max-height keeps the form scrollable inside the sheet
     rather than letting the underlying page scroll. */
  .admin-sheet {
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 90dvh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .admin-sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--color-border);
    flex: 0 0 auto;
  }
  .admin-sheet-titles { min-width: 0; flex: 1; }
  .admin-sheet-title {
    margin: 0;
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -.01em;
    line-height: 1.2;
  }
  .admin-sheet-desc {
    margin: 4px 0 0;
    color: var(--color-text-muted);
    font-size: .7rem;
    line-height: 1.5;
  }
  .admin-sheet-close {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    color: var(--color-text-muted);
    background: transparent;
    cursor: pointer;
    flex: 0 0 auto;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .admin-sheet-close:hover { color: var(--color-text); border-color: var(--color-primary-border); }
  .admin-sheet-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* Body — the only vertical-scroll region inside the sheet. */
  .admin-sheet-body {
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 16px;
    flex: 1 1 auto;
    min-height: 0;
  }

  /* Footer — fixed at the bottom of the sheet so Save/Cancel are always
     reachable without scrolling the body to find them. */
  .admin-sheet-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-elevated);
    flex: 0 0 auto;
  }

  /* Tablet / Desktop — centered dialog with bounded width. */
  @media (min-width: 640px) {
    .admin-sheet {
      top: 50%;
      bottom: auto;
      left: 50%;
      right: auto;
      transform: translate(-50%, -50%);
      width: min(560px, calc(100% - 32px));
      max-height: 88dvh;
      border-radius: var(--radius-lg);
      border-bottom: 1px solid var(--color-border-strong);
    }
    .admin-sheet.size-wide {
      width: min(820px, calc(100% - 48px));
    }
    /* Override the slide-up animation with a scale-in for desktop. */
    .admin-sheet { animation: sheet-pop-in var(--motion-normal) var(--ease-out); }
  }

  @media (prefers-reduced-motion: reduce) {
    .admin-sheet, .admin-sheet-overlay { animation: none; }
  }

  @keyframes sheet-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes sheet-slide-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @keyframes sheet-pop-in {
    from { transform: translate(-50%, -50%) scale(.96); opacity: 0; }
    to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
</style>
