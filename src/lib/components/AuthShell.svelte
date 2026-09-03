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
  <a class="back-pill" href={backHref}>
    <ArrowLeft size={15} /> <span>{backLabel}</span>
  </a>

  <!-- Atmospheric backdrop: subtle neutral glow only, no colored ambient. -->
  <div class="auth-atmosphere" aria-hidden="true">
    <div class="glow glow-a"></div>
    <div class="glow glow-b"></div>
  </div>

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
    position: relative;
    min-height: 100dvh;
    /* Auth bypasses AppShell, so it owns its own safe-area top padding.
       No fixed topbar here — the back pill is absolutely positioned
       below the status bar. */
    padding: calc(env(safe-area-inset-top, 0px) + 28px) var(--a-gutter) calc(110px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
    overflow: hidden;
  }

  .auth-atmosphere {
    position: absolute; inset: 0; z-index: 0;
    pointer-events: none;
  }
  .glow {
    position: absolute;
    border-radius: 50%;
    filter: blur(80px);
    opacity: .35;
  }
  .glow-a {
    width: 480px; height: 480px;
    top: -120px; right: -80px;
    background: radial-gradient(circle, rgba(255, 255, 255, .12), transparent 70%);
  }
  .glow-b {
    width: 420px; height: 420px;
    bottom: -100px; left: -60px;
    background: radial-gradient(circle, rgba(255, 255, 255, .06), transparent 70%);
  }

  .back-pill {
    position: absolute;
    top: calc(env(safe-area-inset-top, 0px) + 18px);
    left: var(--a-gutter);
    z-index: 2;
    display: inline-flex; align-items: center; gap: 7px;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 999px;
    color: #f5f5f5;
    background: rgba(10, 10, 10, .72);
    backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
    font-size: .74rem; font-weight: 700;
    text-decoration: none;
    transition: background 180ms ease, border-color 180ms ease, transform 180ms ease;
  }
  .back-pill:hover {
    background: rgba(20, 20, 20, .85);
    border-color: rgba(255, 255, 255, .24);
    transform: translateX(-2px);
  }
  .back-pill:active { transform: translateX(-2px) scale(.97); }
  .back-pill:focus-visible { outline: 2px solid #f5f5f5; outline-offset: 2px; }

  .auth-card {
    position: relative; z-index: 1;
    width: min(440px, 100%);
    padding: clamp(24px, 4vw, 36px);
    border: 1px solid rgba(255, 255, 255, .08);
    border-radius: 16px;
    background: rgba(13, 13, 13, .85);
    backdrop-filter: blur(14px);
    box-shadow: 0 24px 70px rgba(0, 0, 0, .55);
  }

  .brand-lockup {
    display: inline-flex; align-items: center; gap: 9px;
    margin-bottom: 22px;
    color: #f5f5f5;
  }
  .brand-symbol {
    display: grid; place-items: center;
    width: 32px; height: 32px;
    border-radius: 9px;
    color: #fff;
    background: rgba(255, 255, 255, .08);
    border: 1px solid rgba(255, 255, 255, .06);
    box-shadow: 0 4px 12px rgba(255, 255, 255, .04);
  }
  .brand-word {
    font-size: .92rem; font-weight: 900;
    letter-spacing: .04em;
  }

  .auth-eyebrow {
    color: #969696;
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
  .auth-title span { color: #646464; }
  .auth-sub {
    margin: 0 0 24px;
    color: #d0d0d0;
    font-size: .82rem;
    line-height: 1.55;
  }

  .auth-content { display: grid; gap: 14px; }

  @media (max-width: 480px) {
    .auth-page { padding-top: calc(env(safe-area-inset-top, 0px) + 24px); padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
    .auth-card { padding: 22px; border-radius: 14px; }
    .auth-title { font-size: clamp(1.4rem, 6vw, 1.9rem); }
    .auth-sub { font-size: .78rem; }
    .back-pill { padding: 0 14px; min-height: 42px; font-size: .7rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .back-pill { transition: none; }
  }
</style>
