<script lang="ts">
  import { ArrowLeft, Boxes, Play, Radio, ShieldCheck, Sparkles } from 'lucide-svelte';
  import type { PlayerContentContext } from '$lib/shared/player';

  export let content: PlayerContentContext;
  export let episodeLabel = '';
  export let onSelect: (mode: 'source' | 'native') => void = () => {};
  export let onClose: () => void = () => {};
</script>

<svelte:head><title>Choose player for {content.title} — Mavero</title></svelte:head>

<main class="choice-page" aria-labelledby="choice-title">
  <div class="choice-backdrop" style={`background-image: url('${content.backdrop ?? content.poster ?? ''}')`}></div>
  <div class="choice-orb" aria-hidden="true"></div>
  <div class="choice-inner">
    <button class="back-button" type="button" onclick={onClose}><ArrowLeft size={16} /> Back</button>
    <div class="choice-kicker"><span></span>MAVERO / WATCH NOW</div>
    <div class="choice-heading">
      <div>
        <p class="eyebrow">{episodeLabel || 'Ready when you are'}</p>
        <h1 id="choice-title">Choose your player</h1>
        <p class="choice-intro">Select how you want to watch <strong>{content.title}</strong>. The stable source experience stays untouched while the Native Player remains available for independent testing.</p>
      </div>
      <div class="choice-index" aria-hidden="true"><span>01</span><small>PLAYBACK<br />MODES</small></div>
    </div>

    <div class="mode-grid">
      <button class="mode-card stable" type="button" onclick={() => onSelect('source')}>
        <div class="mode-card-top"><span class="mode-icon"><Play size={18} fill="currentColor" /></span><span class="mode-tag">Stable</span></div>
        <div class="mode-copy"><h2>Source Player</h2><p>Use the existing MAVERO playback system, provider selection, fallback, and embed controls.</p></div>
        <div class="mode-features"><span><Boxes size={14} /> Existing sources</span><span><ShieldCheck size={14} /> Proven flow</span></div>
        <span class="mode-action">Continue to Source Player <ArrowLeft size={15} /></span>
      </button>

      <button class="mode-card experimental" type="button" onclick={() => onSelect('native')}>
        <div class="mode-card-top"><span class="mode-icon"><Radio size={18} /></span><span class="mode-tag">Experimental</span></div>
        <div class="mode-copy"><h2>Native Player</h2><p>Test unified aggregation, public discovery, and MAVERO's native HLS, DASH, MP4, and WebM playback.</p></div>
        <div class="mode-features"><span><Sparkles size={14} /> Unified aggregation</span><span><Radio size={14} /> Direct streams</span></div>
        <span class="mode-action">Continue to Native Player <ArrowLeft size={15} /></span>
      </button>
    </div>

    <p class="choice-footnote">You can return to this choice from the watch route at any time. Native Player errors never silently switch playback modes.</p>
  </div>
</main>

