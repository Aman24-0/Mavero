# Peachify unwanted external redirect — investigation record

Date: 2026-09-10 · Scope: `Third-Party Streaming Provider Playback Ad Protection` · Bug target: Peachify embed opening an external browser (Google Search → "unusual traffic" / reCAPTCHA) during playback.

## Observed real-world behavior (Android device, screenshot evidence)

```
Peachify Embed → video plays correctly → after some time / provider interaction
→ external browser / custom tab opens → Google Search
→ Google "unusual traffic" / reCAPTCHA page
```

## Investigation constraints

- `peachify.top` is behind Cloudflare and hard-blocks this investigation environment's datacenter IP ("Sorry, you have been blocked", Ray-ID page) for both headless and headful Chromium. Live loading of the real embed from this environment was therefore not possible.
- To avoid guesswork, the investigation instead **reproduced the provider's navigation behavior mechanically**: a cross-origin stand-in document (emulator) attempted every plausible unwanted-navigation mechanism from inside an iframe carrying **exactly** the runtime attributes Mavero emits (`PlayerViewport.svelte`): `sandbox="allow-forms allow-presentation allow-same-origin allow-scripts"`, `allow="autoplay; fullscreen; picture-in-picture; encrypted-media"`, `referrerpolicy="no-referrer"`, `allowfullscreen`, under **real user activation** (trusted pointer click). Real Chromium (agent-browser CLI) observed the results (tabs, top-document URL, event timeline, console).

## Runtime evidence

| Mechanism attempted from inside the embed frame | Sandbox ON (Mavero `required` attrs) | Sandbox OFF (shield-off / `unrestricted`) |
|---|---|---|
| `window.open('https://www.google.com/search?q=…')` | **BLOCKED** — returns `null`, no tab | **OPENS a real tab → Google Search → `google.com/sorry/` (unusual-traffic reCAPTCHA)** |
| `<a target="_blank">` click | **BLOCKED** — no tab | **OPENS a real tab → Google Search → `google.com/sorry/`** |
| Delayed popunder (`window.open` 3 s after click) | **BLOCKED** — returns `null` | **OPENS a real tab → Google Search → `google.com/sorry/`** |
| `<a target="_top">` click | **BLOCKED** — top document stays | Top document itself navigates to `google.com/sorry/` (Mavero page replaced) |
| `window.top.location.href = …` | **BLOCKED** — `SecurityError` ("does not have permission to navigate the target frame") | (would replace the top document) |
| `<form target="_top">` submit | **BLOCKED** — top document stays | (would replace the top document) |
| Service worker registered from the frame, then `clients.openWindow()` | Registration **succeeds** (`allow-same-origin`), but `openWindow` → **`InvalidAccessError: Not allowed to open a window`** | Also **rejected** (`Not allowed to open a window` — no user-activation context) |
| `location.href = 'intent://…'` (external protocol) | In-frame navigation only — never leaves the tab | In-frame navigation only |
| Top-level Mavero document | **Stays intact the whole session** | Stays intact in popup mode (popups are separate targets) |

The unsandboxed popup run reproduced the user's screenshot chain end-to-end: three separate tabs, each landing on Google Search and then Google's own `/sorry/` "unusual traffic" (reCAPTCHA) page — while the embedding page kept playing.

## Findings

1. **Mechanism: popunders.** The unwanted navigation is the popup family (`window.open`, `target="_blank"`, delayed popunders) opening a NEW browser window/custom tab that redirect-chains into Google Search. Top-level navigation was ruled out by signature (it replaces the Mavero page; the reported case kept playing). Service-worker `openWindow` was empirically closed in both sandbox states.
2. **Why `d1c2fb6` could not catch it:** the resolver-level policy evaluates the playback URL at RESOLVE time, before the iframe loads. The popunder is emitted by provider JavaScript AFTER the embed has loaded, inside a cross-origin document the server never sees. This is an architecture boundary, not a bug in that commit.
3. **Why the sandbox normally stops it:** the committed Peachify configuration (`supabase/migrations/20260821040000_phase7e_peachify_experimental.sql`) is `sandbox_policy: 'required'` at BOTH provider and source level. The resulting sandbox token set omits `allow-popups` and `allow-top-navigation*`, which blocks the entire popup family — verified at runtime above.
4. **Why the Android test escaped:** the embed must have been rendered WITHOUT the sandbox attribute at that moment. Exactly one in-app control could produce that state: the player's sandbox shield (`toggleSandbox()`), a one-tap silent disable available on every embed. (The alternative — the deployed database having Peachify's `sandbox_policy` edited to `unrestricted` — is an admin action, unverifiable remotely; the committed config says `required`.)

## Fix implemented (this commit)

**The in-player sandbox control is now HARDEN-ONLY** — it can strengthen protection but can never weaken the admin-configured policy:

- `src/lib/shared/sandbox-policy.ts` — new `playerCanDisableSandbox(policy)`: returns `true` ONLY for an explicit `unrestricted` admin policy (toggling then stays within the admin's own baseline); `required`/`optional`/unknown are locked.
- `src/lib/components/player/PlayerShell.svelte` — `toggleSandbox()` refuses to disable the sandbox for a locked policy; the shield button renders as a disabled "Sandbox enforced by the provider configuration" indicator for locked embeds, and keeps its previous toggle behavior only for `unrestricted` embeds.
- `PlayerViewport.svelte` — unchanged; it keeps applying the exact secure token set and the autoplay/fullscreen/PiP/EME permission, so play, pause, seek, fullscreen, progress, resume, subtitles, source switching and episode switching are unaffected.
- `scripts/peachify_redirect_protection_test.ts` (new, wired into the test chain) — 59 checks pinning the token set, the harden-only control, Peachify's locked-secure config, legitimate Peachify templates staying allowed with Ad Protection ON, scoped-rule isolation, sandbox independence, and the eight required scenarios.

Deliberately NOT done: no global ad blocker; no destination blacklist (Google is NOT blacklisted anywhere — the destination is evidence, not the cause); no anti-adblock interference; no sandbox forced onto `unrestricted` providers; no change to the Ad Protection architecture (`d1c2fb6`) or to `sandbox_policy` semantics; no coupling between Ad Protection and Sandbox.

## Remaining browser-security limitation (documented, by design)

- An admin who explicitly sets `sandbox_policy: 'unrestricted'` for a provider re-opens the popup channel; per the task specification the admin setting remains authoritative, so for such providers complete redirect protection is NOT claimed. The player may still harden (enable the sandbox) per session via the shield.
- A sandboxed frame CAN navigate itself (in-frame redirects to ad pages remain possible); they stay inside the iframe and cannot open the external browser while the attribute is present.
- Service-worker `clients.openWindow()` from a sandboxed-registered worker was rejected in the tested Chromium; behavior on other engines may differ and is not a controllable channel from a cross-origin parent.
