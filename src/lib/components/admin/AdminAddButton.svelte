<script lang="ts">
  import { Plus } from 'lucide-svelte';
  // AdminAddButton — the prominent primary CTA at the top of every admin
  // registry page. Clicking it opens the create modal/sheet.
  //
  // Desktop/tablet: full-width button with icon + text label.
  // Mobile: icon-only square button — the text label is hidden via CSS
  // but preserved in the DOM for accessibility (aria-label uses the label).
  let {
    label = 'Add',
    onclick
  }: {
    label?: string;
    onclick: () => void;
  } = $props();
</script>

<button class="admin-add-btn" type="button" onclick={onclick} aria-label={label} title={label}>
  <Plus size={16} />
  <span class="admin-add-label">{label}</span>
</button>

<style>
  .admin-add-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: #050708;
    background: var(--color-primary);
    font: inherit;
    font-size: .76rem;
    font-weight: 800;
    letter-spacing: .01em;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary);
    transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
  }
  .admin-add-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .admin-add-btn:active { transform: scale(.98); }
  .admin-add-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* Mobile — icon-only square button. The label text is hidden but the
     aria-label + title attributes preserve accessibility. */
  @media (max-width: 640px) {
    .admin-add-btn {
      width: 40px;
      height: 40px;
      min-height: 40px;
      padding: 0;
      justify-content: center;
      border-radius: 10px;
      flex-shrink: 0;
    }
    .admin-add-label { display: none; }
  }
</style>
