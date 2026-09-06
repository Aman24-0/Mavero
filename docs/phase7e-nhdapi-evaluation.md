# MAVERO Phase 7E — NHDAPI Evaluation

**Status:** Evaluation complete; implementation not started.

**Scope:** NHDAPI only. This evaluation preserves Vidsrc, VidLink, Peachify, RiveStream, and Nxsha, and does not begin Phase 7F or implement downloads.

## Executive conclusion

NHDAPI’s currently documented integration is a deterministic **iframe embed**, not a documented JSON source-resolution API. The official documentation publishes movie, TV-episode, and AniList anime embed paths. It also describes internal HLS playback, automatic source failover, language switching, subtitles, resume, and next-episode behavior, but it does not publish a JSON endpoint and response schema that MAVERO could safely normalize into direct media `SourceResult` records. [1] [2]

Therefore, the proposed first integration is a **generic template adapter** using `integration_type = 'template'` and a normalized `SourceResult` of `type = 'embed'`. A dedicated API adapter is not justified by the current official contract. NHDAPI’s own server selection, subtitle handling, audio-language switching, and failover remain inside its iframe, while MAVERO continues to control source switching among MAVERO sources, navigation, retry, sandbox policy, and the existing PlayerShell.

## Verified official contract

| Capability | NHDAPI result | MAVERO decision |
|---|---|---|
| Movie | Documented iframe/direct page: `https://nhdapi.com/movie/{tmdbId or imdbId}`. | Implement as a movie template with the existing generic template adapter. |
| TV | Documented iframe/direct page: `https://nhdapi.com/tv/{tmdbId or imdbId}/{season}/{episode}`. | Implement as a series template with `{season}` and `{episode}`. |
| Episode | TV episode path is explicitly documented and tested as season plus episode. | Support TV episodes only in the initial source. |
| Anime | Documented as `https://nhdapi.com/anime/{aniListId}/{episode}`. | Keep `capabilities.anime = false` initially because anime uses a separate AniList identifier path and is outside the requested initial TMDB movie/TV source scope. |
| TMDB | Numeric TMDB IDs are documented for movie and TV. | Use `identifier_mode = 'tmdb_id'` for the initial MAVERO source. |
| IMDb | IMDb IDs beginning with `tt` are documented for movie and TV. | Do not add a second identifier mode unless later approved; the initial source remains TMDB-first. |
| AniList | AniList IDs are documented for the separate anime endpoint. | Documented but not enabled in the first implementation. |
| API key | The docs state that a free key is required for the JSON API, while an embed works without a key; a key on an embed is described as optional and associated with an ad-free plan. | Do not add an API key to the browser-visible embed URL. No NHDAPI secret is required for the initial free embed integration. Any future key-backed API or ad-free flow requires separate security review. |
| Embed | Explicit iframe examples are the primary documented integration. | Use `result_type = 'embed'`, exact allowed origin `https://nhdapi.com`, and the existing iframe PlayerViewport. |
| HLS | The homepage describes a ready-to-play HLS stream, but the docs expose it as an internal player capability rather than a public JSON/media URL contract. | Do not treat NHDAPI as direct HLS for this phase. Do not add an HLS player dependency. |
| DASH | No documented public DASH response endpoint or schema was found. | Not implemented. |
| MP4 | No documented public MP4 response endpoint or schema was found. | Not implemented. |
| Multiple sources | NHDAPI documents automatic failover and an internal server switcher inside the embed. | Treat NHDAPI as one MAVERO source; preserve NHDAPI’s internal server selection inside its player. |
| Subtitles | NHDAPI documents an internal CC menu and a separate subtitles endpoint, but the initial integration will use the full embed rather than proxy subtitle data. | Keep subtitle capability metadata descriptive; do not add cross-origin subtitle extraction or a subtitle proxy. |
| Languages | The player documents multi-language audio switching inside the embed. | Preserve this as provider-internal functionality; do not redesign MAVERO’s PlayerShell. |
| Quality | The docs mention quality variants in the download section, but do not publish a normalized streaming-quality JSON contract for the embed integration. | Do not populate direct quality sources in `SourceResult`. |
| Download | Documented `/dl/movie/...` and `/dl/tv/...` pages exist. | Explicitly excluded from this phase. |
| Rate limits | The docs state that free-plan keys have a limited number of extractions per day and list HTTP 429 for daily/rate limits. | Since the initial source uses the public embed page without a key, do not build a key-based quota client. Surface normal iframe/provider failure through existing MAVERO error handling. |
| Errors | The docs list 401 invalid/missing key, 429 rate limit, 403 blocked title, and 500 extraction failure for API calls. | No API error normalization is needed for the template embed. Generic resolver validation and provider iframe failure handling remain authoritative. |
| Required headers | No special browser headers are documented for the embed. | Use the existing iframe `referrerpolicy="no-referrer"` and current sandbox/allow attributes. Do not add provider-specific headers. |
| CORS | The documented integration is an iframe page; no browser API CORS contract is needed. | Do not fetch NHDAPI from client code and do not add arbitrary proxying. |
| Attribution/usage | The official pages present NHD Embed as the provider product and do not publish a separate MAVERO attribution requirement in the accessible docs. | Keep the provider/source notes explicit and do not remove provider UI or security controls. |

## Adapter decision

**Generic template adapter.** The documented movie and TV URLs are deterministic and resolve to provider-hosted embed pages. The current MAVERO `templateProviderAdapter` already expands `{tmdb_id}`, `{season}`, and `{episode}`, validates HTTPS playback URLs, checks the exact allowed embed origin, and returns a normalized embed result. A dedicated NHDAPI adapter would incorrectly imply a documented runtime JSON source API that is not present in the official reference.

