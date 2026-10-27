<script lang="ts">
  // App-wide footer — shared between Discover, Settings and Upcoming.
  //
  //   1. MAVERO branding
  //   2. Tagline
  //   3. TMDB attribution (required by TMDB API terms)
  //   4. Telegram + Discord community links — read from app_config and passed in
  //      by the page. Each icon is hidden when its URL is unset; the whole row
  //      is hidden when both are unset.
  //   5. Factual third-party content disclaimer
  //   6. "Mavero @2026"
  let {
    telegramUrl = null,
    discordUrl = null,
  }: { telegramUrl?: string | null; discordUrl?: string | null } = $props();
</script>

<footer class="app-footer">
  <strong class="footer-brand">MAVERO</strong>
  <span class="footer-tagline">Movies, TV Shows, Anime &amp; Live TV — all in one place.</span>
  <div class="footer-attribution">
    <a class="tmdb-credit" href="https://www.themoviedb.org/about/logos-attribution?language=en-US" target="_blank" rel="noreferrer">
      <span>Data from</span>
      <img class="tmdb-logo" src="https://upload.wikimedia.org/wikipedia/commons/8/89/Tmdb.new.logo.svg" alt="The Movie Database (TMDB)" loading="lazy" />
    </a>
    {#if telegramUrl || discordUrl}
      <div class="footer-social">
        <span class="footer-social-label">Join</span>
        {#if telegramUrl}
          <a class="social-link" href={telegramUrl} target="_blank" rel="noreferrer" aria-label="Join us on Telegram">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
            <span>Telegram</span>
          </a>
        {/if}
        {#if discordUrl}
          <a class="social-link" href={discordUrl} target="_blank" rel="noreferrer" aria-label="Join our Discord">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3c-.2.4-.4.9-.6 1.3a18.3 18.3 0 0 0-5.5 0C9.1 3.9 8.9 3.4 8.7 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.2 13.7.2 18.3A19.9 19.9 0 0 0 6.3 21c.4-.6.8-1.2 1.1-1.9-.6-.2-1.2-.5-1.7-.9l.4-.3a14.2 14.2 0 0 0 12.2 0l.4.3c-.5.4-1.1.7-1.7.9.3.7.7 1.3 1.1 1.9a19.8 19.8 0 0 0 6.1-2.7c.5-5.3-.8-9.8-2.5-13.9zM8.5 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm7 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>
            <span>Discord</span>
          </a>
        {/if}
      </div>
    {/if}
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
  .footer-social { display: inline-flex; align-items: center; gap: 16px; }
  .footer-social-label { color: var(--muted, #77777f); font-size: .6rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
  .social-link { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-soft, #b7b7bd); font-size: .6rem; font-weight: 600; text-decoration: none; transition: color 160ms ease; }
  .social-link:hover { color: var(--ink, #f5f5f5); }
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
