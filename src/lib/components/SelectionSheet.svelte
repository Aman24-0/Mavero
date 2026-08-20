<script lang="ts">
  type SelectionOption = {
    key: string;
    label: string;
    icon?: string;
    description?: string;
  };

  export let open = false;
  export let title = 'Choose an option';
  export let options: SelectionOption[] = [];
  export let selected = '';
  export let onClose: () => void = () => {};
  export let onSelect: (key: string) => void = () => {};

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') onClose();
  }

  function choose(key: string) {
    onSelect(key);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="sheet-layer" role="presentation">
    <button class="sheet-backdrop" aria-label="Close {title}" onclick={onClose}></button>
    <div class="selection-sheet" role="dialog" aria-modal="true" aria-labelledby="selection-sheet-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <header class="sheet-header">
        <div>
          <div class="eyebrow">MAVERO / Filter</div>
          <h2 id="selection-sheet-title">{title}</h2>
        </div>
        <button class="sheet-close" type="button" aria-label="Close {title}" onclick={onClose}>×</button>
      </header>
      <div class="sheet-options" role="listbox" tabindex="0" aria-label={title} aria-activedescendant={selected ? `option-${selected}` : undefined}>
        {#each options as option}
          <button id={`option-${option.key}`} class:active={selected === option.key} class="sheet-option" type="button" role="option" aria-selected={selected === option.key} onclick={() => choose(option.key)}>
            <span class="option-leading">
              {#if option.icon}<span class="option-icon" aria-hidden="true">{option.icon}</span>{/if}
              <span class="option-copy"><strong>{option.label}</strong>{#if option.description}<small>{option.description}</small>{/if}</span>
            </span>
            <span class="option-indicator" aria-hidden="true">{selected === option.key ? '●' : '○'}</span>
          </button>
        {/each}
      </div>
      <div class="sheet-safe-area" aria-hidden="true"></div>
    </div>
  </div>
{/if}

<style>
  .sheet-layer { position: fixed; inset: 0; z-index: 80; display: grid; align-items: end; }
  .sheet-backdrop { position: absolute; inset: 0; border: 0; background: rgba(2, 3, 5, .74); backdrop-filter: blur(8px); cursor: default; }
  .selection-sheet { position: relative; width: min(100%, 560px); max-height: min(78dvh, 680px); margin: 0 auto; overflow: hidden auto; border: 1px solid rgba(255,255,255,.14); border-bottom: 0; border-radius: 24px 24px 0 0; background: #15171a; box-shadow: 0 -18px 70px rgba(0,0,0,.42); animation: sheet-in 220ms cubic-bezier(.23,1,.32,1); }
  .sheet-handle { width: 38px; height: 4px; margin: 10px auto 0; border-radius: 99px; background: rgba(255,255,255,.24); }
  .sheet-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .sheet-header h2 { margin: 6px 0 0; color: var(--ink); font-size: 1.45rem; letter-spacing: -.05em; }
  .sheet-close { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid rgba(255,255,255,.14); border-radius: 50%; color: var(--muted); background: rgba(255,255,255,.04); font-size: 1.35rem; line-height: 1; cursor: pointer; }
  .sheet-close:hover, .sheet-close:focus-visible { color: var(--ink); border-color: rgba(155,135,245,.62); outline: 0; box-shadow: 0 0 0 3px rgba(155,135,245,.13); }
  .sheet-options { padding: 5px 12px 0; }
  .sheet-option { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 58px; gap: 14px; padding: 11px 8px; border: 0; border-bottom: 1px solid rgba(255,255,255,.07); color: var(--muted); background: transparent; text-align: left; cursor: pointer; transition: color 160ms ease-out, background 160ms ease-out, transform 160ms ease-out; }
  .sheet-option:last-child { border-bottom: 0; }
  .sheet-option:hover, .sheet-option:focus-visible { color: var(--ink); background: rgba(255,255,255,.035); outline: 0; }
  .sheet-option:active { transform: scale(.99); }
  .sheet-option.active { color: var(--ink); background: rgba(155,135,245,.1); }
  .option-leading { display: flex; align-items: center; min-width: 0; gap: 11px; }
  .option-icon { display: grid; flex: 0 0 30px; place-items: center; width: 30px; height: 30px; border: 1px solid rgba(155,135,245,.25); border-radius: 9px; color: var(--ink); background: rgba(155,135,245,.13); font-family: 'DM Mono', monospace; font-size: .55rem; font-weight: 800; }
  .option-copy { display: grid; gap: 3px; min-width: 0; }
  .option-copy strong { overflow: hidden; color: inherit; font-size: .83rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .option-copy small { color: var(--muted-deep); font-size: .65rem; }
  .option-indicator { flex: 0 0 auto; color: var(--muted-deep); font-size: .9rem; }
  .sheet-option.active .option-indicator { color: var(--accent); }
  .sheet-safe-area { height: max(16px, env(safe-area-inset-bottom)); }
  @keyframes sheet-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  @media (min-width: 700px) { .sheet-layer { align-items: center; padding: 20px; } .selection-sheet { border-bottom: 1px solid rgba(255,255,255,.14); border-radius: 24px; } }
  @media (prefers-reduced-motion: reduce) { .selection-sheet { animation: none; } .sheet-option { transition: none; } }
</style>
