# MAVERO Phase 7E — Fresh Bingr Evaluation

**Decision:** Stop at evaluation. Do not implement Bingr in the current provider phase.

## Current service verification

The current canonical Bingr site is [https://bingr.one/](https://bingr.one/). Its HTML identifies the application as Bingr and publishes `https://api.bingr.one/api` as the current API base. The current application routes include `/watch/:type/:id`, `/watch/:type/:id/:ep`, and `/watch/:type/:id/:season/:ep`; therefore the current movie and TV application routes are:

| Capability | Freshly verified current route or behavior |
|---|---|
| Current domain | `https://bingr.one` |
| Movie application route | `https://bingr.one/watch/movie/550` |
| TV episode application route | `https://bingr.one/watch/tv/1399/1/1` according to the current route definition; the app also defines a shorter episode route variant. |
| Movie details API | `GET https://api.bingr.one/api/details/movie/550` returned HTTP 200. |
| TV details API | `GET https://api.bingr.one/api/details/tv/1399` returned HTTP 200. |
| TV episode API | `GET https://api.bingr.one/api/episodes/1399/1` returned HTTP 200 with season and episode metadata. |
| Stream API | The current Watch bundle calls `POST https://api.bingr.one/api/stream` with JSON `{ srv, t, id, query }`, where `query` may include title, year, season, and episode. |
| Returned stream model | The current client expects JSON with `sources`, `subtitles`, and source URLs, then assigns the first source URL to its own player. |
| Current player | The current app includes a direct-media player with native video handling and dash.js logic for `.mpd` streams; it is not simply a static third-party iframe template. |

## Movie and TV playback verification status

The live Bingr movie route opened to the Bingr application loading state in the browser, but the browser session subsequently became unavailable/blank during the loading transition. The public details and episode APIs are reachable. The current stream endpoint rejected a guessed server identifier (`filmu`) with HTTP 404 `{"error":"unknown server"}`. The current client bundle contains several provider display/build definitions and additional internal server values, but the accepted runtime `srv` contract was not published as a stable public API reference and could not be reliably established from the current live service without guessing.

Accordingly, **actual Bingr movie and TV playback is not verified**. No claim of working playback is made.

## Adapter decision

The existing generic template adapter is **not suitable** for Bingr. Bingr is currently an API-backed application that resolves a server request into direct media sources and subtitles, then runs its own player. Its current Watch bundle includes runtime API calls, source selection, subtitles, HLS/MP4 handling, and dash.js support for DASH manifests. The deterministic route `/watch/movie/{id}` is a full Bingr application route, not a verified provider embed contract intended to be embedded into MAVERO.

A dedicated Bingr adapter would be required to call Bingr’s API server-side, validate and normalize the returned source list, and map direct media results into MAVERO’s `SourceResult`. The current MAVERO `apiProviderAdapter` is intentionally a null placeholder, and the existing PlayerViewport supports native direct `<video src>` playback but does not include dash.js or another DASH playback dependency. Adding a new direct-stream playback dependency would be an architectural change outside the approved generic-template provider pattern and requires separate review.

## Sandbox and allowed-origin decision

No stable Bingr iframe/embed endpoint or sandbox policy was verified. Because Bingr’s current route is its own API-backed application and direct-media player, there is no safe exact embed origin/template to register. No sandbox policy is proposed, and no global sandbox changes are made.

## Security boundaries

No Bingr API key, hidden source extraction, proxying, cross-origin DOM access, redirect circumvention, ad removal, DRM/CAPTCHA/anti-bot bypass, or provider-security bypass was attempted. The rejected guessed server request was not retried with additional guessed values.

## Implementation result

No Bingr provider, source, migration, adapter, test, package change, Supabase record, deployment, or commit was created. Existing MAVERO providers and the working tree remain unchanged apart from this evaluation report.

Per the attached specification’s strict stop condition, implementation cannot safely proceed using the existing generic template adapter. Proceeding would require explicit architectural approval for a dedicated server-side Bingr API adapter and a decision about direct HLS/DASH playback support, after Bingr publishes or otherwise reliably exposes a stable server-resolution contract.

## References

[1]: https://bingr.one/ "Bingr current canonical site"
[2]: https://bingr.one/watch/movie/550 "Bingr current movie application route"
[3]: https://api.bingr.one/api/details/movie/550 "Bingr current public movie details API"
[4]: https://api.bingr.one/api/details/tv/1399 "Bingr current public TV details API"
[5]: https://api.bingr.one/api/episodes/1399/1 "Bingr current public TV episode API"
