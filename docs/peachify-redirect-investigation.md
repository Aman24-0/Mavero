# Peachify unwanted external redirect — investigation record

Date: 2026-09-10 (updated after real-device playback testing) · Scope: `Third-Party Streaming Provider Playback Ad Protection` · Bug target: Peachify embed opening an external browser (Google Search → "unusual traffic" / reCAPTCHA) during playback.

## Observed real-world behavior (Android device, screenshot evidence)

```
Peachify Embed → video plays correctly → after some time / provider interaction
→ external browser / custom tab opens → Google Search
→ Google "unusual traffic" / reCAPTCHA page
```

## NEW: real-device playback testing (sandbox vs. playback)

Real Chromium/Android testing of the committed configuration established a
second, decisive fact that reshapes the architecture:

| Sandbox state | Peachify behavior |
|---|---|
| Sandbox attribute present (`sandbox_policy: 'required'`, the previously committed config) | Peachify's player **detects the sandboxed frame** and refuses to start: **"Sandbox Detected — Please disable iframe sandboxing permissions to access this player."** Playback is impossible. |
| Sandbox attribute absent (`sandbox_policy: 'unrestricted'`) | Peachify plays normally — and may open popunders (the original bug). |

Consequences:

1. The committed `sandbox_policy: 'required'` configuration makes Peachify **permanently unplayable** (the in-player sandbox control is harden-only and cannot weaken it either).
2. The only playable state for Peachify is an **unsandboxed** frame, so the sandbox cannot be the redirect defense for this provider.
3. Therefore `sandbox_policy` and `playback_ad_protection` must be — and are — **two completely independent settings**, and `sandbox_policy: 'unrestricted'` + `playback_ad_protection: true` is a first-class configuration. This is now Peachify's committed configuration (migration `20260916000000_peachify_unrestricted_playback.sql`).

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
3. **Why the sandbox normally stops it:** the sandbox token set omits `allow-popups` and `allow-top-navigation*`, which blocks the entire popup family — verified at runtime above. **But Peachify refuses to play under the sandbox** ("Sandbox Detected" screen), so for this provider the sandbox cannot be used as the redirect defense at all.
4. **Correction of the earlier hypothesis** (that the Android escape route was the player's one-tap shield): with the committed `required` configuration the shield is harden-only and could not have disabled the sandbox. The real explanation is the newly confirmed provider behavior: Peachify only ever plays in an unsandboxed frame — the device that captured the redirect was simply playing Peachify the only way Peachify allows.

## Architecture implemented (final)

**Sandbox Policy and Ad Protection are two independent settings resolving through the same hierarchy — source override → provider default → system default:**

- `sandbox_policy: 'required' | 'optional' | 'unrestricted'` — resolves via `sandboxPolicyFromCapabilities` (source value overrides the provider default; secure system default `'required'`).
- `playback_ad_protection: true | false` (+ optional `playback_ad_protection_rules`) — resolves via `playbackAdProtectionFromCapabilities` (source override → provider default → system default OFF).
- **Neither setting ever forces the other**: enabling Ad Protection does NOT re-add a sandbox; an unrestricted sandbox does NOT toggle Ad Protection. Admin provider/source UI keeps two separate controls (Sandbox Policy select + Ad Protection checkbox); the player shield is a sandbox-state control only, never an Ad Protection control.
- Peachify's committed configuration is now `sandbox_policy: 'unrestricted'` + `playback_ad_protection: true` at BOTH provider and source level (migration `20260916000000`): the iframe renders without a sandbox attribute (no "Sandbox Detected" screen, playback works), while the resolver still classifies every candidate playback URL for this provider/source only.
- The in-player sandbox control remains HARDEN-ONLY (`playerCanDisableSandbox`): `required`/`optional` embeds are locked ON for the session; only an explicitly `unrestricted` admin policy keeps the toggle available (within the admin's own baseline). The player simply renders the RESOLVED policy; it never silently re-enables the sandbox.

**What Ad Protection actually enforces with the sandbox OFF (technically valid, application/resolver level):**

- **A. Resolver returns an ad/redirect playback URL before iframe creation** → BLOCKED. `evaluatePlaybackUrl` runs after `validatePlaybackUrl` for every candidate (ad-domain / redirect / unsafe-navigation categories + provider-scoped rules from `playback_ad_protection_rules`), rejecting with `PLAYBACK_POLICY_BLOCKED` so fallback, default-source ordering, health ranking and manual switching continue with the next candidate — each evaluated with its OWN effective setting.
- **B. Mavero itself navigating/popup to a blocked destination** → not applicable by construction: Mavero never opens provider popups and never navigates its top level to provider URLs (embeds render inside the player iframe only).

**What CANNOT be blocked (browser security boundary — documented, never faked):**

- **C. Cross-origin provider iframe internally executing `window.open(...)` / `location=...` / `target="_blank"` / delayed popunders / dynamically generated redirects.** Without the sandbox attribute, the parent page has NO mechanism to intercept, inspect, or veto navigations and window openings initiated by a cross-origin document (same-origin policy; no cross-origin JS injection, no fetch/XHR monkey-patching, no service-worker interception of third-party iframe traffic — all forbidden anti-adblock-adjacent techniques). For an `unrestricted` provider this channel is OPEN and complete redirect protection is explicitly NOT claimed.
- **D. Advertisements rendered inside the provider's own iframe/player.** No application-level mechanism exists to distinguish and block them without the (refused) sandbox or forbidden injection; not claimed.

## Fix history

- `e17402c` — resolver-level playback policy layer (global scope at the time).
- `d1c2fb6` — Ad Protection scoped per provider/source (source override → provider default → system default OFF), admin UI/API, per-candidate evaluation.
- `e4ba560` — harden-only in-player sandbox control (required/optional locked; unrestricted keeps the toggle), after the runtime mechanism verification above.
- Current commit — **decoupling correction**: Peachify committed config → `unrestricted` + `playback_ad_protection: true` (migration); `sandbox_policy` resolution unified to the source-override hierarchy (source override → provider default → system default) matching `playback_ad_protection`, so a source override can independently override either setting; docs + tests updated (93-check independence matrix incl. fallback preservation of BOTH settings).

Deliberately NOT done: no global ad blocker; no destination blacklist (Google is NOT blacklisted anywhere — the destination is evidence, not the cause); no anti-adblock interference; no sandbox forced onto `unrestricted` providers; no Ad Protection dependency on the sandbox in either direction; no change to MaveroAds independence.

## Remaining browser-security limitation (documented, by design)

- For Peachify (`unrestricted` + protection ON), resolver-level classification is the enforceable protection. Popunders opened by the provider document itself land in a NEW browser target the app cannot intercept — the limitation the original Android screenshot demonstrated. Complete redirect protection for such providers would require the sandbox, which Peachify refuses; the tradeoff is an explicit admin decision encoded in the committed configuration.
- A sandboxed frame CAN navigate itself (in-frame redirects to ad pages remain possible); they stay inside the iframe and cannot open the external browser while the attribute is present.
- Service-worker `clients.openWindow()` from a sandboxed-registered worker was rejected in the tested Chromium; behavior on other engines may differ and is not a controllable channel from a cross-origin parent.
