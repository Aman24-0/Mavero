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
    onSelect,
    nativeImeExperiment = false,
    nativeQuery = '',
    onNativeQueryInput,
    onNativeQuerySubmit
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
    nativeImeExperiment?: boolean;
    nativeQuery?: string;
    onNativeQueryInput?: (value: string) => void;
    onNativeQuerySubmit?: () => void;
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

  {#if nativeImeExperiment}
    <section class="native-ime-panel" aria-labelledby="native-ime-title">
      <div class="native-ime-copy">
        <p class="eyebrow">Phase 5 / Native IME experiment</p>
        <h3 id="native-ime-title">System keyboard probe.</h3>
        <p>Focused HTML input only. On Samsung, press OK/Enter and record whether the system keyboard opens inside the TizenBrew-hosted module.</p>
      </div>
      <label class="native-ime-field">
        <span>Native text input</span>
        <input
          class="tv-focusable native-ime-input"
          data-tv-focusable="true"
          data-tv-focus-id="tv-search-native-ime-input"
          data-tv-focus-group="tv-search-native-ime"
          type="text"
          inputmode="text"
          autocomplete="off"
          maxlength="120"
          value={nativeQuery}
          oninput={(event) => onNativeQueryInput?.((event.currentTarget as HTMLInputElement).value)}
          onchange={(event) => onNativeQueryInput?.((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <button
        class="tv-focusable native-ime-submit"
        data-tv-focusable="true"
        data-tv-focus-id="tv-search-native-ime-submit"
        data-tv-focus-group="tv-search-native-ime"
        type="button"
        disabled={!nativeQuery.trim() || loading}
        onclick={() => onNativeQuerySubmit?.()}
      >Use query / Search</button>
    </section>
  {/if}

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
  .tv-search {
    --tv-search-category-font: clamp(1.04rem, 1.55vw, 1.28rem);
    --tv-search-key-font: clamp(1.12rem, 1.7vw, 1.42rem);
    --tv-search-utility-font: clamp(.96rem, 1.35vw, 1.14rem);
    padding-top: 44px;
  }
  .search-heading { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .7fr); align-items: end; gap: 30px; padding: 0 6px 28px; border-bottom: 1px solid var(--tv-line); }
  .eyebrow { margin: 0 0 9px; color: var(--tv-accent); font-size: .76rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  h2 { max-width: 700px; margin: 0; font-size: clamp(2.45rem, 5.4vw, 5rem); font-weight: 950; letter-spacing: -.07em; line-height: .98; }
  .search-copy { max-width: 660px; margin: 18px 0 0; color: var(--tv-muted-strong, #eef1f8); font-size: clamp(1rem, 1.4vw, 1.18rem); font-weight: 650; line-height: 1.55; }
  .search-status { display: grid; gap: 8px; padding: 20px; border: 1px solid var(--tv-line); border-radius: 15px; background: var(--tv-surface); }
  .status-label { color: var(--tv-muted); font-size: .72rem; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
  .search-status strong { color: var(--tv-ink); font-size: 1.36rem; font-weight: 950; }
  .search-status span:last-child { color: var(--tv-muted-strong, #eef1f8); font-size: .94rem; font-weight: 650; line-height: 1.45; }
  .query-panel { margin: 30px 6px 0; padding: 18px; border: 1px solid var(--tv-line); border-radius: 16px; background: rgba(20, 24, 34, .68); }
  .query-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; }
  .query-value { display: grid; gap: 5px; min-width: 0; padding: 8px 14px; }
  .query-label { color: var(--tv-muted); font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; }
  .query-value strong { min-height: 1.3em; overflow: hidden; color: var(--tv-ink); font-size: 1.35rem; text-overflow: ellipsis; white-space: nowrap; }
  .search-control { min-width: 130px; min-height: 54px; padding: 0 17px; border: 1px solid rgba(255,255,255,.16); border-radius: 11px; color: var(--tv-ink); background: var(--tv-surface-soft); font-size: .78rem; font-weight: 850; cursor: pointer; }
  .search-control.submit-query { border-color: rgba(255, 62, 94, .58); background: rgba(255, 62, 94, .16); }
  .search-control:disabled, .keyboard-key:disabled { cursor: not-allowed; opacity: .42; }
  .keyboard-panel { display: grid; gap: 9px; margin-top: 18px; padding: 16px; border-top: 1px solid var(--tv-line); }
  .keyboard-heading, .category-heading { display: flex; justify-content: space-between; gap: 15px; color: var(--tv-muted-strong, #eef1f8); font-size: .82rem; font-weight: 700; }
  .keyboard-row { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; }
  .keyboard-key { min-height: 58px; border: 2px solid rgba(255,255,255,.2); border-radius: 9px; color: var(--tv-ink); background: rgba(255,255,255,.1); font-size: var(--tv-search-key-font); font-weight: 950; line-height: 1.1; cursor: pointer; }
  .keyboard-key.utility { min-width: 0; overflow: hidden; font-size: var(--tv-search-utility-font); line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
  .utility-row { grid-template-columns: 1fr 1.25fr 1fr 1fr 1fr; }
  .keyboard-key.search-key { border-color: rgba(255, 62, 94, .62); background: rgba(255, 62, 94, .18); }
  .native-ime-panel { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(260px, .85fr) auto; align-items: end; gap: 14px; margin: 28px 6px 0; padding: 18px; border: 1px dashed rgba(255, 62, 94, .5); border-radius: 15px; background: rgba(255, 62, 94, .06); }
  .native-ime-copy { min-width: 0; }
  .native-ime-copy h3 { margin: 0; font-size: clamp(1.15rem, 2vw, 1.55rem); letter-spacing: -.04em; }
  .native-ime-copy p:last-child { max-width: 600px; margin: 8px 0 0; color: var(--tv-muted); font-size: .78rem; line-height: 1.5; }
  .native-ime-field { display: grid; gap: 7px; min-width: 0; color: var(--tv-muted); font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
  .native-ime-input { width: 100%; min-height: 56px; padding: 0 14px; border: 1px solid var(--tv-line); border-radius: 10px; color: var(--tv-ink); background: rgba(8, 10, 15, .65); font: inherit; font-size: 1rem; letter-spacing: normal; text-transform: none; }
  .native-ime-submit { min-height: 56px; padding: 0 16px; border: 1px solid rgba(255, 62, 94, .62); border-radius: 10px; color: var(--tv-ink); background: rgba(255, 62, 94, .16); font-size: var(--tv-search-utility-font); font-weight: 850; white-space: nowrap; cursor: pointer; }
  .native-ime-submit:disabled { cursor: not-allowed; opacity: .42; }
  .category-panel { display: grid; gap: 12px; margin: 28px 6px 0; }
  .category-heading { align-items: end; }
  .category-heading .eyebrow { margin: 0; }
  .category-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .category-button { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 62px; padding: 0 15px; overflow: hidden; border: 2px solid rgba(255,255,255,.2); border-radius: 11px; color: var(--tv-muted-strong, #eef1f8); background: rgba(255,255,255,.08); text-align: left; font-size: var(--tv-search-category-font); font-weight: 950; line-height: 1.15; cursor: pointer; }
  .category-button.active { border-color: #ff7690; color: #fff; background: rgba(255,62,94,.28); }
  .category-index { flex: 0 0 auto; color: #ffd45d; font-size: .74rem; font-weight: 950; letter-spacing: .08em; }
  .category-button > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .search-empty { display: grid; place-items: center; gap: 8px; min-height: 190px; margin: 32px 6px 0; padding: 26px; border: 1px dashed var(--tv-line); border-radius: 15px; color: var(--tv-muted); text-align: center; background: var(--tv-surface); }
  .empty-mark { color: var(--tv-accent); font-size: 1.7rem; font-weight: 850; }
  .search-empty h3 { margin: 0; color: var(--tv-ink); font-size: 1.55rem; font-weight: 900; }
  .search-empty p { max-width: 520px; margin: 0; color: var(--tv-muted-strong, #eef1f8); font-size: .94rem; font-weight: 650; line-height: 1.55; }
  @media (max-width: 800px) { .search-heading { grid-template-columns: 1fr; } .query-row { grid-template-columns: 1fr 1fr; } .query-value { grid-column: 1 / -1; } .native-ime-panel { grid-template-columns: 1fr; align-items: stretch; } .category-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } .keyboard-heading, .category-heading { align-items: start; flex-direction: column; } }
</style>
