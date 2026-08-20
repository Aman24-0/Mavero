# MAVERO Phase 7D Provider-Selection Gate Report

**Status:** Provider integration blocked at the verification gate; no unverified provider code was implemented.

**Selected candidate for evaluation:** Vidsrc, based on the user’s explicit request.

**Scope respected:** One candidate only. No second provider, no provider fallback, no Phase 7E work, no player architecture changes, no ad/redirect bypass, no hidden media extraction, and no cross-origin player manipulation.

## Executive decision

Vidsrc was not approved for implementation because current verification did not establish a legitimate authorization basis for MAVERO to redistribute or embed its movie and episode catalog. The candidate’s public pages make self-described embed/API claims, but the checked material did not provide verifiable licensing, authorization terms for third-party applications, a formal API contract, or a documented permission model for the requested catalog.

Under the Phase 7D specification, an unverified provider must remain unintegrated or disabled/experimental and the provider-specific implementation must stop. MAVERO therefore remains on the existing provider-agnostic Phase 7B/7C architecture.

## 1. Candidate and requested behavior

The candidate was the Vidsrc service represented by the user-provided URLs:

```text
https://vidsrc.wiki/embed/movie/533535
https://vidsrc.wiki/embed/tv/79744/1/1
```

The requested product behavior was an iframe-based movie/series provider with source selection, mobile landscape behavior, and removal of provider-controlled advertisements and redirects. The last request cannot be implemented: removing provider ads, redirecting behavior, popups, or cross-origin player controls would require bypassing provider-controlled behavior and is outside the safe MAVERO integration boundary.

## 2. Current web verification

The following public sources were checked read-only:

| Source | Result | Decision relevance |
|---|---|---|
| [Vidsrc domain directory][1] | Self-described official-domain page claiming embed/API availability and listing changing domains | Does not establish licensing or authorization for MAVERO |
| `https://vidsrc.wiki/` | HTTP 200; WordPress-backed public site response | Does not establish playback rights or integration authorization |
| `https://vidsrc.wiki/embed/movie/533535` | HTTP 301 slash-normalization redirect | Shows URL reachability only; no API contract or rights evidence |
| `https://vidsrc.wiki/embed/tv/79744/1/1` | HTTP 301 slash-normalization redirect | Shows URL reachability only; no series/episode contract or rights evidence |
| `https://vidsrc.wiki/robots.txt` | HTTP 200 | Does not establish authorization |
| `https://vidsrc.wiki/terms` | HTTP 404 | No conventional public terms page was available at the checked path |

No media URL, hidden API, player-internal request, redirect destination, or protected content was extracted. No scraping or anti-bot circumvention was performed.

## 3. Authorization and legitimate-use assessment

The domain directory claims that Vidsrc provides streaming links and embeds, but a self-description is not sufficient evidence that the underlying movie and episode catalog is licensed for third-party redistribution or that MAVERO is authorized to use it. The checked domain directory also did not list the user-provided `vidsrc.wiki` host among its displayed active domains at verification time.

Because the authorization basis is unverified, MAVERO cannot safely ship a live Vidsrc adapter. The correct outcome is to keep the candidate disabled and document the blocker rather than call the provider a legitimate production source.

## 4. Integration type decision

No provider integration type was activated. If a future authorized review approves Vidsrc, the only technically acceptable shape for this candidate would be an `embed` result, never a direct media result. The Phase 7C PlayerShell would remain provider-agnostic and would receive only a validated server-generated `SourceResult`.

The future safe flow would be:

```text
Watch page
  → sourceId only
  → server-side adapter
  → validated embed SourceResult
  → existing PlayerShell iframe guard
```

The browser would not construct provider URLs from arbitrary input. Provider-controlled advertisements and redirects would remain provider-controlled; no “remove ads” or bypass button would be added.

## 5. Capability and identifier status

Movie, series, and episode support were not approved because the candidate’s legitimate integration contract could not be established. The provided URL shapes suggest movie and TV/episode path patterns, but URL shape is not proof of documented API behavior, stable response format, authorization, or playback rights.

