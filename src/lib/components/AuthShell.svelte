<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Clapperboard, ArrowLeft } from 'lucide-svelte';

  // Shared authentication layout shell — keeps sign-in / sign-up / reset
  // visually consistent. Does NOT touch authentication logic.
  export let eyebrow = 'MAVERO';
  export let title = '';
  // Optional emphasized word rendered in muted gray (matches the
  // cinematic detail-page eyebrow/title rhythm).
  export let titleAccent = '';
  export let subtitle = '';
  export let backHref = '/profile';
  export let backLabel = 'Back';
  export let children: Snippet;
</script>

<div class="auth-page">
  <a class="back-link" href={backHref}>
    <ArrowLeft size={15} /> <span>{backLabel}</span>
  </a>

  <div class="auth-card">
    <div class="brand-lockup" aria-label="MAVERO">
      <span class="brand-symbol"><Clapperboard size={18} strokeWidth={2.1} /></span>
      <span class="brand-word">MAVERO</span>
    </div>
    <div class="auth-eyebrow">{eyebrow}</div>
    <h1 class="auth-title">
      {title}{#if titleAccent}<span> {titleAccent}</span>{/if}
    </h1>
    {#if subtitle}<p class="auth-sub">{subtitle}</p>{/if}

    <div class="auth-content">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .auth-page {
    --a-gutter: clamp(16px, 5vw, 48px);
    min-height: calc(100dvh - 76px);
    padding: calc(40px + env(safe-area-inset-top, 0px)) var(--a-gutter) calc(90px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(circle at 80% -10%, rgba(255,255,255,.04), transparent 50%),
      radial-gradient(circle at 10% 110%, rgba(255,255,255,.03), transparent 50%),
      #000;
  }
  .back-link {
    position: absolute;
    top: calc(18px + env(safe-area-inset-top, 0px));
    left: var(--a-gutter);
    display: inline-flex; align-items: center; gap: 7px;
    color: #77777f;
    font-size: .72rem; font-weight: 700;
    text-decoration: none;
    transition: color 180ms ease, transform 180ms ease;
  }
  .back-link:hover { color: #f5f5f5; transform: translateX(-2px); }

  .auth-card {
    width: min(440px, 100%);
    padding: clamp(24px, 4vw, 36px);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 16px;
    background: rgba(15,15,18,.85);
    backdrop-filter: blur(8px);
    box-shadow: 0 20px 60px rgba(0,0,0,.4);
  }

  .brand-lockup {
    display: inline-flex; align-items: center; gap: 9px;
    margin-bottom: 18px;
    color: #f5f5f5;
  }
  .brand-symbol {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border-radius: 9px;
    color: #fff;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.06);
    box-shadow: 0 4px 12px rgba(255,255,255,.04);
  }
  .brand-word {
    font-size: .92rem; font-weight: 900;
    letter-spacing: .04em;
  }

  .auth-eyebrow {
    color: #77777f;
    font-size: .6rem; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase;
  }
  .auth-title {
    margin: 8px 0 8px;
    color: #f5f5f5;
    font-size: clamp(1.5rem, 4vw, 2.1rem);
    font-weight: 800;
    letter-spacing: -.025em;
    line-height: 1.1;
    text-wrap: balance;
  }
  .auth-title span { color: #77777f; }
  .auth-sub {
    margin: 0 0 22px;
    color: #b7b7bd;
    font-size: .82rem;
    line-height: 1.55;
  }

  .auth-content { display: grid; gap: 14px; }

  @media (max-width: 480px) {
    .auth-page { padding-top: calc(36px + env(safe-area-inset-top, 0px)); padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px)); }
    .auth-card { padding: 22px; border-radius: 14px; }
    .auth-title { font-size: clamp(1.4rem, 6vw, 1.9rem); }
    .auth-sub { font-size: .78rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-link { transition: none; }
  }
</style>
