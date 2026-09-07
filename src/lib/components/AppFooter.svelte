<script lang="ts">
  // Reusable app-wide footer — shared between Discover and Profile.
  //
  // Contains:
  //   1. MAVERO branding
  //   2. Tagline: "Movies, series & anime — all in one place."
  //   3. TMDB attribution + logo (required by TMDB API terms)
  //   4. JustWatch attribution (required because TMDB watch-provider
  //      data is powered by JustWatch)
  //   5. Factual third-party content disclaimer
  //   6. "Mavero @2026"
  //
  // Both Discover and Profile render this same component so the footer
  // is visually and functionally consistent. No duplicated CSS.
</script>

<footer class="app-footer">
  <strong class="footer-brand">MAVERO</strong>
  <span class="footer-tagline">Movies, series &amp; anime — all in one place.</span>
  <div class="footer-attribution">
    <a class="tmdb-credit" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer">
      <span>Data from</span>
      <img class="tmdb-logo" src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="The Movie Database (TMDB)" loading="lazy" />
    </a>
    <span class="justwatch-credit">Provider availability powered by <a href="https://www.justwatch.com" target="_blank" rel="noreferrer">JustWatch</a></span>
  </div>
  <p class="footer-disclaimer">Mavero does not host, upload, or store any movies, TV shows, or anime. Content is provided through third-party services available on the internet.</p>
  <span class="footer-copyright">Mavero @2026</span>
</footer>

<style>
  .app-footer {
    padding: 40px 0 20px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .footer-brand { color: var(--ink, #f5f5f5); font-size: .8rem; font-weight: 800; letter-spacing: .04em; }
  .footer-tagline { color: var(--muted, #77777f); font-size: .65rem; }
  .footer-attribution { margin-top: 10px; display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .tmdb-credit { display: inline-flex; align-items: center; gap: 5px; color: var(--muted, #77777f); font-size: .6rem; text-decoration: none; }
  .tmdb-credit:hover { color: var(--ink-soft, #b7b7bd); }
  .tmdb-logo { height: 12px; width: auto; opacity: .8; }
  .justwatch-credit { color: var(--muted, #77777f); font-size: .58rem; }
  .justwatch-credit a { color: var(--ink-soft, #b7b7bd); text-decoration: none; }
  .justwatch-credit a:hover { text-decoration: underline; }
  .footer-disclaimer {
    margin: 10px auto 0;
    max-width: 440px;
    color: var(--muted, #55555d);
    font-size: .55rem;
    line-height: 1.5;
  }
  .footer-copyright { margin-top: 8px; color: var(--muted, #55555d); font-size: .58rem; letter-spacing: .04em; }

  @media (max-width: 640px) {
    .footer-disclaimer { max-width: 320px; }
  }
</style>
