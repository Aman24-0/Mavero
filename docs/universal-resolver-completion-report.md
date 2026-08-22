# MAVERO Universal Discovery / Resolver Milestone Report

## Executive result

The first universal public media discovery/resolution foundation is implemented. It is a separate server-side pipeline beside MAVERO's existing 7E providers, Phase 7F health/fallback, Phase 7G ranking, and PlayerShell. It accepts a public HTTPS page, performs bounded generic discovery, normalizes legitimate media candidates, isolates failures, returns diagnostics, and exposes a player-compatible projection through `/api/playback/discover`.

No new provider collection, scraper collection, DRM/anti-bot bypass, protected stream extraction, cross-origin manipulation, or Phase 7H work was started.

## Architecture

The lifecycle is:

```text
public HTTPS page
  -> safe bounded fetch + validated redirects
  -> generic detector layers
  -> MediaCandidate records
  -> canonicalization + candidate deduplication
  -> enabled resolver registry
  -> bounded resolver execution
  -> timeout/cancellation/error isolation
  -> safe URL validation + normalization
  -> NormalizedStreamResult[]
  -> PlayerSource compatibility projection
```

The universal foundation is organized under `src/lib/server/discovery/`. The registry supports resolver IDs, display names, priority, timeout, enabled state, supported media metadata, URL-pattern metadata, candidate support checks, and isolated resolver functions. Generic detectors are registered independently of site IDs, leaving a clean seam for future isolated site-specific adapters.

### Candidate and stream contracts

`MediaCandidate` carries URL, candidate type, origin page, discovery method, resolver ID, confidence, optional quality/language/audio metadata, subtitles, legitimate headers, and non-sensitive metadata. The normalizer converts valid candidates to `NormalizedStreamResult`, supporting HLS, DASH, MP4/file media, and HTTPS iframe/embed results where direct resolution is not appropriate.

Quality is normalized to `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`, or `unknown`. The system does not guess quality when no reliable signal exists. Subtitle URLs are independently validated, and a malformed subtitle does not invalidate the parent stream.

### Generic discovery layers

The generic detector set currently covers HTML `<video>`, `<audio>`, and `<source>` media attributes; `<track>` subtitle attributes; recognizable HLS/DASH/MP4/WebM URLs; MIME-derived extensionless HLS/DASH/MP4/WebM sources; HTTPS iframe/embed references; explicitly labeled public runtime embed references; data attributes such as `data-stream-url`; and explicitly labeled public API/source/manifest/media URL references present in the page response.

Candidates are canonicalized and deduplicated before resolution. Resolver results are deduplicated again by canonical URL, with the stronger-confidence result retained.

### Timeout, cancellation, and diagnostics

The page fetcher accepts a bounded timeout, supports a caller AbortSignal, validates every redirect hop, limits the response to 1.5 million characters, and rejects non-HTTPS/private/credential-bearing URLs. Resolver execution is bounded to four concurrent attempts, with a per-resolver timeout. Structured codes include `SOURCE_NOT_FOUND`, `DISCOVERY_FAILED`, `RESOLUTION_FAILED`, `TIMEOUT`, `INVALID_MEDIA`, `UNSUPPORTED_FORMAT`, `BLOCKED_SOURCE`, and `CANCELLED`.

Diagnostics include page URL, discovery methods attempted, candidate count, resolver IDs attempted, successful result count, failures by stage and code, duration, and final normalized stream count. The API uses `cache-control: no-store` and does not log or return secrets.

## Player integration

The new endpoint is:

```text
POST /api/playback/discover
{
  "pageUrl": "https://public.example/watch/movie",
  "mediaType": "movie"
}
```

It returns `streams`, `playerSources`, and `diagnostics`. The `playerSources` projection reuses MAVERO's existing `PlayerSource` shape and does not redesign or remount PlayerShell. Existing provider embeds, 7F fallback, 7G ranking, Landscape/fullscreen behavior, and source ordering remain separate and unchanged. Direct universal results are not silently injected into the traditional provider registry.

## Bingr evaluation

Bingr was evaluated as the first real-world target through the generic pipeline using the movie page [Bingr movie target][1] and TV episode page [Bingr TV target][2]. Passive page extraction showed a short loading/projectionist message for the movie target. The TV response exposed episode metadata, quality labels, audio/subtitle labels, and server labels, but no verified public media URL or reliable public server identifier contract.