<style>
  .choice-page { position: relative; display: grid; min-height: 100dvh; overflow: hidden; background: #070709; color: var(--ink); }
  .choice-backdrop { position: absolute; inset: 0; background-position: center; background-size: cover; opacity: .18; filter: saturate(.65) blur(2px); transform: scale(1.04); }
  .choice-page::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(7,7,9,.98) 3%, rgba(7,7,9,.9) 42%, rgba(7,7,9,.68) 100%), linear-gradient(0deg, #070709 3%, transparent 55%, rgba(7,7,9,.55)); pointer-events: none; }
  .choice-orb { position: absolute; top: 12%; right: 12%; width: 22rem; height: 22rem; border: 1px solid rgba(194,181,255,.12); border-radius: 50%; box-shadow: 0 0 0 2rem rgba(155,135,245,.025), 0 0 100px rgba(155,135,245,.11); pointer-events: none; }
  .choice-inner { position: relative; z-index: 1; width: min(1080px, calc(100% - 48px)); margin: auto; padding: 40px 0 32px; }
  .back-button { display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: .7rem; font-weight: 800; cursor: pointer; }
  .back-button:hover { color: var(--ink); }
  .choice-kicker { display: flex; align-items: center; gap: 9px; margin-top: clamp(70px, 12vh, 132px); color: var(--muted); font-family: 'DM Mono', monospace; font-size: .57rem; letter-spacing: .15em; }
  .choice-kicker span { width: 22px; height: 1px; background: var(--lavender); }
  .choice-heading { display: flex; align-items: end; justify-content: space-between; gap: 28px; margin-top: 14px; }
  .eyebrow { margin: 0 0 8px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .57rem; letter-spacing: .08em; text-transform: uppercase; }
  h1, h2, p { margin: 0; }
  h1 { max-width: 620px; font-size: clamp(2.3rem, 6vw, 5rem); letter-spacing: -.08em; line-height: .94; }
  .choice-intro { max-width: 590px; margin-top: 16px; color: var(--muted); font-size: .82rem; line-height: 1.7; }
  .choice-intro strong { color: var(--ink); }
  .choice-index { display: grid; gap: 4px; min-width: 92px; padding-bottom: 3px; color: var(--muted-deep); font-family: 'DM Mono', monospace; text-align: right; }
  .choice-index span { color: var(--lavender); font-size: 1.7rem; letter-spacing: -.08em; }
  .choice-index small { font-size: .52rem; letter-spacing: .08em; line-height: 1.35; }
  .mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; max-width: 900px; margin-top: 46px; }
  .mode-card { display: grid; gap: 24px; min-height: 260px; padding: 23px; border: 1px solid var(--line); border-radius: 16px; color: var(--ink); text-align: left; cursor: pointer; transition: transform .18s var(--ease-out, cubic-bezier(.23,1,.32,1)), border-color .18s ease, background .18s ease; }
  .mode-card:hover { transform: translateY(-4px); }
  .mode-card:active { transform: scale(.985); }
  .mode-card.stable { background: linear-gradient(145deg, rgba(255,255,255,.075), rgba(255,255,255,.025)); }
  .mode-card.experimental { border-color: rgba(194,181,255,.28); background: linear-gradient(145deg, rgba(155,135,245,.16), rgba(255,255,255,.025)); }
  .mode-card.stable:hover { border-color: rgba(255,255,255,.3); }
  .mode-card.experimental:hover { border-color: rgba(194,181,255,.62); }
  .mode-card-top, .mode-features, .mode-action { display: flex; align-items: center; }
  .mode-card-top { justify-content: space-between; }
  .mode-icon { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid currentColor; border-radius: 50%; color: var(--lavender); }
  .mode-tag { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .55rem; letter-spacing: .12em; text-transform: uppercase; }
  .mode-copy { align-self: center; }
  .mode-copy h2 { font-size: 1.55rem; letter-spacing: -.06em; }
  .mode-copy p { max-width: 340px; margin-top: 9px; color: var(--muted); font-size: .74rem; line-height: 1.65; }
  .mode-features { flex-wrap: wrap; gap: 12px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; }
  .mode-features span { display: inline-flex; align-items: center; gap: 5px; }
  .mode-action { justify-content: space-between; margin-top: auto; color: var(--ink); font-size: .68rem; font-weight: 800; }
  .mode-action :global(svg) { transform: rotate(180deg); color: var(--lavender); }
  .choice-footnote { margin-top: 22px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .55rem; }
  @media (max-width: 680px) { .choice-inner { width: min(100% - 32px, 520px); padding: 24px 0; } .choice-kicker { margin-top: 62px; } .choice-heading { align-items: start; } .choice-index { display: none; } .mode-grid { grid-template-columns: 1fr; gap: 10px; margin-top: 32px; } .mode-card { min-height: 0; gap: 18px; padding: 19px; } .mode-copy h2 { font-size: 1.35rem; } .choice-intro { font-size: .75rem; } }
  @media (prefers-reduced-motion: reduce) { .mode-card { transition: none; } .mode-card:hover { transform: none; } }
</style>
