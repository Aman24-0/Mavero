<script lang="ts">
  let { exitCapability }: { exitCapability: string } = $props();
</script>

<header class="tv-header">
  <div class="brand-lockup" aria-label="Mavero TV">
    <span class="brand-mark">M</span>
    <span>
      <strong>Mavero</strong>
      <small>TV shell</small>
    </span>
  </div>

  <div class="runtime-badge" aria-live="polite">
    <span class="status-dot" aria-hidden="true"></span>
    {exitCapability}
  </div>
</header>

<style>
  .tv-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 34px 56px 18px; }
  .brand-lockup { display: flex; align-items: center; gap: 12px; }
  .brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 13px; color: #fff; background: var(--tv-accent); font-size: 1.35rem; font-weight: 900; box-shadow: 0 10px 28px rgba(255, 62, 94, .2); }
  .brand-lockup strong { display: block; font-size: 1.08rem; letter-spacing: -.03em; }
  .brand-lockup small { display: block; margin-top: 3px; color: var(--tv-muted); font-size: .62rem; letter-spacing: .13em; text-transform: uppercase; }
  .runtime-badge { display: flex; align-items: center; gap: 9px; color: var(--tv-muted); font-size: .68rem; letter-spacing: .05em; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #70d9a7; box-shadow: 0 0 0 5px rgba(112, 217, 167, .1); }

  @media (max-width: 760px) {
    .tv-header { align-items: flex-start; flex-direction: column; padding: 24px 22px 18px; }
  }
</style>