The isolated generic probe completed both requests safely. Both returned zero generic candidates, zero resolver attempts, and zero normalized streams. Accordingly, MAVERO does not claim Bingr movie or TV playback success and does not add a Bingr-specific adapter in this milestone. A future Bingr adapter should only be added if a legitimate public media candidate and resolution contract can be established without protected-access bypass.

## Security and limitations

The system intentionally does not implement DRM bypass, CAPTCHA bypass, authentication or paywall bypass, anti-bot or geo bypass, private API access, credential/token extraction, protected stream extraction, arbitrary proxying, or cross-origin DOM manipulation. A page that requires those mechanisms is marked unsupported or blocked. A public iframe reference is normalized only as an HTTPS embed result; it is not treated as proof of direct stream access.

No persistent or signed-URL cache is implemented in this first milestone. Page HTML, temporary media URLs, and private metadata are not stored. A future cache must use explicit TTLs and must not retain temporary signed playback URLs beyond their validity.

## Tests and validation

The deterministic test file `scripts/universal_resolver_test.ts` covers HTML media discovery, manifest detection, direct media, embed detection, MIME-based extensionless streams, candidate normalization, quality parsing, subtitle parsing, language normalization, deduplication, resolver registry enabled-state, resolver error isolation, timeout, in-flight cancellation, unsafe redirect rejection, multiple normalized results, public-page fetch injection, and PlayerSource mapping.

The full regression chain also covers all existing Phase 7E providers, Phase 7F health/fallback, Phase 7G ranking, and the Landscape Player contract.

| Check | Result |
|---|---|
| `pnpm check` | Passed with 0 errors and 0 warnings |
| `pnpm test` | Passed: existing provider, 7F, 7G, Landscape, and universal resolver tests |
| `pnpm build` | Passed with the Netlify SvelteKit adapter |
| Local API smoke test | Passed: structured no-candidate Bingr response from `/api/playback/discover` |
| Bingr movie probe | 0 candidates, 0 normalized streams; no success claimed |
| Bingr TV probe | 0 candidates, 0 normalized streams; no success claimed |

## Files changed

| File or directory | Purpose |
|---|---|
| `src/lib/server/discovery/types.ts` | Candidate, normalized stream, registry, diagnostics, and player compatibility contracts |
| `src/lib/server/discovery/parsing.ts` | URL, quality, language, subtitle, canonicalization, and deduplication helpers |
| `src/lib/server/discovery/detectors.ts` | Generic HTML, manifest, embed, runtime, and public-API reference detectors |
| `src/lib/server/discovery/normalization.ts` | Safe candidate-to-stream normalization |
| `src/lib/server/discovery/errors.ts` | Structured discovery errors |
| `src/lib/server/discovery/registry.ts` | Generic-first resolver registry and bounded matching |
| `src/lib/server/discovery/service.ts` | Fetch, redirect safety, bounded lifecycle, cancellation, diagnostics, and resolution |
| `src/lib/server/discovery/player-source.ts` | Existing PlayerSource compatibility projection |
| `src/lib/server/discovery/index.ts` | Stable discovery module barrel |
| `src/routes/api/playback/discover/+server.ts` | Server API boundary |
| `scripts/universal_resolver_test.ts` | Deterministic foundation regression suite |
| `scripts/bingr_probe.ts` | Isolated real-world Bingr probe, not part of the main regression chain |
| `docs/universal-resolver-design.md` | Architecture and safety design |
| `docs/bingr-public-audit.md` | Bingr public behavior audit and probe findings |
| `docs/universal-resolver-completion-report.md` | This handoff report |
| `package.json` | Universal resolver test appended to existing regression chain |
| `PlayerShell.svelte` | Non-functional Svelte accessibility-warning suppression only; no runtime/player behavior change |

## Git and deployment

The final pre-deployment steps are intentionally consolidated according to the attached instruction: final local checks, one commit, one push to `origin/main`, one Netlify deployment, and production verification. The final identifiers are included in the delivery message after deployment is complete.

## References

[1]: https://bingr.one/watch/movie/1493400 "Bingr movie target"
[2]: https://bingr.one/watch/tv/95350/1/1 "Bingr TV episode target"
