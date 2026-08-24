<script lang="ts">
  import type { MediaItem } from '$data/content';
  import TvError from './TvError.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvMediaRail from './TvMediaRail.svelte';

  export type TvSearchCategory = 'all' | 'movie' | 'series' | 'anime';

  let {
    query,
    category,
    results,
    keyboardOpen,
    submitted,
    loading,
    errorMessage,
    statusMessage,
    onOpenKeyboard,
    onCloseKeyboard,
    onKeyPress,
    onSubmit,
    onCategoryChange,
    onRetry,
    onSelect
  }: {
    query: string;
    category: TvSearchCategory;
    results: MediaItem[];
    keyboardOpen: boolean;
    submitted: boolean;
    loading: boolean;
    errorMessage: string;
    statusMessage: string;
    onOpenKeyboard: () => void;
    onCloseKeyboard: () => void;
    onKeyPress: (key: string) => void;
    onSubmit: () => void;
    onCategoryChange: (category: TvSearchCategory, focusId: string) => void;
    onRetry: () => void;
    onSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
  } = $props();

  const categoryItems: Array<{ id: TvSearchCategory; label: string }> = [
    { id: 'all', label: 'All / Search' },
    { id: 'movie', label: 'Movies' },
    { id: 'series', label: 'Shows' },
    { id: 'anime', label: 'Anime' }
  ];

  const keyboardRows = [
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
    ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'],
    ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '0'],
    ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  ];

  function categoryLabel(value: TvSearchCategory) {
    return categoryItems.find((item) => item.id === value)?.label ?? 'All / Search';
  }
</script>

