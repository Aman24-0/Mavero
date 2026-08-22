# MAVERO Universal Discovery / Resolver Foundation

## Scope

This milestone adds a generic public-page discovery and resolution foundation. It is an additional server-side capability beside the existing template providers, Phase 7F health/fallback, Phase 7G ranking, and PlayerShell. It does not replace provider resolution, modify provider ordering, add scraping collections, or start 7H.

## Architecture

The lifecycle is:

```text
public HTTPS page
  -> bounded fetch with validated redirect hops
  -> generic detector pipeline
  -> MediaCandidate records
  -> candidate canonicalization and deduplication
  -> resolver registry
  -> bounded resolver execution with timeout/cancellation/error isolation
  -> safe URL validation and stream normalization
  -> normalized stream results
  -> PlayerSource compatibility mapper
```

The detectors are intentionally generic. They inspect HTML media elements, source attributes, recognizable manifest/file URLs, public iframe/embed references, and public runtime metadata. No detector assumes a specific site ID. Future site-specific adapters can be registered as isolated resolvers with their own capabilities, URL patterns, priority, timeout, and enabled state.

## Candidate contract

`MediaCandidate` carries the candidate URL, candidate type, origin page, discovery method, resolver ID, confidence, optional quality/language/audio-language metadata, subtitle references, legitimate playback headers, and non-sensitive metadata. A candidate is not considered playable until normalization succeeds.

## Normalized stream contract

`NormalizedStreamResult` supports direct HLS, DASH, MP4, WebM/file media where the URL is recognizable, and HTTPS embed results when direct resolution is not appropriate. Every result carries a stable ID, stream type, URL, protocol, origin page, resolver, discovery method, confidence, quality (`2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`, or `unknown`), optional language data, subtitles, headers, and metadata.

Quality remains `unknown` when it cannot be established. The normalizer never invents quality from a page title or unrelated metadata.

## Registry and lifecycle

The resolver registry supports resolver ID, display name, supported media types, URL-pattern metadata, priority, timeout, enabled state, candidate support checks, and resolution functions. Resolver execution is bounded to four concurrent candidates. Each resolver has a maximum execution time, and one failure does not terminate other candidates. The request accepts an `AbortSignal`; cancellation is checked before detector and resolver work and is represented by `CANCELLED`.

Diagnostics record the page URL, detector methods attempted, candidate count, resolver IDs attempted, successful results, failures by stage and structured error code, elapsed time, and final normalized stream count. Diagnostics do not include secrets or sensitive headers.

## Safety boundary

Only public HTTPS page URLs are accepted. Every redirect target is validated before following it. Localhost, private-network hostnames, credentials embedded in URLs, non-HTTPS pages, invalid source URLs, and unsafe redirects are rejected. Direct results are validated through MAVERO's existing safe URL boundary. Embed results are HTTPS-only and remain subject to the current player boundary; the resolver does not inspect or manipulate cross-origin DOM content.

The system does not implement DRM, CAPTCHA, authentication, paywall, anti-bot, geo-restriction, access-control, private-API, credential, token, protected-stream, or provider-security bypasses. A protected source is reported as unsupported or blocked.

## Caching

This first foundation does not persist page HTML, temporary media URLs, signed URLs, or private metadata. The API returns `cache-control: no-store`. A later cache layer may cache non-sensitive page metadata or stable identity mappings with explicit TTLs, but temporary or signed playback URLs must not outlive their validity.

## Player integration

`/api/playback/discover` returns normalized `streams`, a `playerSources` compatibility projection, and diagnostics. The projection uses the existing MAVERO `PlayerSource` shape and does not require PlayerShell redesign. Existing provider embeds and the current Landscape/fullscreen behavior remain untouched.

## Bingr evaluation

Bingr was evaluated as the first real-world target using the generic pipeline. The movie target `https://bingr.one/watch/movie/1493400` and TV target `https://bingr.one/watch/tv/95350/1/1` were probed passively. The currently accessible responses produced zero generic candidates and zero normalized streams in both cases. The TV page exposed visible episode, quality, audio, subtitle, and server labels through extraction, but no verified public media URL or server identifier contract. Because a usable public media reference was not established, no Bingr-specific adapter was added and no success is claimed.

Future Bingr work, if publicly resolvable without protected-access bypass, should be isolated behind a site-specific registry adapter and separately tested. It must not be promoted into the traditional provider model merely because the public watch page loads.
