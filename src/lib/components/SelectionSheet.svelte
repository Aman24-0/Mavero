<script lang="ts">
  type SelectionOption = { key: string; label: string; icon?: string; image?: string; description?: string };
  export let open = false;
  export let title = 'Choose an option';
  export let eyebrow = 'MAVERO / Filter';
  export let options: SelectionOption[] = [];
  export let selected = '';
  export let onClose: () => void = () => {};
  export let onSelect: (key: string) => void = () => {};
  function handleKeydown(event: KeyboardEvent) { if (open && event.key === 'Escape') onClose(); }
  function choose(key: string) { onSelect(key); }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="sheet-layer" role="presentation">
    <button class="sheet-backdrop" aria-label="Close {title}" onclick={onClose}></button>
    <div class="selection-sheet" role="dialog" aria-modal="true" aria-labelledby="selection-sheet-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <header class="sheet-header">
        <div><div class="eyebrow">{eyebrow}</div><h2 id="selection-sheet-title">{title}</h2></div>
        <button class="sheet-close" type="button" aria-label="Close {title}" onclick={onClose}>×</button>
      </header>
      <div class="sheet-options" role="listbox" tabindex="0" aria-label={title} aria-activedescendant={selected ? `option-${selected}` : undefined}>
        {#each options as option}
          <button id={`option-${option.key}`} class:active={selected === option.key} class="sheet-option" type="button" role="option" aria-selected={selected === option.key} onclick={() => choose(option.key)}>
            <span class="option-leading">
              {#if option.image || option.icon}<span class="option-icon" aria-hidden="true">{#if option.image}<img src={option.image} alt="" loading="lazy" onerror={(event) => { (event.currentTarget as HTMLImageElement).hidden = true; }} />{:else if option.icon}<span class="option-fallback">{option.icon}</span>{/if}</span>{/if}
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
  .sheet-backdrop { position: absolute; inset: 0; border: 0; background: rgba(3, 6, 7, .76); backdrop-filter: blur(10px); cursor: default; }
  .selection-sheet { position: relative; width: min(100%, 560px); max-height: min(78dvh, 680px); margin: 0 auto; overflow: hidden auto; border: 1px solid var(--line-strong); border-bottom: 0; border-radius: var(--radius-xl) var(--radius-xl) 0 0; background: var(--surface-2); box-shadow: 0 -18px 80px rgba(0,0,0,.45); animation: sheet-in 220ms var(--ease-out); }
  .sheet-handle { width: 38px; height: 4px; margin: 10px auto 0; border-radius: 99px; background: rgba(245, 246, 250,.25); }
  .sheet-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px 15px; border-bottom: 1px solid var(--line); }
  .sheet-header h2 { margin: 6px 0 0; color: var(--ink); font-size: 1.2rem; font-weight: 800; letter-spacing: -.015em; }
  .sheet-close { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--muted); background: rgba(245, 246, 250,.04); font-size: 1.35rem; line-height: 1; cursor: pointer; }
  .sheet-close:hover, .sheet-close:focus-visible { color: var(--ink); border-color: rgba(255, 62, 94,.62); outline: 0; box-shadow: 0 0 0 3px rgba(255, 62, 94,.12); }
  .sheet-options { padding: 6px 12px 0; }
  .sheet-option { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 62px; gap: 14px; padding: 11px 8px; border: 0; border-bottom: 1px solid var(--line); color: var(--muted); background: transparent; text-align: left; cursor: pointer; transition: color 160ms var(--ease-out), background 160ms var(--ease-out), transform 160ms var(--ease-out); }
  .sheet-option:last-child { border-bottom: 0; }
  .sheet-option:hover, .sheet-option:focus-visible { color: var(--ink); background: rgba(245, 246, 250,.035); outline: 0; }
  .sheet-option:active { transform: scale(.99); }
  .sheet-option.active { color: var(--ink); background: var(--accent-soft); }
  .option-leading { display: flex; align-items: center; min-width: 0; gap: 11px; }
  .option-icon { display: grid; flex: 0 0 32px; place-items: center; width: 32px; height: 32px; overflow: hidden; border: 1px solid rgba(255, 62, 94,.28); border-radius: 9px; color: var(--ink); background: rgba(255, 62, 94,.1); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; font-weight: 800; }
  .option-icon img { width: 19px; height: 19px; object-fit: contain; border-radius: 4px; }
  .option-fallback { display: grid; place-items: center; width: 100%; height: 100%; }
  .option-copy { display: grid; gap: 3px; min-width: 0; }
  .option-copy strong { overflow: hidden; color: inherit; font-size: .81rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .option-copy small { color: var(--muted-deep); font-size: .63rem; }
  .option-indicator { flex: 0 0 auto; color: var(--muted-deep); font-size: .9rem; }
  .sheet-option.active .option-indicator { color: var(--accent-strong); }
  .sheet-safe-area { height: max(16px, env(safe-area-inset-bottom)); }
  @keyframes sheet-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  @media (min-width: 700px) { .sheet-layer { align-items: center; padding: 20px; } .selection-sheet { border-bottom: 1px solid var(--line-strong); border-radius: var(--radius-xl); } }
  @media (prefers-reduced-motion: reduce) { .selection-sheet { animation: none; } .sheet-option { transition: none; } }
</style>
