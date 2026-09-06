<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronDown, Check } from 'lucide-svelte';

  type Option = { value: string; label: string };

  export let id = '';
  export let label = '';
  export let value = '';
  export let options: Option[] = [];
  export let onChange: (next: string) => void = () => undefined;

  let open = false;
  let triggerEl: HTMLButtonElement | undefined;
  let listEl: HTMLUListElement | undefined;
  let activeIndex = -1;
  let containerEl: HTMLDivElement | undefined;

  $: selectedLabel = options.find((opt) => opt.value === value)?.label ?? value ?? 'All';

  function toggle() {
    if (open) close();
    else openMenu();
  }

  function openMenu() {
    open = true;
    activeIndex = Math.max(0, options.findIndex((opt) => opt.value === value));
    // focus list after render
    queueMicrotask(() => {
      listEl?.focus();
      scrollActiveIntoView();
    });
  }

  function close() {
    open = false;
    activeIndex = -1;
    triggerEl?.focus();
  }

  function choose(option: Option) {
    if (option.value !== value) onChange(option.value);
    close();
  }

  function scrollActiveIntoView() {
    if (!listEl || activeIndex < 0) return;
    const item = listEl.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    item?.scrollIntoView({ block: 'nearest' });
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

  onMount(() => {
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  });
</script>

<div class="dropdown" bind:this={containerEl}>
  {#if label}
    <span class="dropdown-label" id={`${id}-label`}>{label}</span>
  {/if}
  <button
    type="button"
    class="dropdown-trigger"
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-labelledby={label ? `${id}-label` : undefined}
    onclick={toggle}
    onkeydown={handleTriggerKeydown}
  >
    <span class="dropdown-value">{selectedLabel}</span>
    <span class="dropdown-chevron-wrap" class:open>
      <ChevronDown size={13} />
    </span>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex -->
    <ul
      class="dropdown-panel"
      bind:this={listEl}
      role="listbox"
      tabindex="0"
      aria-labelledby={label ? `${id}-label` : undefined}
      onkeydown={handleListKeydown}
    >
      {#each options as option, index}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          class="dropdown-option"
          class:active={index === activeIndex}
          class:selected={option.value === value}
          role="option"
          aria-selected={option.value === value}
          onclick={() => choose(option)}
          onmouseenter={() => (activeIndex = index)}
        >
          <span class="dropdown-option-label">{option.label}</span>
          {#if option.value === value}
            <Check size={12} class="dropdown-check" />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .dropdown { position: relative; min-width: 0; display: grid; align-content: start; gap: 4px; }
  .dropdown-label {
    display: block; overflow: hidden;
    color: #77777f; font-size: .55rem; font-weight: 700;
    text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap;
    letter-spacing: .04em;
  }
  .dropdown-trigger {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; min-height: 40px; padding: 8px 10px;
    border: 1px solid rgba(255,255,255,.08); border-radius: 8px;
    background: rgba(255,255,255,.04); color: #f5f5f5;
    font-size: .72rem; font-weight: 700; cursor: pointer;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1);
  }
  .dropdown-trigger:hover, .dropdown-trigger:focus-visible {
    border-color: rgba(255,255,255,.18);
    background: rgba(255,255,255,.07);
    outline: none;
  }
  .dropdown-trigger[aria-expanded="true"] {
    border-color: rgba(255,255,255,.22);
    background: rgba(255,255,255,.08);
  }
  .dropdown-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; text-align: left; }
  .dropdown-chevron-wrap { flex: 0 0 auto; color: #77777f; transition: transform 200ms cubic-bezier(.22,1,.36,1); display: inline-flex; }
  .dropdown-chevron-wrap.open { transform: rotate(180deg); }

  .dropdown-panel {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 60;
    max-height: min(60vh, 320px); overflow-y: auto; overflow-x: hidden;
    margin: 0; padding: 4px; list-style: none;
    border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
    background: #131316; box-shadow: 0 18px 50px rgba(0,0,0,.6);
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.18) transparent;
  }
  .dropdown-panel::-webkit-scrollbar { width: 6px; }
  .dropdown-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 3px; }
  .dropdown-panel:focus { outline: none; }

  .dropdown-option {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    min-height: 40px; padding: 8px 10px;
    border-radius: 6px; color: #b7b7bd;
    font-size: .72rem; font-weight: 600; cursor: pointer;
    transition: background 140ms cubic-bezier(.22,1,.36,1), color 140ms cubic-bezier(.22,1,.36,1);
  }
  .dropdown-option:hover, .dropdown-option.active { background: rgba(255,255,255,.06); color: #f5f5f5; }
  .dropdown-option.selected { color: #ffffff; }
  .dropdown-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  :global(.dropdown-check) { flex: 0 0 auto; color: #ffffff; }

  @media (max-width: 640px) {
    .dropdown-trigger { min-height: 38px; padding: 7px 9px; font-size: .66rem; }
    .dropdown-option { min-height: 38px; padding: 7px 9px; font-size: .68rem; }
    .dropdown-panel { max-height: min(55vh, 280px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dropdown-trigger, .dropdown-option, .dropdown-chevron-wrap { transition: none; }
  }
</style>
