# Phase 7D Provider Research Notes

## Phase 0 audit

The inherited master specification requires provider-by-provider capability and authorization evaluation before implementation. No tracked Phase 0 provider shortlist was present in the MAVERO repository. The current source adapter registry remains provider-agnostic with template, direct, embed, api, and custom integration types. Current streaming activation is database-controlled through Phase 7A public mirror configuration.

## Candidate: Internet Archive

Official documentation: https://archive.org/developers/metadata.html

The Internet Archive Metadata API describes public items as identifier-addressed records and provides metadata read operations. The documentation states that metadata reads are generally public while certain user fields and all write operations require authorization. This is a legitimate catalog/file metadata candidate, but a provider adapter would still need to verify item-level rights, publicly downloadable media files, and stable playback URLs for any selected content before activation. It must not assume that a metadata record grants playback rights.

## Candidate: YouTube

Official documentation: https://developers.google.com/youtube/iframe_api_reference

The official YouTube IFrame Player API is an authorized embed/player-control integration. It exposes an iframe player, JavaScript controls, and playback events through the documented API. It is an embed candidate, not a direct-media URL provider. A MAVERO adapter would need a legitimate YouTube video identifier from trusted content/configuration and would keep the provider player inside the Phase 7C embed shell without cross-origin DOM access or provider-ad circumvention.

## Candidate: TMDB / JustWatch watch-provider metadata

Official documentation: https://developer.themoviedb.org/reference/movie-watch-providers

TMDB’s watch-provider endpoint supplies country-level availability metadata through its JustWatch partnership. It is a discovery/availability metadata source, not itself an authorized playback source. It should not be selected as a playback provider unless a separate documented playback authorization exists.

## Vidsrc candidate verification

Source checked: https://vidsrc.domains/

The page self-identifies as an official domain list and claims that VidSrc offers streaming links for movies and episodes through embed links, an API, or WordPress plugins. It lists changing domains and warns about fake sites. The page does not provide verifiable licensing/authorization for the underlying movie or episode catalog, a formal API specification with terms, or evidence that MAVERO is authorized to redistribute those playback links. The user-provided `vidsrc.wiki` domain is not among the domains shown on this page’s active-domain list. This is insufficient to establish legitimate Phase 7D provider use.

A read-only live check of `https://vidsrc.wiki/embed/movie/533535` and `https://vidsrc.wiki/embed/tv/79744/1/1` has not been used to extract media or bypass the provider player. The candidate remains unselected pending authorization evidence.

## Passive endpoint check — 2026-08-20

Both user-provided Vidsrc embed paths were reachable but returned a WordPress slash-normalization redirect (`301`) rather than a documented provider API response. `https://vidsrc.wiki/robots.txt` was reachable. `https://vidsrc.wiki/terms` returned `404`, so no terms/authorization page was available at that conventional path. The site response identifies WordPress/Hostinger infrastructure, which does not establish catalog licensing or authorization. No media URLs, player internals, or redirect destinations were extracted.

**Phase 7D decision:** current verification is insufficient to establish legitimate authorized use of Vidsrc as a MAVERO playback provider. Under the Phase 7D specification, the provider must remain unintegrated/disabled and the provider-specific implementation must stop rather than force a production adapter.

## Revised-policy ordinary embed verification

The user-provided URLs were opened as ordinary public pages without inspecting cross-origin internals or extracting media URLs:

- `https://vidsrc.wiki/embed/movie/533535/` loaded as a page titled `VidSrc` and exposed a visible `Server` selector with `Pro 1`.
- `https://vidsrc.wiki/embed/tv/79744/1/1/` loaded as a page titled `VidSrc` and exposed the same `Server` selector with `Pro 1`.

This confirms that the supplied URL patterns are technically representable as `embed` sources for movie and TV/episode contexts. It does not establish direct media behavior, licensing, or permission to remove provider-controlled ads/redirects. No hidden media URLs, DOM internals, or cross-origin player state were accessed.
