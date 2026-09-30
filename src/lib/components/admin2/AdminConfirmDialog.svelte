<script lang="ts">
  /**
   * Admin 2.0 — Phase E — AdminConfirmDialog
   *
   * Confirmation dialog for destructive operations (delete, detach).
   * Renders a modal overlay with a clear warning, the asset identity,
   * and Confirm/Cancel buttons.
   *
   * Accessibility:
   *   - role="dialog" aria-modal="true"
   *   - Focus trap (Tab cycles within dialog)
   *   - Escape to cancel
   *   - Focus restore to trigger on close
   *   - Body scroll lock when open
   */

  import { onMount, onDestroy, tick } from 'svelte';
  import { AlertTriangle, X } from 'lucide-svelte';

  let {
    open = $bindable(false),
    title = 'Confirm action',
    description = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'danger' as 'danger' | 'warning',
    onconfirm = (() => {}) as () => void,
    oncancel = (() => {}) as () => void,
    children,
  }: {
    open?: boolean;
    title?: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'danger' | 'warning';
    onconfirm?: () => void;
    oncancel?: () => void;
    children?: import('svelte').Snippet;
  } = $props();

  let dialogEl = $state<HTMLElement | undefined>(undefined);
  let lastFocused: HTMLElement | null = null;

  $effect(() => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null;
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-a2-dialog-open', '');
      }
      void tick().then(() => dialogEl?.querySelector<HTMLElement>('.a2-confirm-cancel')?.focus());
    } else {
      if (typeof document !== 'undefined') {
        document.documentElement.removeAttribute('data-a2-dialog-open');
      }
      lastFocused?.focus();
      lastFocused = null;
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.removeAttribute('data-a2-dialog-open');
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;
    const focusable = [...dialogEl.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleCancel() {
    open = false;
    oncancel();
  }

  function handleConfirm() {
    open = false;
    onconfirm();
  }
</script>

{#if open}
  <div class="a2-confirm-overlay" onclick={handleCancel} role="presentation">
    <div
      class="a2-confirm-dialog"
      class:a2-confirm-danger={tone === 'danger'}
      class:a2-confirm-warning={tone === 'warning'}
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="a2-confirm-title"
      tabindex="-1"
      onkeydown={handleKeydown}
      onclick={(e) => e.stopPropagation()}
    >
      <header class="a2-confirm-header">
        <span class="a2-confirm-icon" aria-hidden="true">
          {#if tone === 'danger'}<AlertTriangle size={18} />{:else}<AlertTriangle size={18} />{/if}
        </span>
        <h2 id="a2-confirm-title" class="a2-confirm-title">{title}</h2>
        <button type="button" class="a2-confirm-close" onclick={handleCancel} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      {#if description}
        <p class="a2-confirm-desc">{description}</p>
      {/if}
      {#if children}
        <div class="a2-confirm-body">
          {@render children()}
        </div>
      {/if}
      <footer class="a2-confirm-actions">
        <button type="button" class="a2-confirm-btn a2-confirm-cancel" onclick={handleCancel}>
          {cancelLabel}
        </button>
        <button type="button" class="a2-confirm-btn a2-confirm-confirm" onclick={handleConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .a2-confirm-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: var(--a2-space-4);
  }
  .a2-confirm-dialog {
    width: 100%; max-width: 480px;
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-lg);
    box-shadow: var(--a2-shadow-lg);
    display: flex; flex-direction: column;
    gap: var(--a2-space-4);
    padding: var(--a2-space-5);
    animation: a2-confirm-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-confirm-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .a2-confirm-danger { border-color: var(--a2-red-border); }
  .a2-confirm-warning { border-color: var(--a2-amber-border); }

  .a2-confirm-header {
    display: flex; align-items: center; gap: var(--a2-space-3);
  }
  .a2-confirm-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; border-radius: var(--a2-radius-sm);
    flex-shrink: 0;
  }
  .a2-confirm-danger .a2-confirm-icon { background: var(--a2-red-soft); color: var(--a2-red); }
  .a2-confirm-warning .a2-confirm-icon { background: var(--a2-amber-soft); color: var(--a2-amber); }
  .a2-confirm-title {
    margin: 0; flex: 1;
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-lg);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.01em;
  }
  .a2-confirm-close {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .a2-confirm-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-confirm-desc {
    margin: 0;
    font-size: var(--a2-text-sm);
    color: var(--a2-text-muted);
    line-height: 1.55;
  }
  .a2-confirm-body {
    font-size: var(--a2-text-sm);
    color: var(--a2-text);
  }

  .a2-confirm-actions {
    display: flex; gap: var(--a2-space-2); justify-content: flex-end;
    padding-top: var(--a2-space-3);
    border-top: 1px solid var(--a2-border);
  }
  .a2-confirm-btn {
    padding: var(--a2-space-2) var(--a2-space-4);
    border: 1px solid transparent;
    border-radius: var(--a2-radius-sm);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-confirm-cancel {
    background: var(--a2-surface-3);
    border-color: var(--a2-border-strong);
    color: var(--a2-text);
  }
  .a2-confirm-cancel:hover { background: var(--a2-surface-4); }
  .a2-confirm-confirm {
    color: var(--a2-surface-1);
  }
  .a2-confirm-danger .a2-confirm-confirm {
    background: var(--a2-red); border-color: var(--a2-red);
  }
  .a2-confirm-danger .a2-confirm-confirm:hover { filter: brightness(1.1); }
  .a2-confirm-warning .a2-confirm-confirm {
    background: var(--a2-amber); border-color: var(--a2-amber);
  }
  .a2-confirm-warning .a2-confirm-confirm:hover { filter: brightness(1.1); }

  @media (max-width: 640px) {
    .a2-confirm-dialog { padding: var(--a2-space-4); }
    .a2-confirm-actions { flex-direction: column-reverse; }
    .a2-confirm-btn { width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-confirm-dialog { animation: none; }
    .a2-confirm-btn, .a2-confirm-close { transition: none; }
  }
</style>