No TMDB, IMDb, AniList, or MAL identifier mapping was implemented. No unnecessary metadata request was added.

Anime support remains false for this candidate until a separately verified, authorized capability is established.

## 6. Credentials and environment variables

No Vidsrc credentials were requested, added, or stored. No new environment variable was introduced. Existing MAVERO secrets remain server-side only.

## 7. Resolver, database, and Admin impact

No provider or source rows were inserted or modified. No public source was added to the Phase 7A mirror tables. No adapter was registered in the Phase 7B resolver. Existing Admin enable/disable, maintenance, visibility, ordering, and category controls remain unchanged.

This preserves the rule that activation must be database-controlled and that no frontend deployment is required to disable a source once an authorized source exists.

## 8. Security boundary

The following unsafe operations were not performed and were not implemented:

- Provider ad or redirect removal.
- Hidden media URL extraction.
- Cross-origin DOM inspection or manipulation.
- DRM, authentication, paywall, access-control, or anti-bot circumvention.
- Browser-supplied arbitrary provider URL resolution.
- Provider iframe permission escalation.

The Phase 7C iframe guard remains the only approved embed path: HTTPS validation, controlled sandbox permissions, limited fullscreen/presentation permissions, safe user-facing errors, and explicit source switching.

## 9. Timeouts, validation, caching, and errors

No provider adapter was shipped, so no Vidsrc request, timeout policy, response parser, cache, or provider-specific error mapping was added. The existing Phase 7B resolver timeout/error/security model remains unchanged.

If an authorized provider is selected in a future attempt, the adapter must validate response shape, media type, source identity, expiry, and embed origin before returning a `SourceResult`. Temporary playback URLs must not be persisted as permanent source configuration.

## 10. Live verification result

The controlled live verification established only public URL reachability and redirect behavior. It did not establish legitimate playback authorization or a documented provider API contract. The result is therefore **verification failed for production integration**, not successful provider playback.

No aggressive polling was used. No player stream was downloaded or extracted.

## 11. Tests and QA

No provider-specific tests were added because the provider did not pass the selection gate. Existing MAVERO Phase 7C player tests, resolver tests, build, and browser QA remain valid because the player and resolver architecture were not modified during this gate.

The Phase 7D research artifact is:

```text
PHASE_7D_PROVIDER_RESEARCH_NOTES.md
```

## 12. Files changed

Only provider-selection documentation was added:

- `PHASE_7D_PROVIDER_RESEARCH_NOTES.md`
- `MAVERO_PHASE_7D_REPORT.md`

No application source, database migration, provider adapter, dependency, environment variable, PlayerShell, or Admin behavior was changed.

## 13. Recommended next candidate

The strongest safer candidates are **Internet Archive**, for openly licensed public-domain or Creative Commons items with item-level rights and documented public media files, or **YouTube**, for official authorized iframe embeds where the content owner permits embedding. Neither candidate is integrated in this Phase 7D gate.

Internet Archive was passively verified as having an openly licensed `Sintel` item with public MP4 derivatives, but this does not automatically map to MAVERO’s TMDB catalog and would require item-level rights/content mapping before implementation. YouTube’s official IFrame Player API documents an authorized embed model, but it is not a general full-length movie/series provider and would require a narrowly defined content capability.

## Final boundary

Phase 7D stops at the provider-selection gate. No Vidsrc adapter was implemented, no provider was activated, and no Phase 7E work started. MAVERO waits for a future explicit approval of a provider with verifiable authorization and documented integration terms.

## References

[1]: https://vidsrc.domains/ "VidSrc official-domain page checked during provider verification"
[2]: https://archive.org/developers/metadata.html "Internet Archive Item Metadata API documentation"
[3]: https://archive.org/developers/items.html "Internet Archive Items documentation"
[4]: https://developers.google.com/youtube/iframe_api_reference "YouTube IFrame Player API reference"
[5]: https://developer.themoviedb.org/reference/movie-watch-providers "TMDB movie watch-provider metadata reference"