<section class="tv-search" aria-labelledby="tv-search-title">
  <div class="search-heading">
    <div>
      <p class="eyebrow">Phase 4 / Search TV experience</p>
      <h2 id="tv-search-title">Find something to watch.</h2>
      <p class="search-copy">Use the TV keyboard, choose a catalog category, and press Search. No desktop text field is required.</p>
    </div>
    <div class="search-status" aria-live="polite">
      <span class="status-label">Search status</span>
      <strong>{submitted ? (loading ? 'Searching…' : categoryLabel(category)) : 'Ready'}</strong>
      <span>{statusMessage}</span>
    </div>
  </div>

  <div class="query-panel" aria-label="TV search query">
    <div class="query-row">
      <div class="query-value" aria-live="polite">
        <span class="query-label">Query</span>
        <strong>{query || 'Enter a title'}</strong>
      </div>
      <button
        class="tv-focusable search-control edit-query"
        data-tv-focusable="true"
        data-tv-focus-id="tv-search-input"
        data-tv-focus-group="tv-search-controls"
        type="button"
        onclick={onOpenKeyboard}
      >
        {keyboardOpen ? 'Keyboard open' : 'Edit query'}
      </button>
      <button
        class="tv-focusable search-control submit-query"
        data-tv-focusable="true"
        data-tv-focus-id="tv-search-submit"
        data-tv-focus-group="tv-search-controls"
        type="button"
        disabled={!query.trim() || loading}
        onclick={onSubmit}
      >
        Search
      </button>
    </div>

    {#if keyboardOpen}
      <div class="keyboard-panel" aria-label="On-screen TV keyboard">
        <div class="keyboard-heading">
          <span>Remote keyboard</span>
          <span>Arrow keys move · Enter selects · Back closes</span>
        </div>
        {#each keyboardRows as row, rowIndex}
          <div class="keyboard-row" role="group" aria-label={`Keyboard row ${rowIndex + 1}`}>
            {#each row as key}
              <button
                class="tv-focusable keyboard-key"
                data-tv-focusable="true"
                data-tv-focus-id={`tv-search-key-${key.toLowerCase()}`}
                data-tv-focus-group="tv-search-keyboard"
                type="button"
                onclick={() => onKeyPress(key)}
              >{key}</button>
            {/each}
          </div>
        {/each}
        <div class="keyboard-row utility-row">
          <button class="tv-focusable keyboard-key utility" data-tv-focusable="true" data-tv-focus-id="tv-search-key-space" data-tv-focus-group="tv-search-keyboard" type="button" onclick={() => onKeyPress(' ')}>Space</button>
          <button class="tv-focusable keyboard-key utility" data-tv-focusable="true" data-tv-focus-id="tv-search-key-backspace" data-tv-focus-group="tv-search-keyboard" type="button" onclick={() => onKeyPress('backspace')}>Backspace</button>
          <button class="tv-focusable keyboard-key utility" data-tv-focusable="true" data-tv-focus-id="tv-search-key-clear" data-tv-focus-group="tv-search-keyboard" type="button" onclick={() => onKeyPress('clear')}>Clear</button>
          <button class="tv-focusable keyboard-key utility search-key" data-tv-focusable="true" data-tv-focus-id="tv-search-key-enter" data-tv-focus-group="tv-search-keyboard" type="button" disabled={!query.trim() || loading} onclick={onSubmit}>Search</button>
          <button class="tv-focusable keyboard-key utility" data-tv-focusable="true" data-tv-focus-id="tv-search-key-close" data-tv-focus-group="tv-search-keyboard" type="button" onclick={onCloseKeyboard}>Close</button>
        </div>
      </div>
    {/if}
  </div>

  <div class="category-panel" role="group" aria-label="Search categories">
    <div class="category-heading">
      <span class="eyebrow">Catalog filter</span>
      <span>Query stays intact when the category changes.</span>
    </div>
    <div class="category-row">
      {#each categoryItems as item}
        {@const focusId = `tv-search-category-${item.id}`}
        <button
          class="tv-focusable category-button"
          class:active={category === item.id}
          data-tv-focusable="true"
          data-tv-focus-id={focusId}
          data-tv-focus-group="tv-search-categories"
          type="button"
          aria-pressed={category === item.id}
          onclick={() => onCategoryChange(item.id, focusId)}
        >
          <span class="category-index">{String(categoryItems.indexOf(item) + 1).padStart(2, '0')}</span>
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if loading}
    <TvLoading label="Searching the Mavero catalog…" />
  {:else if errorMessage}
    <TvError message={errorMessage} onRetry={(event) => { event.stopPropagation(); onRetry(); }} />
  {:else if results.length}
    <TvMediaRail title="Search results" eyebrow={`Results / ${categoryLabel(category)}`} railId="tv-search-results" items={results} onSelect={onSelect} />
  {:else if submitted}
    <div class="search-empty" role="status">
      <span class="empty-mark">/</span>
      <h3>No matching stories.</h3>
      <p>Try another title or choose a different category. The query remains available above.</p>
    </div>
  {:else}
    <div class="search-empty search-prompt" role="status">
      <span class="empty-mark">?</span>
      <h3>Search the Mavero catalog.</h3>
      <p>Open Edit query, enter letters with the remote keyboard, then activate Search.</p>
    </div>
  {/if}
</section>

<style>
  .tv-search { padding-top: 44px; }
  .search-heading { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .7fr); align-items: end; gap: 30px; padding: 0 6px 28px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 9px; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  h2 { max-width: 700px; margin: 0; font-size: clamp(2.2rem, 5vw, 4.6rem); letter-spacing: -.07em; line-height: .98; }
  .search-copy { max-width: 660px; margin: 18px 0 0; color: var(--tv-muted); font-size: .94rem; line-height: 1.55; }
  .search-status { display: grid; gap: 8px; padding: 20px; border: 1px solid var(--tv-line); border-radius: 15px; background: var(--tv-surface); }
  .status-label { color: var(--tv-muted); font-size: .59rem; letter-spacing: .12em; text-transform: uppercase; }
  .search-status strong { font-size: 1.12rem; }
  .search-status span:last-child { color: var(--tv-muted); font-size: .78rem; line-height: 1.45; }
  .query-panel { margin: 30px 6px 0; padding: 18px; border: 1px solid var(--tv-line); border-radius: 16px; background: rgba(20, 24, 34, .68); }
  .query-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; }
  .query-value { display: grid; gap: 5px; min-width: 0; padding: 8px 14px; }
  .query-label { color: var(--tv-muted); font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; }
  .query-value strong { min-height: 1.3em; overflow: hidden; color: var(--tv-ink); font-size: 1.35rem; text-overflow: ellipsis; white-space: nowrap; }
  .search-control { min-width: 130px; min-height: 54px; padding: 0 17px; border: 1px solid rgba(255,255,255,.16); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .78rem; font-weight: 850; cursor: pointer; }
  .search-control.submit-query { border-color: rgba(255, 62, 94, .58); background: rgba(255, 62, 94, .16); }
  .search-control:disabled, .keyboard-key:disabled { cursor: not-allowed; opacity: .42; }
  .keyboard-panel { display: grid; gap: 9px; margin-top: 18px; padding: 16px; border-top: 1px solid var(--tv-line); }
  .keyboard-heading, .category-heading { display: flex; justify-content: space-between; gap: 15px; color: var(--tv-muted); font-size: .66rem; }
  .keyboard-row { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; }
  .keyboard-key { min-height: 52px; border: 1px solid var(--tv-line); border-radius: 9px; color: var(--tv-ink); background: rgba(255,255,255,.055); font-size: .85rem; font-weight: 850; cursor: pointer; }
  .keyboard-key.utility { min-width: 0; font-size: .7rem; }
  .utility-row { grid-template-columns: 1fr 1.25fr 1fr 1fr 1fr; }
  .keyboard-key.search-key { border-color: rgba(255, 62, 94, .62); background: rgba(255, 62, 94, .18); }
  .category-panel { display: grid; gap: 12px; margin: 28px 6px 0; }
  .category-heading { align-items: end; }
  .category-heading .eyebrow { margin: 0; }
  .category-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .category-button { display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 0 15px; border: 1px solid var(--tv-line); border-radius: 11px; color: var(--tv-muted); background: rgba(255,255,255,.035); text-align: left; font-size: .78rem; font-weight: 850; cursor: pointer; }
  .category-button.active { border-color: rgba(255,62,94,.72); color: var(--tv-ink); background: rgba(255,62,94,.14); }
  .category-index { color: var(--tv-accent); font-size: .58rem; letter-spacing: .08em; }
  .search-empty { display: grid; place-items: center; gap: 8px; min-height: 190px; margin: 32px 6px 0; padding: 26px; border: 1px dashed var(--tv-line); border-radius: 15px; color: var(--tv-muted); text-align: center; background: var(--tv-surface); }
  .empty-mark { color: var(--tv-accent); font-size: 1.7rem; font-weight: 850; }
  .search-empty h3 { margin: 0; color: var(--tv-ink); font-size: 1.35rem; }
  .search-empty p { max-width: 520px; margin: 0; font-size: .78rem; line-height: 1.55; }
  @media (max-width: 800px) { .search-heading { grid-template-columns: 1fr; } .query-row { grid-template-columns: 1fr 1fr; } .query-value { grid-column: 1 / -1; } .category-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } .keyboard-heading, .category-heading { align-items: start; flex-direction: column; } }
</style>