## Exact request and response flow

```text
MAVERO content detail with TMDB ID
        |
        v
POST /api/playback/resolve
        |
        v
Trusted Supabase provider/source registry
        |
        v
Existing resolver core + generic template adapter
        |
        v
https://nhdapi.com/movie/{tmdb_id}
https://nhdapi.com/tv/{tmdb_id}/{season}/{episode}
        |
        v
SourceResult { type: 'embed', url, providerId, sourceId, mediaType,
               sandboxPolicy, provider/source metadata }
        |
        v
Existing PlayerShell + PlayerViewport iframe
        |
        v
NHDAPI-owned player controls: server failover, audio, subtitles,
resume, next episode, and provider-internal playback behavior
```

The NHDAPI URL will not contain a private key in the initial implementation. The provider’s documented `?key=` mechanism is not needed for the free embed path, and the attached specification prohibits exposing private credentials in browser-visible URLs.

## Proposed database configuration

The migration should follow the existing idempotent Phase 7E `DO $$` seed pattern and use ordering **130**. It should create:

| Field | Proposed value |
|---|---|
| Provider name | NHDAPI |
| Provider slug | `nhdapi` |
| Provider status | `experimental` |
| Provider enabled | `false` |
| Provider integration type | `template` |
| Source slug | `nhdapi-source` |
| Source status | `experimental` |
| Source enabled | `false` |
| Source integration type | `template` |
| Identifier mode | `tmdb_id` |
| Result type | `embed` |
| Movie template | `https://nhdapi.com/movie/{tmdb_id}` |
| Series template | `https://nhdapi.com/tv/{tmdb_id}/{season}/{episode}` |
| Anime capability | `false` initially |
| Allowed embed origin | Exact `https://nhdapi.com` |
| Sandbox policy | `required` under MAVERO’s existing external-embed policy |
| Ordering | `130` |
| Experimental playback gate | `true` in capabilities, while provider/source remain disabled by default |

The migration will not add public key fields, download templates, arbitrary proxy settings, or a new database table.

## Environment variables

**None are required for the proposed initial embed integration.** The public NHDAPI embed paths work without an API key according to the official docs. If a future approved change requires NHDAPI’s JSON API or an ad-free key-backed embed, it must use a server-only variable such as `PRIVATE_NHDAPI_KEY`, must never be returned to the browser, and must be reviewed separately because the official reference currently does not publish the JSON response schema needed for normalization.

## MAVERO mapping and compatibility

The source maps directly to existing provider/source fields exposed by the Admin Providers and Admin Sources interfaces. The existing resolver gatekeeping will enforce enabled state, experimental playback permission, media capabilities, source visibility, and identifier requirements. `safe-url.ts` will enforce HTTPS and the exact `https://nhdapi.com` embed origin. `PlayerViewport.svelte` already renders external embed URLs with fullscreen support and the existing session-level sandbox toggle. No provider-specific player, cross-origin DOM access, redirect bypass, ad removal, DRM/CAPTCHA bypass, or download path is proposed.

NHDAPI’s internal server selector should remain internal to NHDAPI. It should not become ten separate MAVERO providers or sources. MAVERO’s existing source drawer can still switch between Vidsrc, VidLink, Peachify, RiveStream, Nxsha, and NHDAPI when those records are temporarily enabled for verification.

## Proposed files after approval

| File | Purpose |
|---|---|
| `supabase/migrations/20260821070000_phase7e_nhdapi_experimental.sql` | Idempotent experimental provider/source seed, disabled by default. |
| `scripts/phase7e_nhdapi_test.ts` | Resolver-level deterministic movie/TV template, identifier, origin, capability, sandbox, and lifecycle tests. |
| `package.json` | Add the NHDAPI test to the existing Phase 7E regression chain. |
| `docs/phase7e-nhdapi-evaluation.md` | This evaluation and implementation record. |

No resolver architecture file should need modification unless tests expose an existing generic adapter limitation. No API route or private-secret file is proposed for the initial embed-only implementation.

## Testing plan after approval

Automated tests will cover the movie template, TV season/episode template, TMDB identifier resolution, anime rejection, missing identifiers, exact-origin enforcement, disabled provider/source gates, experimental playback gates, and sandbox precedence. The complete existing chain will continue to run Vidsrc, VidLink, Peachify, RiveStream, Nxsha, remediation, and NHDAPI tests.

After local checks pass, the migration will be applied to the existing MAVERO Supabase project, the code will be committed and pushed to `main`, and the existing Netlify site will be deployed. NHDAPI will be temporarily enabled only for verification, then provider and source flags will be restored to `false`.

Browser verification will cover a movie embed, a TV episode embed, Vidsrc-to-NHDAPI and NHDAPI-to-Vidsrc source switching, Previous/Next server navigation, Retry, loading and provider-error states, sandbox on/off behavior, fullscreen/landscape, and a 390×844 mobile viewport. The verification must not attempt to remove provider ads, circumvent redirects, extract hidden media, or manipulate the cross-origin iframe DOM.

## Approval gate

The attached specification requires evaluation before implementation. **No NHDAPI code or migration has been started.** Explicit approval is required before Phase 7E implementation begins.

## References

[1]: https://nhdapi.com/ "NHDAPI official homepage"
[2]: https://nhdapi.com/docs "NHDAPI official developer documentation"
