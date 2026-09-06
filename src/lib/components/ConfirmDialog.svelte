<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { haptic } from '$lib/client/haptics';

  type DialogTone = 'default' | 'danger';

  let {
    open = false,
    eyebrow = 'MAVERO / Confirm',
    title,
    description,
    primaryLabel,
    primaryDisabled = false,
    cancelDisabled = false,
    tone = 'default',
    children,
    onCancel = () => {},
    onPrimary = () => {}
  }: {
    open?: boolean;
    eyebrow?: string;
    title: string;
    description: string;
    primaryLabel: string;
    primaryDisabled?: boolean;
    cancelDisabled?: boolean;
    tone?: DialogTone;
    children?: Snippet;
    onCancel?: () => void;
    onPrimary?: () => void;
  } = $props();

  let dialog = $state<HTMLDivElement>();
  let lastOpen = false;
  let previouslyFocused: HTMLElement | null = null;

  $effect(() => {
    if (open && !lastOpen) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void tick().then(() => dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    } else if (!open && lastOpen) {
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
    lastOpen = open;
  });

  function handlePrimary() {
    haptic(tone === 'danger' ? 'destructive' : 'light');
    onPrimary();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
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
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="dialog-layer" role="presentation">
    <div class="dialog-backdrop" aria-hidden="true"></div>
    <div class:danger={tone === 'danger'} class="confirm-dialog" bind:this={dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" tabindex="-1">
      <div class="dialog-eyebrow">{eyebrow}</div>
      <h2 id="confirm-dialog-title">{title}</h2>
      <p id="confirm-dialog-description">{description}</p>
      {#if children}<div class="dialog-content">{@render children()}</div>{/if}
      <div class="dialog-actions">
        <button class="dialog-button dialog-cancel" type="button" data-autofocus disabled={cancelDisabled} onclick={onCancel}>Cancel</button>
        <button class:dialog-danger={tone === 'danger'} class="dialog-button dialog-primary" type="button" disabled={primaryDisabled} onclick={handlePrimary}>{primaryLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-layer { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: max(18px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); }
  .dialog-backdrop { position: absolute; inset: 0; background: rgba(3, 5, 9, .78); backdrop-filter: blur(12px); }
  .confirm-dialog { position: relative; width: min(100%, 460px); max-height: min(88dvh, 680px); overflow: auto; padding: 24px; border: 1px solid var(--line-strong); border-radius: var(--radius-lg); background: var(--surface-2); box-shadow: 0 24px 100px rgba(0,0,0,.55); outline: none; animation: dialog-in 180ms var(--ease-out); }
  .confirm-dialog.danger { border-color: rgba(255, 176, 32, .38); }
  .dialog-eyebrow { color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
  .confirm-dialog h2 { margin: 9px 0 8px; color: var(--ink); font-size: 1.42rem; font-weight: 850; letter-spacing: -.02em; line-height: 1.15; }
  .confirm-dialog p { margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.6; }
  .dialog-content { margin-top: 18px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
  .dialog-button { min-height: 42px; padding: 0 15px; border: 1px solid var(--line-strong); border-radius: 9px; color: var(--ink-soft); background: rgba(245,246,250,.04); font-size: .75rem; font-weight: 750; cursor: pointer; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .dialog-button:hover { color: var(--ink); background: rgba(245,246,250,.08); }
  .dialog-button:active { transform: scale(.98); }
  .dialog-button:focus-visible { outline: 0; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(255, 255, 255, .12); }
  .dialog-primary { color: #000; border-color: var(--ink); background: var(--ink); }
  .dialog-primary:hover { color: #000; background: #ffffff; }
  .dialog-button:disabled { opacity: .42; cursor: not-allowed; transform: none; }
  .dialog-primary.dialog-danger { border-color: #ffb020; background: #ffb020; color: #000; }
  .dialog-primary.dialog-danger:hover { background: #ffc34d; }
  @keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @media (max-width: 520px) { .confirm-dialog { padding: 20px; } .dialog-actions { justify-content: stretch; } .dialog-button { flex: 1; } }
  @media (prefers-reduced-motion: reduce) { .confirm-dialog, .dialog-button { animation: none; transition: none; } }
</style>
