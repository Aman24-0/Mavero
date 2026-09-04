<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowLeft, Calendar, Film, Tv, Sparkles, Star, ArrowUpRight } from 'lucide-svelte';
  import Dropdown from '$components/Dropdown.svelte';
  import ScrollToTop from '$components/ScrollToTop.svelte';
  import type { PageData } from './$types';
  import type { UpcomingItem, UpcomingType } from '$lib/server/content/upcoming-types';

  let { data }: { data: PageData } = $props();

  const monthOptions = [
    { value: '1', label: 'January' },
    { value: '2', label: 'February' },
    { value: '3', label: 'March' },
    { value: '4', label: 'April' },
    { value: '5', label: 'May' },
    { value: '6', label: 'June' },
    { value: '7', label: 'July' },
    { value: '8', label: 'August' },
    { value: '9', label: 'September' },
    { value: '10', label: 'October' },
    { value: '11', label: 'November' },
    { value: '12', label: 'December' }
  ];

  const typeOptions = [
    { value: 'all', label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'series', label: 'Series' },
    { value: 'anime', label: 'Anime' }
  ];

  // Build year options from the server-provided list.
  let yearOptions = $derived(
    (data.yearOptions ?? []).map((y: number) => ({ value: String(y), label: String(y) }))
  );

  let selectedMonth = $state(String(data.filters.month));
  let selectedYear = $state(String(data.filters.year));
  let selectedType = $state<'all' | UpcomingType>(data.filters.type);

  function updateFilter(next: { month?: string; year?: string; type?: string }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.month !== undefined) params.set('month', next.month);
    if (next.year !== undefined) params.set('year', next.year);
    if (next.type !== undefined) params.set('type', next.type);
    void goto(`${page.url.pathname}?${params.toString()}`, { keepFocus: true, noScroll: true });
  }

  function setMonth(value: string) { selectedMonth = value; updateFilter({ month: value }); }
  function setYear(value: string) { selectedYear = value; updateFilter({ year: value }); }
  function setType(value: string) { selectedType = value as 'all' | UpcomingType; updateFilter({ type: value }); }

  // Group items by date for the calendar feel.
  type DayGroup = { date: string; label: string; items: UpcomingItem[] };
  const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let dayGroups = $derived.by(() => {
    const map = new Map<string, UpcomingItem[]>();
    for (const item of data.items) {
      const key = item.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const groups: DayGroup[] = [];
    for (const [date, items] of map) {
      const d = new Date(date + 'T00:00:00Z');
      const dayName = dayNames[d.getUTCDay()] ?? '';
      const monthLabel = monthLabels[d.getUTCMonth()] ?? '';
      const dayNum = String(d.getUTCDate()).padStart(2, '0');
      groups.push({ date, label: `${dayName}, ${monthLabel} ${dayNum}`, items: items.sort((a, b) => a.timestamp - b.timestamp) });
    }
    return groups.sort((a, b) => a.date.localeCompare(b.date));
  });

  let hasResults = $derived(data.items.length > 0);
  let monthLabel = $derived(monthOptions.find((m) => m.value === selectedMonth)?.label ?? '');
  let yearLabel = $derived(selectedYear);

  function typeIcon(type: UpcomingType) {
    return type === 'movie' ? Film : type === 'series' ? Tv : Sparkles;
  }
  function typeBadge(type: UpcomingType) {
    return type === 'movie' ? 'Movie' : type === 'series' ? 'Series' : 'Anime';
  }
  function formatDate(date: string) {
    const d = new Date(date + 'T00:00:00Z');
    return `${monthLabels[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} · ${d.getUTCFullYear()}`;
  }
  function detailHref(item: UpcomingItem) {
    return `/${item.type}/${item.id.replace(/^(movie|series|anime)-/, '')}`;
  }
</script>

<svelte:head>
  <title>Upcoming — Mavero</title>
  <meta name="description" content="Upcoming movies, series episodes, and anime releases on MAVERO." />
  <meta name="robots" content="noindex,follow" />
</svelte:head>

<div class="upcoming-page">
  <header class="upcoming-header">
    <div class="header-inner">
      <a class="back-pill" href="/profile"><ArrowLeft size={15} /> <span>Profile</span></a>
      <div class="header-eyebrow"><Calendar size={13} /> MAVERO / Upcoming</div>
      <h1>Upcoming</h1>
      <p>What's coming next — movies, series episodes, and anime releases.</p>
    </div>
  </header>

  <div class="filters-bar">
    <div class="filters-inner">
      <div class="filter-wrap">
        <Dropdown id="upcoming-month" label="Month" value={selectedMonth} options={monthOptions} onChange={setMonth} />
      </div>
      <div class="filter-wrap">
        <Dropdown id="upcoming-year" label="Year" value={selectedYear} options={yearOptions} onChange={setYear} />
      </div>
      <div class="filter-wrap">
        <Dropdown id="upcoming-type" label="Type" value={selectedType} options={typeOptions} onChange={setType} />
      </div>
    </div>
  </div>

  <div class="upcoming-body">
    {#if data.errorMessage && !hasResults}
      <section class="error-state" role="alert">
        <div class="error-mark">!</div>
        <h2>No releases found</h2>
        <p>{data.errorMessage}</p>
        <button class="retry-btn" type="button" onclick={() => window.location.reload()}>Try again</button>
      </section>
    {:else if !hasResults}
      <section class="empty-state" aria-live="polite">
        <div class="empty-mark" aria-hidden="true"><Calendar size={24} /></div>
        <h2>No releases found</h2>
        <p>No Movies, Series, or Anime matching {monthLabel} {yearLabel} with the {typeOptions.find((t) => t.value === selectedType)?.label} filter.</p>
        <button class="empty-action" type="button" onclick={() => setType('all')}>Change filters</button>
      </section>
    {:else}
      {#if data.errors.length}
        <div class="partial-warning" role="status">
          Some sources were unavailable: {data.errors.join('; ')}
        </div>
      {/if}

      <div class="month-heading">{monthLabel} {yearLabel}</div>

      <div class="day-groups">
        {#each dayGroups as group (group.date)}
          <section class="day-group">
            <h2 class="day-label">{group.label}</h2>
            <div class="day-cards">
              {#each group.items as item (item.id)}
                <a class="release-card" href={detailHref(item)}>
                  <div class="card-poster">
                    {#if item.poster}
                      <img src={item.poster} alt={item.title} loading="lazy" decoding="async" />
                    {:else}
                      <div class="poster-fallback"><Film size={20} /></div>
                    {/if}
                    <span class="type-badge">{typeBadge(item.type)}</span>
                  </div>
                  <div class="card-body">
                    {#if item.providers?.length}
                      <div class="providers-row" aria-label="Streaming providers">
                        {#each item.providers.slice(0, 3) as provider}
                          <img src={provider.logo} alt={provider.name} class="provider-logo" loading="lazy" title={provider.name} />
                        {/each}
                        {#if item.providers.length > 3}
                          <span class="provider-more">+{item.providers.length - 3}</span>
                        {/if}
                      </div>
                    {/if}
                    <h3 class="card-title">{item.title}</h3>
                    <div class="card-meta">
                      {#if item.type === 'series' && item.season !== undefined && item.episode !== undefined}
                        <span class="ep-tag">S{String(item.season).padStart(2, '0')} · E{String(item.episode).padStart(2, '0')}</span>
                      {:else if item.type === 'anime' && item.episode !== undefined}
                        <span class="ep-tag">Episode {item.episode}</span>
                      {/if}
                      <span class="date-tag">{formatDate(item.date)}</span>
                      {#if item.rating && item.rating > 0}
                        <span class="rating-tag"><Star size={9} fill="currentColor" strokeWidth={0} /> {item.rating.toFixed(1)}</span>
                      {/if}
                    </div>
                    {#if item.episodeTitle}
                      <div class="episode-title">{item.episodeTitle}</div>
                    {/if}
                    {#if item.genres?.length}
                      <div class="genres-row">{item.genres.join(' · ')}</div>
                    {/if}
                  </div>
                  <ArrowUpRight size={15} class="card-arrow" />
                </a>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>

<ScrollToTop />

<style>
  .upcoming-page {
    --u-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding-bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  }

  .upcoming-header {
    padding: 26px var(--u-gutter) 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .05);
    background:
      radial-gradient(circle at 85% -20%, rgba(255, 255, 255, .04), transparent 50%),
      #000;
  }
  .header-inner { width: min(1100px, 100%); margin-inline: auto; }
  .back-pill {
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 42px;
    padding: 0 16px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(10, 10, 10, .6);
    backdrop-filter: blur(8px);
    font-size: .74rem; font-weight: 700;
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease, transform 180ms ease;
  }
  .back-pill:hover { background: rgba(20, 20, 20, .8); border-color: rgba(255, 255, 255, .24); transform: translateX(-2px); }
  .back-pill:active { transform: translateX(-2px) scale(.97); }
  .back-pill:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }
  .header-eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 22px;
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .upcoming-header h1 {
    margin: 8px 0 6px;
    color: #f5f5f5;
    font-size: clamp(1.8rem, 4vw, 2.6rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.05;
  }
  .upcoming-header p {
    margin: 0;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
    max-width: 520px;
  }

  .filters-bar {
    padding: 18px var(--u-gutter);
    border-bottom: 1px solid rgba(255, 255, 255, .05);
  }
  .filters-inner {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: end;
    width: min(1100px, 100%);
    margin-inline: auto;
  }
  .filter-wrap { min-width: 130px; flex: 1 1 130px; }

  .upcoming-body {
    padding: 0 var(--u-gutter);
    width: min(1100px, calc(100% - 2 * var(--u-gutter)));
    margin-inline: auto;
    padding-top: 22px;
  }

  .partial-warning {
    margin-bottom: 18px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 176, 32, .25);
    border-radius: 10px;
    background: rgba(255, 176, 32, .04);
    color: #ffb020;
    font-size: .72rem;
    line-height: 1.5;
  }

  .month-heading {
    color: #f5f5f5;
    font-size: 1.2rem; font-weight: 800;
    letter-spacing: -.015em;
    margin-bottom: 16px;
  }

  .day-groups { display: grid; gap: 24px; }
  .day-group { display: grid; gap: 12px; }
  .day-label {
    margin: 0;
    color: #c7c7cc;
    font-size: .68rem; font-weight: 800;
    letter-spacing: .12em; text-transform: uppercase;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, .05);
  }

  .day-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }

  .release-card {
    display: grid;
    grid-template-columns: 80px 1fr auto;
    gap: 12px;
    align-items: start;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 12px;
    background: rgba(255, 255, 255, .012);
    color: inherit;
    text-decoration: none;
    transition: border-color 200ms cubic-bezier(.22,1,.36,1), background 200ms cubic-bezier(.22,1,.36,1);
  }
  .release-card:hover { border-color: rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .025); }
  .release-card:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  .card-poster {
    position: relative;
    width: 80px; aspect-ratio: 2 / 3;
    border-radius: 8px; overflow: hidden;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, .05);
  }
  .card-poster img { width: 100%; height: 100%; object-fit: cover; }
  .poster-fallback { display: grid; place-items: center; width: 100%; height: 100%; color: #555; }
  .type-badge {
    position: absolute; top: 4px; left: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, .7);
    color: #f5f5f5;
    font-size: .48rem; font-weight: 800;
    letter-spacing: .04em; text-transform: uppercase;
  }

  .card-body { min-width: 0; }
  .providers-row {
    display: flex; align-items: center; gap: 4px;
    margin-bottom: 6px;
  }
  .provider-logo {
    width: 18px; height: 18px;
    border-radius: 4px;
    object-fit: contain;
    border: 1px solid rgba(255, 255, 255, .08);
  }
  .provider-more {
    color: #969696;
    font-size: .56rem; font-weight: 700;
  }
  .card-title {
    margin: 0;
    color: #f5f5f5;
    font-size: .84rem; font-weight: 700;
    letter-spacing: -.005em;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2; line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin-top: 6px;
    color: #b7b7bd;
    font-size: .64rem; font-weight: 600;
  }
  .ep-tag {
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 255, 255, .08);
    color: #f5f5f5;
    font-size: .58rem; font-weight: 800;
    letter-spacing: .03em;
  }
  .date-tag { color: #c7c7cc; }
  .rating-tag {
    display: inline-flex; align-items: center; gap: 2px;
    color: #ffc94d;
    font-size: .58rem; font-weight: 700;
  }
  .episode-title {
    margin-top: 5px;
    color: #969696;
    font-size: .68rem; font-weight: 500;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .genres-row {
    margin-top: 4px;
    color: #646464;
    font-size: .58rem;
    letter-spacing: .02em;
  }
  .release-card :global(.card-arrow) { color: #646464; align-self: center; flex: 0 0 auto; }

  .empty-state, .error-state {
    display: grid; place-items: center; gap: 8px;
    min-height: 280px;
    padding: 48px 24px;
    text-align: center;
  }
  .empty-mark, .error-mark {
    display: grid; place-items: center;
    width: 60px; height: 60px;
    margin-bottom: 6px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 50%;
    color: #b7b7bd;
    background: rgba(255, 255, 255, .03);
  }
  .error-mark { color: #ffb020; border-color: rgba(255, 176, 32, .3); background: rgba(255, 176, 32, .05); font-size: 1.4rem; font-weight: 800; }
  .empty-state h2, .error-state h2 {
    margin: 4px 0;
    color: #f5f5f5;
    font-size: 1.3rem; font-weight: 800;
    letter-spacing: -.015em;
  }
  .empty-state p, .error-state p {
    margin: 0; max-width: 360px;
    color: #b7b7bd;
    font-size: .82rem; line-height: 1.6;
  }
  .empty-action, .retry-btn {
    margin-top: 12px;
    padding: 10px 22px;
    border: 1px solid rgba(255, 255, 255, .14);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(255, 255, 255, .06);
    font: inherit;
    font-size: .76rem; font-weight: 700;
    cursor: pointer;
    transition: background 180ms ease, border-color 180ms ease;
  }
  .empty-action:hover, .retry-btn:hover { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .24); }

  @media (max-width: 640px) {
    .upcoming-header { padding-top: 22px; padding-bottom: 18px; }
    .upcoming-header h1 { font-size: clamp(1.5rem, 6vw, 2rem); }
    .filters-inner { gap: 8px; }
    .filter-wrap { min-width: 0; flex: 1 1 100%; }
    .day-cards { grid-template-columns: 1fr; }
    .release-card { grid-template-columns: 64px 1fr auto; gap: 10px; padding: 10px; }
    .card-poster { width: 64px; }
  }
  @media (min-width: 900px) {
    .upcoming-header { padding-top: 44px; padding-bottom: 26px; }
    .upcoming-header h1 { font-size: clamp(2rem, 3.4vw, 2.8rem); }
    .day-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-pill, .release-card { transition: none; }
  }
</style>
