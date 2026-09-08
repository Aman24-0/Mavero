<script lang="ts">
  // ============================================================
  // PHASE A PLACEHOLDER — navigation architecture only.
  //
  // This route exists so the new primary-nav "Account" destination
  // (fifth entry in the shared primaryLinks source in AppShell)
  // resolves to a real page instead of a 404. It is INTENTIONALLY
  // minimal: Phase B of the Account/Profile/Settings redesign will
  // replace this placeholder with the full Account experience
  // (merging Profile and Settings into one destination).
  //
  // Do NOT add Profile or Settings functionality here yet.
  // /profile and /settings remain directly accessible until Phase C.
  // ============================================================
  import { UserRound } from 'lucide-svelte';
</script>

<svelte:head>
  <title>Account — Mavero</title>
  <meta name="description" content="Your MAVERO account hub." />
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="account-placeholder" aria-labelledby="account-heading">
  <span class="placeholder-mark" aria-hidden="true"><UserRound size={22} strokeWidth={1.9} /></span>
  <p class="placeholder-eyebrow">MAVERO / Account</p>
  <h1 id="account-heading">Account</h1>
  <p class="placeholder-copy">
    Your account hub is on the way. Profile and settings will live here in an
    upcoming release — in the meantime, everything still works from their
    current pages.
  </p>
</section>

<style>
  .account-placeholder {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; min-height: 62vh; padding: 48px 20px 96px; text-align: center;
  }
  .placeholder-mark {
    display: grid; place-items: center; width: 52px; height: 52px;
    border: 1px solid var(--line); border-radius: 16px;
    color: var(--muted); background: rgba(255, 255, 255, .04);
  }
  .placeholder-eyebrow {
    margin: 6px 0 0; color: var(--muted-deep);
    font-size: .68rem; font-weight: 700; letter-spacing: .14em;
  }
  h1 { margin: 0; color: var(--ink); font-size: 1.6rem; font-weight: 900; letter-spacing: .01em; }
  .placeholder-copy {
    max-width: 40ch; margin: 0; color: var(--muted);
    font-size: .86rem; font-weight: 500; line-height: 1.6;
  }
</style>
