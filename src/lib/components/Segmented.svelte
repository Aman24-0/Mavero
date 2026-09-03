<script lang="ts">
  // Reusable Mavero segmented control — used by My List status filter and
  // Search type filter. Each option is a navigable anchor (`href`) when
  // provided; otherwise it acts as a button that fires `onSelect`.
  type Option = {
    value: string;
    label: string;
    badge?: string | number;
    href?: string;
  };

  export let id = '';
  export let label = '';
  export let options: Option[] = [];
  export let value = '';
  export let onSelect: (value: string) => void = () => undefined;
  // When true, all options occupy equal flexible width (good for the
  // full-width mobile filter row). When false, options size to content.
  export let fill = false;
</script>

{#if label}
  <span class="seg-label" id={`${id}-label`}>{label}</span>
{/if}
<div class="segmented" class:fill role="tablist" aria-label={label || undefined}>
  {#each options as option (option.value)}
    {#if option.href !== undefined}
      <a
        class="seg"
        class:active={value === option.value}
        role="tab"
        aria-selected={value === option.value}
        href={option.href}
        aria-current={value === option.value ? 'page' : undefined}
      >
        <span class="seg-label-text">{option.label}</span>
        {#if option.badge !== undefined && option.badge !== ''}
          <b class="seg-badge">{option.badge}</b>
        {/if}
      </a>
    {:else}
      <button
        type="button"
        class="seg"
        class:active={value === option.value}
        role="tab"
        aria-selected={value === option.value}
        onclick={() => onSelect(option.value)}
      >
        <span class="seg-label-text">{option.label}</span>
        {#if option.badge !== undefined && option.badge !== ''}
          <b class="seg-badge">{option.badge}</b>
        {/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px;
    background: rgba(255,255,255,.025);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
  }
  .segmented::-webkit-scrollbar { display: none; }
  .segmented.fill { display: flex; width: 100%; }
  .segmented.fill .seg { flex: 1 1 0; min-width: 0; justify-content: center; }

  .seg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 38px;
    padding: 0 14px;
    border: 0;
    border-radius: 8px;
    color: #b7b7bd;
    background: transparent;
    font: inherit;
    font-size: .74rem;
    font-weight: 700;
    letter-spacing: -.005em;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: color 180ms cubic-bezier(.22,1,.36,1),
                background 180ms cubic-bezier(.22,1,.36,1);
  }
  .seg:hover { color: #f5f5f5; }
  .seg:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .seg.active {
    color: #000;
    background: #f5f5f5;
  }
  .seg-label-text { overflow: hidden; text-overflow: ellipsis; }
  .seg-badge {
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: .58rem;
    font-weight: 800;
    text-align: center;
    background: rgba(255,255,255,.08);
    color: inherit;
    opacity: .85;
  }
  .seg.active .seg-badge {
    background: rgba(0,0,0,.18);
    color: #000;
    opacity: 1;
  }

  .seg-label {
    display: block;
    margin-bottom: 6px;
    color: #77777f;
    font-size: .58rem;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  @media (max-width: 640px) {
    .seg { min-height: 36px; padding: 0 10px; font-size: .7rem; gap: 5px; }
    .seg-badge { min-width: 16px; padding: 1px 5px; font-size: .55rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .seg { transition: none; }
  }
</style>
