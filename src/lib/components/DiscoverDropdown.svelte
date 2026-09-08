<script lang="ts">
  // Compact accessible dropdown for Discover section filters.
  //
  // Renders as a small pill button (label + chevron). On tap/click it opens
  // a popover anchored to the button — both use the same keyboard
  // navigation (ArrowUp/Down/Home/End/Enter/Escape) and ARIA listbox
  // semantics. Closes after selection.
  //
  // Why not the existing Dropdown.svelte? That one has a top label and a
  // wide trigger; the Discover spec wants a compact pill that fits beside
  // a section heading without pushing it into overflow. This component is
  // also logo-aware (for the OTT provider dropdown).
  import { tick } from 'svelte';
  import { ChevronDown, Check, SlidersHorizontal } from 'lucide-svelte';

  type Option = {
    value: string;
    label: string;
    logoUrl?: string;
  };

  let {
    label,
    options,
    value,
    onChange,
    ariaLabel,
    compact = false,
  }: {
    label: string;
    options: Option[];
    value: string;
    onChange: (next: string) => void;
    ariaLabel: string;
    /** Icon-only trigger (post-release fix): the selected label is hidden
     *  and a sliders icon is shown instead — used on very narrow viewports
     *  so the filter can share the section heading row without pushing it
     *  into a broken second row. The dropdown panel is unchanged and the
     *  aria-label keeps the control accessible. */
    compact?: boolean;
  } = $props();

  let open = $state(false);
  let triggerEl: HTMLButtonElement | undefined;
  let listEl: HTMLUListElement | undefined;
  let activeIndex = $state(-1);
  let containerEl: HTMLDivElement | undefined;

  let selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? label);

  function toggle() {
    if (open) close();
    else openMenu();
  }

  function openMenu() {
    open = true;
    activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
    void tick().then(() => {
      listEl?.focus();
      scrollActiveIntoView();
    });
  }

  function close() {
    open = false;
    activeIndex = -1;
    triggerEl?.focus();
  }

  function scrollActiveIntoView() {
    if (!listEl || activeIndex < 0) return;
    const item = listEl.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    item?.scrollIntoView({ block: 'nearest' });
  }

  function choose(option: Option) {
    if (option.value !== value) onChange(option.value);
    close();
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  }

  function handleListKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      scrollActiveIntoView();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      scrollActiveIntoView();
    } else if (event.key === 'Home') {
      event.preventDefault();
      activeIndex = 0;
      scrollActiveIntoView();
    } else if (event.key === 'End') {
      event.preventDefault();
      activeIndex = options.length - 1;
      scrollActiveIntoView();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    } else if (event.key === 'Tab') {
      close();
    }
  }

  function handleDocumentClick(event: MouseEvent) {
    if (!open) return;
    const target = event.target as Node;
    if (containerEl && !containerEl.contains(target)) close();
  }
</script>

<svelte:window onclick={handleDocumentClick} />

<div class="discover-dropdown" bind:this={containerEl}>
  <button
    type="button"
    class="dd-trigger"
    class:compact
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    onclick={toggle}
    onkeydown={handleTriggerKeydown}
  >
    <span class="dd-label">{selectedLabel}</span>
    <span class="dd-icon" aria-hidden="true"><SlidersHorizontal size={13} /></span>
    <span class="dd-chevron" class:open><ChevronDown size={13} /></span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <ul
      class="dd-panel"
      bind:this={listEl}
      role="listbox"
      tabindex="0"
      aria-label={ariaLabel}
      onkeydown={handleListKeydown}
    >
      {#each options as option, index}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          class="dd-option"
          class:active={index === activeIndex}
          class:selected={option.value === value}
          role="option"
          aria-selected={option.value === value}
          onclick={() => choose(option)}
          onmouseenter={() => (activeIndex = index)}
        >
          {#if option.logoUrl}
            <span class="dd-option-logo"><img src={option.logoUrl} alt="" loading="lazy" onerror={(e) => { (e.currentTarget as HTMLImageElement).hidden = true; }} /></span>
          {/if}
          <span class="dd-option-label">{option.label}</span>
          {#if option.value === value}<Check size={12} class="dd-check" />{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .discover-dropdown { position: relative; display: inline-block; }

  .dd-trigger {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 30px;
    padding: 0 10px 0 12px;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 999px;
    color: #b7b7bd;
    background: rgba(255,255,255,.04);
    font: inherit;
    font-size: .68rem; font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    transition: color 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1), background 180ms cubic-bezier(.22,1,.36,1);
  }
  .dd-trigger:hover { color: #f5f5f5; border-color: rgba(255,255,255,.22); background: rgba(255,255,255,.07); }
  .dd-trigger:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 1px; }
  .dd-trigger[aria-expanded="true"] { color: #f5f5f5; border-color: rgba(255,255,255,.28); background: rgba(255,255,255,.08); }
  .dd-label { overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
  .dd-icon { display: none; color: #b7b7bd; }
  /* Compact (icon-only) trigger — opted in per instance via the `compact`
     prop; hides the label + chevron so the pill collapses to an icon. */
  .dd-trigger.compact { padding: 0 10px; }
  .dd-trigger.compact .dd-label,
  .dd-trigger.compact .dd-chevron { display: none; }
  .dd-trigger.compact .dd-icon { display: inline-flex; }
  .dd-chevron { display: inline-flex; transition: transform 180ms cubic-bezier(.22,1,.36,1); color: #77777f; }
  .dd-chevron.open { transform: rotate(180deg); }

  .dd-panel {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 60;
    min-width: 180px; max-width: min(80vw, 280px);
    max-height: min(60vh, 360px); overflow-y: auto; overflow-x: hidden;
    margin: 0; padding: 4px; list-style: none;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 12px;
    background: #131316;
    box-shadow: 0 18px 50px rgba(0,0,0,.6);
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.18) transparent;
  }
  .dd-panel::-webkit-scrollbar { width: 6px; }
  .dd-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 3px; }
  .dd-panel:focus { outline: none; }

  .dd-option {
    display: flex; align-items: center; gap: 10px;
    min-height: 38px;
    padding: 8px 10px;
    border-radius: 8px;
    color: #b7b7bd;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
  }
  .dd-option:hover, .dd-option.active { background: rgba(255,255,255,.06); color: #f5f5f5; }
  .dd-option.selected { color: #ffffff; }
  .dd-option-logo { display: grid; place-items: center; width: 22px; height: 22px; flex: 0 0 auto; }
  .dd-option-logo img { width: 22px; height: 22px; object-fit: contain; border-radius: 4px; background: rgba(255,255,255,.06); }
  .dd-option-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.dd-check) { flex: 0 0 auto; color: #ffffff; }

  @media (max-width: 640px) {
    .dd-panel { right: 0; min-width: 160px; max-width: 240px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dd-trigger, .dd-chevron, .dd-option { transition: none; }
  }
</style>
