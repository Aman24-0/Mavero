<script lang="ts">
  import { Plus } from 'lucide-svelte';
  // AdminAddButton — the prominent primary CTA at the top of every admin
  // registry page. Clicking it opens the create modal/sheet. The button is
  // intentionally simple (no props other than label + onclick) so it stays
  // visually consistent across all registry pages.
  let {
    label = 'Add',
    onclick
  }: {
    label?: string;
    onclick: () => void;
  } = $props();
</script>

<button class="admin-add-btn" type="button" onclick={onclick}>
  <Plus size={16} />
  <span>{label}</span>
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
</style>
