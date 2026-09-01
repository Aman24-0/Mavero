# Phase 10.3 — Real Playback, TV Authentication, and 10-Foot Information Architecture

**Status:** **PHASE 10.3 QA FAILED — PHASE 10.3.1 HOTFIX IMPLEMENTED — OWNER SAMSUNG RETEST PENDING**

**Branch:** `feature/tizen-tv`

## Audit decision

Phase 10.3 reuses the existing Mavero provider registry, resolver, request-scoped Supabase session, progress writer, shared player types, and TV focus/navigation layer. It does not create a second provider system, source database, identity system, playback resolver, scraper, stream extractor, AVPlay integration, or player engine.

The live sanitized streaming configuration observed during the audit exposes Movie/Series embed sources, with VidLink also advertising Anime support. The enabled rows are experimental and return provider-owned HTTPS embeds; the live registry does not currently expose a direct HTML5 stream as the normal path. TV supports the existing server-validated embed flow and retains direct HTML5 handling whenever the resolver returns a direct source. Provider iframe playback remains cross-origin, so the parent shell cannot assert that provider-owned media has actually started or progressed.

The resolver contract is `POST /api/playback/resolve` with `{ sourceId, contentId, mediaType, season?, episode?, enableFallback? }`. TV reads `GET /api/streaming/config` only for sanitized source labels and capabilities, then sends the selected source through the existing server resolver. Private templates, provider credentials, and service-role access remain server-only.

## Completed implementation increments

| Increment | Result | Owner hardware status |
|---|---|---|
| 10.3A | TV loads public source options, filters them by Movie/Series/Anime capability, resolves the selected source through the existing endpoint, uses bounded fallback for the initial choice, and supports manual remote source switching with fallback disabled. Phase 10.3.1 additionally restores first-source focus and directional provider navigation. | Phase 10.3 failed; hotfix retest pending |
| 10.3B | TV direct HTML5 playback uses `createProgressWriter`, `getResumeProgress`, completion-at-90%-through-existing-service behavior, authenticated Watching promotion/history, and episode context. Continue Watching remains the Phase 10.2 actual-progress-only read model. Embed playback is intentionally not described as observable media progress. Phase 10.3.1 removes dummy HTML5 controls from embed rendering. | Phase 10.3 failed; hotfix retest pending |
| 10.3C | TV Settings now provides remote-focusable email/password sign-in and TV logout through server-side Supabase actions. The normal session bootstrap and auth primitives are reused; no password or session token is stored in TV UI code. | Pending |
| 10.3D | **Architecture gated, not implemented.** QR phone pairing is not safely supported by the current same-origin cookie architecture because a phone and TV would share the normal Supabase cookie scope. No pairing table, token exchange, raw credential transfer, or speculative migration was added. Manual TV sign-in is the secure available path. | N/A |
| 10.3E | TV-only player loading, source-choice, provider-error, retry, embed-boundary, Settings/account, and 10-foot focus states were refined without redesigning normal Web/PWA routes. Phase 10.3.1 removes duplicate embed overlays, bounds the source picker, and restores player focus routing. | Phase 10.3 failed; hotfix retest pending |

## Secure pairing gate

A future QR pairing implementation may proceed only after device-separated session isolation is designed and reviewed. The minimum acceptable design remains a short-lived, single-use, intended-session-bound opaque code whose digest is stored server-side; direct table access is denied by RLS; phone approval requires the existing authenticated session; and a one-time server-side exchange creates the TV session without moving an access token, refresh token, password, cookie, or service-role credential through QR, browser storage, or public JSON.

The current hooks bootstrap a single normal cookie namespace at `/`, and the existing sign-out operation acts on that same session. Because this repository does not yet have a proven TV-specific cookie namespace or a documented device-bound exchange, implementing QR pairing now would risk logging out the phone or transferring credentials across devices. The correct Phase 10.3 outcome is therefore to document the gate rather than add an unsafe schema or endpoint.

## Safety and non-goals

This phase does not change `main`, production, provider/source registry rows, provider adapters, resolver adapters, TMDB/AniList adapters, PWA behavior, or normal Web/PWA information architecture. It does not scrape providers, extract direct streams, bypass iframe security, call undocumented Samsung APIs, add AVPlay, copy third-party assets, or claim provider video playback before owner hardware verification. The owner reported Phase 10.3 Samsung QA failures in provider navigation, first-source activation, playback/embed mounting, dummy controls, layout overlap, and hosted Exit. Phase 10.3.1 addresses those regressions only; the revised owner retest remains the authority for real provider behavior, embed compatibility, remote source selection, direct playback, progress, auth, hosted Exit, and long-session stability.

## Required owner Samsung checklist

The owner should verify on Samsung `UA43AUE60AKLXL`, Tizen `6.0`, TizenBrew `2.0.5`: Movie source loading and provider selection; Series detail → season/episode → Player; Anime source capability behavior; direct versus embed rendering where returned; provider failure and Retry; actual direct playback progress and resume; Continue Watching after non-zero playback and after completion; Settings email/password login; TV logout; remote focus across sidebar, source picker, controls, and Back; hosted Exit behavior; and at least a 30-minute repeated-navigation/playback session. Embed media must be marked **provider/Tizen dependent** unless the owner observes successful provider playback on hardware.

## References

[1]: https://supabase.com/docs/reference/javascript/auth-admin-generatelink — Supabase JavaScript reference: `auth.admin.generateLink`.
[2]: https://supabase.com/docs/reference/javascript/auth-verifyotp — Supabase JavaScript reference: `auth.verifyOtp`.
