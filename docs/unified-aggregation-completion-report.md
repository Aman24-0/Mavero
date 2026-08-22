# MAVERO Unified Stream Aggregation + OTT-Style Single Player

## Scope and outcome

This milestone completes the automatic unified playback path that follows the Universal Discovery foundation and precedes Phase 7H. The normal Watch flow now requests one backend decision instead of asking the user to choose a provider. MAVERO ranks eligible configured sources using the existing 7G ranking service, excludes disabled and cooldown sources through the existing 7F health policy, resolves a bounded set in parallel, incorporates safe universal discovery results from explicitly supplied public pages and provider embeds, and returns one selected `PlayerSource` with retained alternatives.

Manual source selection remains available through the existing source drawer. Manual selection continues to bypass aggregation and preserves the previous explicit-source behavior. No provider registry was rewritten, no Bingr provider was added, and no protected-access or ad/redirect/DRM/CAPTCHA/anti-bot bypass was introduced.

## Unified resolution flow

The automatic path is opt-in through `aggregate: true` and is used by the default Watch now action when fallback is allowed. The server ranks configured sources with `rankProviderSourceList`, attempts at most eight ranked provider candidates with at most four concurrent workers, records runtime success/failure through the existing 7F health service, and stops the client-facing decision early when a validated direct candidate appears. If no direct candidate is available, a validated embed candidate remains the safe automatic fallback. Provider embeds may be passed through the generic public discovery foundation; an iframe load by itself is never treated as direct playback success.

Candidate playback URLs are validated before they enter the player, deduplicated by actual playback URL, and ordered deterministically by score, ranked source order, and candidate ID. Quality, audio, and subtitle metadata is copied only from real resolver/discovery metadata. The watch page keeps aggregate alternatives internally and tries them only when initialization fails before playback has successfully started; an already-started stream is never interrupted by later enrichment.

| Layer | Milestone behavior |
| --- | --- |
| Eligibility | Existing 7G provider/source lifecycle, capability, visibility, and 7F cooldown rules remain authoritative. |
| Bounded resolution | Eight provider attempts maximum, four concurrent workers maximum, plus at most four explicitly supplied public pages. |
| Selection | Direct streams receive a deterministic playable bonus while provider ranking remains the score base; embeds are retained as fallback. |
| Safety | HTTPS, private-host, credential, allowed-origin, sandbox, expiry, and player-source guards remain in force. |
| Client UX | Default Play uses `Finding the best stream…`; all-candidate exhaustion becomes one neutral MAVERO message. |
| Debug path | Existing source drawer, Previous/Next source actions, Retry, and manual source resolution remain available. |

## Player implementation

The existing MAVERO `PlayerShell` and `PlayerViewport` were extended rather than replaced. Plain MP4/WebM-compatible direct media continues through the HTML5 video element. HLS uses native Safari playback when available and otherwise dynamically imports `hls.js` in the browser, attaches it to the existing video element, publishes real manifest audio tracks when available, and destroys the instance on source change or component teardown. DASH dynamically imports `dashjs`, initializes the same video element, maps real audio tracks when the runtime exposes them, and resets on source change or teardown.

Native loader failures dispatch the existing player error event and are eligible for the watch page's guarded initialization-only alternative fallback. HTTPS embeds remain inside the existing sandboxed iframe boundary and never expose third-party DOM internals. The existing Landscape-only control collapse/expand behavior, portrait behavior, fullscreen, orientation handling, subtitles, quality switching, and source navigation were preserved.

Audio selection is best-effort. It appears only when more than one real audio track is reported by the source metadata or runtime. HLS and DASH runtime switching is attempted through their public player APIs; browsers that do not expose the relevant capability simply provide no audio selector. MAVERO does not manufacture audio tracks.

## Files and deliverables

The main implementation areas are `src/lib/server/aggregation/`, resolver service and endpoint integration, discovery audio-track contracts, resolver-core protocol propagation, `PlayerViewport.svelte`, `PlayerShell.svelte`, `PlayerControls.svelte`, and the Watch route. The regression additions are `scripts/unified_aggregation_test.ts` and `scripts/native_player_contract_test.ts`, both appended to the existing serial `pnpm test` chain. The report and browser artifacts are stored under `docs/`.

## Verification

The final independent verification pass completed with all exit codes equal to zero:

| Command | Result |
| --- | --- |
| `pnpm check` | Passed with 0 errors and 0 warnings. |
| `pnpm test` | Passed all existing Phase 7E, 7F, 7G, Landscape, Universal Discovery, Unified Aggregation, and Native Player contract tests. |
| `pnpm build` | Passed with the Netlify adapter. Vite emitted existing large-chunk advisories only; no build error occurred. |
| Desktop browser flow | Verified default Watch navigation, automatic loading state, neutral aggregate failure card, and preserved player actions. |
| Mobile snapshot | Verified 390×844 responsive home rendering without horizontal overflow. |
| Landscape snapshot | Verified 844×390 watch loading state with centered loading treatment and compact layout. |

The deterministic aggregation suite covers healthy ranking ahead of cooldown exclusion, failed-candidate fallback, duplicate URL removal, HLS/DASH/MP4 PlayerSource mapping, embed fallback, quality/audio/subtitle propagation, early direct selection, public discovery, cancellation, bounded attempt limits, clean exhaustion, and manual-path preservation. The native contract suite covers browser-only dynamic imports, teardown/reset, error dispatch, audio hooks, captions, sandboxed embeds, and Landscape preservation.

The local browser run did not claim real provider playback success because the current local provider configuration returned no validated candidate for the selected fixture title. The observed result was the intended clean state: **“No playable stream could be found right now. Try again in a moment.”** Bingr remains unsupported with the previously recorded zero-candidate/zero-stream result and was not added as a provider or adapter.

## Explicit non-goals and limitations

This milestone does not start Phase 7H, perform mass scraper collection, add site-specific adapters without verified public patterns, proxy arbitrary resources, bypass access controls, remove third-party ads, extract protected streams, or add private credentials to the browser. Native HLS/DASH playback still depends on the public source's CORS and media policy; when those conditions fail, MAVERO reports the initialization failure and may try a retained legitimate HTTPS alternative. Audio switching is intentionally best-effort because browser support and source metadata vary.

The early direct decision is client-facing and intentionally does not wait for marginal later candidates. Remaining bounded tasks may finish server-side after the response as best-effort enrichment, but they cannot replace the selected stream during active playback.

## Release status

This report is prepared for the single final release operation requested for the milestone. The working tree is to receive one final commit, one push to `origin/main`, and one Netlify production deployment. No additional provider or Phase 7H work is included.
