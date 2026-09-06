# VidAPI provider contract notes

Source brief reviewed: user-provided `pasted_content.txt`, task titled `MAVERO — Implement VidAPI.tw + VidAPI.qzz.io`.

## VidAPI.tw

Canonical service: `https://vidapi.tw`.

Actual documented iframe host and allowed origin: `https://vaplayer.ru`.

Movie template: `https://vaplayer.ru/embed/movie/{tmdb_id}`.

TV template: `https://vaplayer.ru/embed/tv/{tmdb_id}/{season}/{episode}`.

Identifier: `tmdb_id`. Capabilities: movie, series, and episode supported; anime unsupported initially. Integration: `template`. Result: `embed`. Use the generic MAVERO template adapter and one provider/source only. No API keys, account functionality, undocumented endpoints, direct media resolution, proxying, extraction, download, or circumvention.

## VidAPI.qzz.io

Canonical service and allowed origin: `https://vidapi.qzz.io`.

Movie template: `https://vidapi.qzz.io/movie/{tmdb_id}`.

TV template: `https://vidapi.qzz.io/tv/{tmdb_id}/{season}/{episode}`.

Identifier: `tmdb_id`. Capabilities: movie, series, and episode supported; anime unsupported initially. Integration: generic `template` with `embed` result. The brief reports a natural redirect during the normal movie Play action to `kettledroopingcontinuation.com`; this behavior must remain provider-controlled and must not be intercepted, suppressed, bypassed, proxied, or rewritten.

Both providers are experimental, required-sandbox by default, disabled by default after browser verification, and must not be split into internal provider-server sources. No VidCore, other provider, Download, or Phase 7F work is authorized in this batch.

## Browser test routes

Movie route: `https://mavero1.netlify.app/watch/movie/movie-1493400`.

TV route: `https://mavero1.netlify.app/watch/series/series-95350?season=1&episode=1`.

Movie IDs and TV S01E01 identifiers come from the user-provided brief. Actual playback must not be claimed from iframe or provider UI rendering alone; personal user confirmation is required.
