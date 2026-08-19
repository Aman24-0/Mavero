<script lang="ts">
  import { ArrowUpRight, Bookmark, Clock3, Heart, LogIn, Settings2, ShieldCheck } from 'lucide-svelte';
  import { continueWatching, media } from '$data/content';
  import MediaCard from '$components/MediaCard.svelte';

  let saved = false;
</script>

<svelte:head>
  <title>Profile — Mavero</title>
</svelte:head>

<div class="container-wide profile-page">
  <section class="profile-header">
    <div class="profile-avatar">AM</div>
    <div><div class="eyebrow">MAVERO / Your space</div><h1>Welcome back, Alex.</h1><p>Pick up where you left off, or make room for something new.</p></div>
    <a href="/auth/sign-in" class="btn btn-secondary"><LogIn size={15} /> Sign in to sync</a>
  </section>

  <div class="profile-grid">
    <section class="profile-card profile-card-main"><div class="eyebrow">Guest mode</div><h2>Your watch history lives here.</h2><p>Mavero saves your progress on this device automatically. Sign in when you want it available everywhere.</p><div class="sync-row"><span><ShieldCheck size={15} /> Local & private</span><span>IndexedDB ready</span></div></section>
    <section class="profile-card"><div class="eyebrow">Your activity</div><div class="activity-list"><div><Clock3 size={15} /><span><strong>3h 42m</strong><small>Watched this week</small></span></div><div><Heart size={15} /><span><strong>12 titles</strong><small>Saved to your list</small></span></div></div></section>
  </div>

  <section class="section"><div class="section-head"><div><div class="eyebrow">Pick up the thread</div><h2 class="section-title">Continue watching</h2></div><a class="section-link" href="/discover">Browse more <ArrowUpRight size={14} /></a></div>{#if continueWatching.length}<div class="profile-rail">{#each continueWatching as item}<MediaCard {item} compact />{/each}</div>{:else}<div class="profile-empty">Nothing here yet. Start watching something to build your library.</div>{/if}</section>

  <section class="section"><div class="section-head"><div><div class="eyebrow">Saved for later</div><h2 class="section-title">My list</h2></div><button class="section-link list-button" onclick={() => (saved = !saved)}><Bookmark size={14} fill={saved ? 'currentColor' : 'none'} /> {saved ? 'Saved' : 'Save a title'}</button></div><div class="profile-rail">{#each media.slice(3, 7) as item}<MediaCard {item} />{/each}</div></section>

  <section class="cinelog-banner"><div class="cinelog-mark">CL</div><div><div class="eyebrow">A separate product, made for tracking</div><h2>Track everything you watch.</h2><p>Organize your movies, series, and anime with CineLog.</p></div><a class="btn btn-primary" href="https://cinelog.app" target="_blank" rel="noreferrer">Open CineLog <ArrowUpRight size={15} /></a></section>

  <section class="preferences"><div><div class="eyebrow">Preferences</div><h2>Keep it yours.</h2></div><div class="preference-items"><span><Settings2 size={15} /> Playback settings</span><span><Bookmark size={15} /> Manage my list</span></div></section>
</div>

<style>
  .profile-page { padding-bottom: 90px; }
  .profile-header { display: grid; grid-template-columns: 68px minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 84px 0 42px; }
  .profile-avatar { display: grid; place-items: center; width: 68px; height: 68px; border: 1px solid rgba(255,255,255,.18); border-radius: 50%; color: #0d0b14; background: linear-gradient(145deg, #dbb7a5, #8672a5); font-size: .9rem; font-weight: 800; }
  .profile-header h1 { margin: 7px 0 7px; font-size: clamp(2rem, 4vw, 4rem); line-height: .98; letter-spacing: -.07em; }
  .profile-header p { margin: 0; color: var(--muted); font-size: .84rem; }
  .profile-grid { display: grid; grid-template-columns: 1.4fr .8fr; gap: 14px; }
  .profile-card { min-height: 160px; padding: 22px; border: 1px solid var(--line); border-radius: 17px; background: var(--surface); }
  .profile-card-main { background: radial-gradient(circle at 80% 20%, rgba(155,135,245,.13), transparent 19rem), var(--surface); }
  .profile-card h2 { max-width: 440px; margin: 11px 0 8px; font-size: 1.75rem; letter-spacing: -.06em; }
  .profile-card p { max-width: 510px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .sync-row { display: flex; gap: 18px; margin-top: 25px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .59rem; }
  .sync-row span { display: inline-flex; align-items: center; gap: 6px; }
  .sync-row span:first-child { color: var(--success); }
  .activity-list { display: grid; gap: 16px; margin-top: 22px; }
  .activity-list > div { display: flex; align-items: center; gap: 10px; color: var(--accent); }
  .activity-list span { display: grid; gap: 3px; }
  .activity-list strong { color: var(--ink); font-size: .88rem; }
  .activity-list small { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .profile-rail { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(160px, 1fr); gap: 14px; overflow-x: auto; scrollbar-width: none; }
  .profile-rail::-webkit-scrollbar { display: none; }
  .profile-empty { padding: 36px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
  .cinelog-banner { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 16px; margin-top: 65px; padding: 22px; border: 1px solid rgba(155,135,245,.25); border-radius: 18px; background: rgba(155,135,245,.07); }
  .cinelog-mark { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; color: #0d0b14; background: var(--accent); font-size: .85rem; font-weight: 800; }
  .cinelog-banner h2 { margin: 7px 0 4px; font-size: 1.35rem; letter-spacing: -.05em; }
  .cinelog-banner p { margin: 0; color: var(--muted); font-size: .75rem; }
  .preferences { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 42px 0 0; }
  .preferences h2 { margin: 8px 0 0; font-size: 1.7rem; letter-spacing: -.06em; }
  .preference-items { display: grid; gap: 10px; align-content: start; }
  .preference-items span { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: .77rem; }
  .list-button { border: 0; background: none; cursor: pointer; }
  @media (max-width: 720px) { .profile-header { grid-template-columns: 52px minmax(0, 1fr); padding-top: 108px; } .profile-avatar { width: 52px; height: 52px; } .profile-header .btn { grid-column: 1 / -1; justify-self: start; } .profile-grid, .preferences { grid-template-columns: 1fr; } .profile-rail { grid-auto-columns: 42vw; } .cinelog-banner { grid-template-columns: 42px 1fr; } .cinelog-mark { width: 42px; height: 42px; border-radius: 12px; } .cinelog-banner .btn { grid-column: 1 / -1; justify-self: start; } }
</style>
