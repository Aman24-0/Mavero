// ============================================================
// Mavero TV — API data models.
//
// Two endpoint families are mirrored here:
//
// 1. GET /api/tv/home — the rail envelope (TvHomeResponse/TvRail/
//    MediaItem). The server shape is produced by toMediaItem() in
//    apps/web/src/lib/server/content/presenter.ts against the
//    MediaItem type in apps/web/src/lib/data/content.ts — the
//    camelCase keys below are the exact wire format (id/title/
//    year/type/poster/...), NOT the pre-Phase-7 guesses
//    (PosterPath/VoteAverage never existed on this endpoint).
//
// 2. GET /api/content/{type}/{id} — the detail envelope
//    (ContentDetailResponse/MediaDetail). Verified against the
//    live API on 2026-11: item ids look like "movie-969681" /
//    "series-2734" ({type}-{tmdbId}) and the {type} path segment
//    MUST match the item's own type — /api/content/movie/
//    series-2734 does NOT error, it silently returns the wrong
//    title (movie-2734), so FetchDetailAsync always derives the
//    segment from the item itself.
//
// 3. GET /api/downloader/mavero — the Stremio addon stream groups
//    (AddonStreamsResponse/AddonStreamGroup/AddonStream, PRIORITY 1
//    playback source for the native player; see the block at the
//    end of this file for the verified wire contract).
// ============================================================
using System;
using System.Collections.Generic;

namespace MaveroTv
{
    /// <summary>One media title on a home rail.</summary>
    public class MediaItem
    {
        /// <summary>Catalog id — "{type}-{tmdbId}" style ("movie-969681").</summary>
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("year")]
        public int Year { get; set; }

        /// <summary>"movie" | "series" | "anime" (ContentType union on the server).</summary>
        [JsonProperty("type")]
        public string Type { get; set; }

        /// <summary>True when the title is anime (TMDB genre 16 + original
        /// language 'ja'; purely a categorization hint — anime series play
        /// through the same season/episode pipeline as regular series).</summary>
        [JsonProperty("isAnime")]
        public bool IsAnime { get; set; }

        /// <summary>Full-size poster URL.</summary>
        [JsonProperty("poster")]
        public string Poster { get; set; }

        /// <summary>Full-size backdrop URL (future hero art).</summary>
        [JsonProperty("backdrop")]
        public string Backdrop { get; set; }

        [JsonProperty("rating")]
        public double Rating { get; set; }

        [JsonProperty("runtime")]
        public string Runtime { get; set; }

        [JsonProperty("genres")]
        public List<string> Genres { get; set; }

        [JsonProperty("description")]
        public string Description { get; set; }
    }

    /// <summary>One horizontal rail on the TV home ("Trending movies", ...).</summary>
    public class TvRail
    {
        [JsonProperty("key")]
        public string Key { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("items")]
        public List<MediaItem> Items { get; set; }
    }

    /// <summary>Envelope of GET /api/tv/home.</summary>
    public class TvHomeResponse
    {
        /// <summary>False on a catalog outage — rails degrade gracefully.</summary>
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("rails")]
        public List<TvRail> Rails { get; set; }
    }

    // ============================================================
    // Search (GET /api/content/search).
    //
    // Verified against the LIVE backend on 2026-11:
    //   GET /api/content/search?q=batman[&type=movie|series|anime]
    //                                     [&page=1..20]
    //     -> { ok, items: [ <MediaItem>... ], page, hasNextPage,
    //          query, filters, source }
    //   - item rows are the SAME toMediaItem() projection the home
    //     rails serve (id/title/year/type/isAnime/poster/...), so the
    //     existing MediaItem model binds them as-is and MediaCard
    //     renders them unchanged;
    //   - no match / empty query returns ok:true with items:[] — the
    //     caller renders the honest "No results found" state;
    //   - queries over 120 chars are rejected server-side
    //     (INVALID_QUERY, HTTP 400) — the keyboard caps the query at
    //     the same limit before the request is ever sent;
    //   - the endpoint is rate-limited per identity (HTTP 429):
    //     GetStringAsync surfaces that as an HttpRequestException the
    //     caller handles as a plain "search unavailable" state.
    // ============================================================

    /// <summary>Envelope of GET /api/content/search.</summary>
    public class SearchResponse
    {
        /// <summary>False on a catalog outage or a rejected query.</summary>
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("items")]
        public List<MediaItem> Items { get; set; }

        /// <summary>1-based result page the server served.</summary>
        [JsonProperty("page")]
        public int Page { get; set; }

        /// <summary>True when the server holds more pages for this query.</summary>
        [JsonProperty("hasNextPage")]
        public bool HasNextPage { get; set; }

        /// <summary>The query echoed back by the server.</summary>
        [JsonProperty("query")]
        public string Query { get; set; }
    }

    /// <summary>Envelope of GET /api/content/{type}/{id}.</summary>
    public class ContentDetailResponse
    {
        /// <summary>False when the id is unknown or the catalog is degraded.</summary>
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("item")]
        public MediaDetail Item { get; set; }
    }

    /// <summary>Full detail record for one title (superset of MediaItem).</summary>
    public class MediaDetail
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("year")]
        public int Year { get; set; }

        /// <summary>TMDB release/first-air date, "yyyy-MM-dd".</summary>
        [JsonProperty("releaseDate")]
        public string ReleaseDate { get; set; }

        /// <summary>"movie" | "series" | "anime".</summary>
        [JsonProperty("type")]
        public string Type { get; set; }

        [JsonProperty("maturity")]
        public string Maturity { get; set; }

        /// <summary>Human runtime ("2h 25m" for movies, "28 seasons" for series).</summary>
        [JsonProperty("runtime")]
        public string Runtime { get; set; }

        /// <summary>True when the title is anime (see MediaItem.IsAnime).</summary>
        [JsonProperty("isAnime")]
        public bool IsAnime { get; set; }

        /// <summary>
        /// Per-season metadata for series/anime titles (number, title,
        /// episode count, poster) — NO episodes. The episode lists are
        /// fetched per season from GET /api/content/series/{id}/season/{n}
        /// (verified live, 2026-11: the detail payload carries seasonsData
        /// but never inline episodes).
        /// </summary>
        [JsonProperty("seasonsData")]
        public List<Season> SeasonsData { get; set; }

        [JsonProperty("rating")]
        public double Rating { get; set; }

        [JsonProperty("voteCount")]
        public int VoteCount { get; set; }

        [JsonProperty("genres")]
        public List<string> Genres { get; set; }

        [JsonProperty("description")]
        public string Description { get; set; }

        [JsonProperty("poster")]
        public string Poster { get; set; }

        /// <summary>TMDB w1280 backdrop — sized for the 1920x620 hero slot.</summary>
        [JsonProperty("backdrop")]
        public string Backdrop { get; set; }

        /// <summary>YouTube trailer key (native player phase, not used yet).</summary>
        [JsonProperty("trailerKey")]
        public string TrailerKey { get; set; }

        [JsonProperty("cast")]
        public List<CastMember> Cast { get; set; }
    }

    /// <summary>One billed cast entry on the detail page.</summary>
    public class CastMember
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("character")]
        public string Character { get; set; }

        [JsonProperty("photo")]
        public string Photo { get; set; }
    }

    // ============================================================
    // Seasons & episodes (series/anime detail + playback).
    //
    // Verified against the LIVE backend on 2026-11:
    //   GET /api/content/series/{id}/season/{n}
    //     -> { ok, season: { number, title, episodeCount, airDate?,
    //          poster?, episodes: [ { id, number, season, title,
    //          overview?, airDate?, runtime?, still? } ] } }
    //   - the route lives ONLY under the "series" path segment, but
    //     the endpoint accepts BOTH "series-{tmdbId}" and
    //     "anime-{tmdbId}" ids (anime is TMDB TV on the backend);
    //   - "still" is a TMDB w500 episode thumbnail URL (may be absent
    //     for unaired episodes);
    //   - announced-but-unreleased seasons never appear in seasonsData
    //     (the server filters them), so a selected season always has
    //     real episodes.
    // ============================================================

    /// <summary>One episode of a season (season endpoint response row).</summary>
    public class Episode
    {
        /// <summary>TMDB episode id (numeric string).</summary>
        [JsonProperty("id")]
        public string Id { get; set; }

        /// <summary>1-based episode number inside its season.</summary>
        [JsonProperty("number")]
        public int Number { get; set; }

        [JsonProperty("season")]
        public int Season { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("overview")]
        public string Overview { get; set; }

        /// <summary>ISO air date ("yyyy-MM-dd"); absent for unaired episodes.</summary>
        [JsonProperty("airDate")]
        public string AirDate { get; set; }

        /// <summary>Human runtime ("44m").</summary>
        [JsonProperty("runtime")]
        public string Runtime { get; set; }

        /// <summary>TMDB w500 still thumbnail (absent for unaired episodes).</summary>
        [JsonProperty("still")]
        public string Still { get; set; }
    }

    /// <summary>One season of a series (detail record's seasonsData row; no episodes).</summary>
    public class Season
    {
        [JsonProperty("number")]
        public int Number { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("episodeCount")]
        public int EpisodeCount { get; set; }

        [JsonProperty("airDate")]
        public string AirDate { get; set; }

        [JsonProperty("poster")]
        public string Poster { get; set; }
    }

    /// <summary>Envelope of GET /api/content/series/{id}/season/{n}.</summary>
    public class SeasonResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("season")]
        public SeasonDetail Season { get; set; }
    }

    /// <summary>Season record WITH its full episode list (season endpoint body).</summary>
    public class SeasonDetail
    {
        [JsonProperty("number")]
        public int Number { get; set; }

        [JsonProperty("title")]
        public string Title { get; set; }

        [JsonProperty("episodeCount")]
        public int EpisodeCount { get; set; }

        [JsonProperty("airDate")]
        public string AirDate { get; set; }

        [JsonProperty("poster")]
        public string Poster { get; set; }

        [JsonProperty("episodes")]
        public List<Episode> Episodes { get; set; }
    }

    /// <summary>
    /// Which episode of a series to play. Null season/episode = a movie
    /// (or an unspecified series default) — the resolve body omits both.
    /// </summary>
    public class PlaybackTarget
    {
        public int? Season { get; set; }

        public int? Episode { get; set; }

        /// <summary>"S1E1"-style label for logs and status lines; null for movies.</summary>
        public string Label
        {
            get
            {
                return Season.HasValue && Episode.HasValue
                    ? "S" + Season.Value + "E" + Episode.Value
                    : null;
            }
        }
    }

    // ============================================================
    // Streaming (server list + playback resolution).
    //
    // Verified against the LIVE backend on 2026-11:
    //   GET  /api/streaming/config
    //        -> { ok, config: { version, updatedAt, providers[],
    //             sources[], defaults: { movie, series, anime, adult } } }
    //     sources[] entries are the user-facing servers (Plutonium,
    //     Vanadium, DirectStream, ...) each with id/name/ordering/
    //     enabled/visibility/status + capabilities.result_type
    //     ("direct" | "embed").
    //   POST /api/playback/resolve
    //        body { sourceId, contentId, mediaType, allowFallback,
    //               season?, episode? }   (season/episode for series/anime)
    //        -> { ok, source: { type: "direct"|"embed"|"unavailable"|"error",
    //             url, providerId, sourceId, mediaType, qualities?,
    //             metadata: { providerName, protocol, servers? } } }
    //     a "direct" url is a playable stream (HLS/MP4 — AVPlay
    //     handles both); an "embed" url is an HTML player page that
    //     the native player can only attempt, never guarantee.
    // ============================================================

    /// <summary>Envelope of GET /api/streaming/config.</summary>
    public class StreamingConfigResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("config")]
        public PublicStreamingConfig Config { get; set; }
    }

    /// <summary>Public streaming configuration (server catalog).</summary>
    public class PublicStreamingConfig
    {
        [JsonProperty("providers")]
        public List<PublicProvider> Providers { get; set; }

        [JsonProperty("sources")]
        public List<PublicSource> Sources { get; set; }

        /// <summary>Per-media-type default source id ("movie" -> source id).</summary>
        [JsonProperty("defaults")]
        public Dictionary<string, string> Defaults { get; set; }
    }

    /// <summary>One streaming provider entry from the public config.</summary>
    public class PublicProvider
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("capabilities")]
        public SourceCapabilities Capabilities { get; set; }
    }

    /// <summary>One user-facing server (a configured provider source).</summary>
    public class PublicSource
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("provider_id")]
        public string ProviderId { get; set; }

        [JsonProperty("enabled")]
        public bool Enabled { get; set; }

        /// <summary>"public" | "private" — only public entries serve unauthenticated clients.</summary>
        [JsonProperty("visibility")]
        public string Visibility { get; set; }

        /// <summary>"active" | "experimental".</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("ordering")]
        public int Ordering { get; set; }

        [JsonProperty("capabilities")]
        public SourceCapabilities Capabilities { get; set; }
    }

    /// <summary>Playback capabilities block (shared by providers and sources).</summary>
    public class SourceCapabilities
    {
        /// <summary>"direct" | "embed" — whether resolution yields a playable stream.</summary>
        [JsonProperty("result_type")]
        public string ResultType { get; set; }

        [JsonProperty("supports_direct")]
        public bool SupportsDirect { get; set; }

        [JsonProperty("movie")]
        public bool Movie { get; set; }

        [JsonProperty("series")]
        public bool Series { get; set; }

        [JsonProperty("anime")]
        public bool Anime { get; set; }
    }

    /// <summary>Envelope of POST /api/playback/resolve.</summary>
    public class ResolveResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("source")]
        public ResolvedSource Source { get; set; }

        [JsonProperty("error")]
        public ResolverError Error { get; set; }
    }

    /// <summary>One resolved playback source (server-side resolution result).</summary>
    public class ResolvedSource
    {
        /// <summary>"direct" | "embed" | "unavailable" | "error".</summary>
        [JsonProperty("type")]
        public string Type { get; set; }

        [JsonProperty("url")]
        public string Url { get; set; }

        [JsonProperty("providerId")]
        public string ProviderId { get; set; }

        [JsonProperty("sourceId")]
        public string SourceId { get; set; }

        [JsonProperty("mediaType")]
        public string MediaType { get; set; }

        [JsonProperty("qualities")]
        public List<QualityOption> Qualities { get; set; }

        [JsonProperty("metadata")]
        public ResolvedSourceMetadata Metadata { get; set; }
    }

    /// <summary>One quality rendition of a resolved stream.</summary>
    public class QualityOption
    {
        [JsonProperty("url")]
        public string Url { get; set; }

        [JsonProperty("label")]
        public string Label { get; set; }

        [JsonProperty("height")]
        public int Height { get; set; }

        [JsonProperty("bitrate")]
        public int Bitrate { get; set; }
    }

    /// <summary>Presentation metadata attached to a resolution.</summary>
    public class ResolvedSourceMetadata
    {
        [JsonProperty("providerName")]
        public string ProviderName { get; set; }

        [JsonProperty("sourceName")]
        public string SourceName { get; set; }

        /// <summary>"hls" | "dash" | "mp4" | "file" | "unknown".</summary>
        [JsonProperty("protocol")]
        public string Protocol { get; set; }

        /// <summary>Playback mirrors exposed by the resolution ("Server 1/2", "Auto", ...).</summary>
        [JsonProperty("servers")]
        public List<ServerMirror> Servers { get; set; }
    }

    /// <summary>One playback mirror of the active resolution.</summary>
    public class ServerMirror
    {
        [JsonProperty("url")]
        public string Url { get; set; }

        [JsonProperty("label")]
        public string Label { get; set; }
    }

    // ============================================================
    // Authentication (device pairing) + cloud sync (My List).
    //
    // Verified against the backend source on 2026-11:
    //
    //   POST /api/auth/device-pairing/create          (no auth)
    //     -> { ok, pairing: { secret, shortCode, qrUrl,
    //          expiresAt (ISO, 5-minute TTL), deviceName } }
    //     The 8-char shortCode (alphabet without 0/O/1/I) is what the
    //     user types on their phone; the secret is the TV's bearer
    //     credential for the status/exchange polls.
    //
    //   POST /api/auth/device-pairing/status   body { secret } (no auth)
    //     -> { ok, status: "pending" | "approved" | "exchanging" |
    //                    "consumed" | "failed" | "expired" | "cancelled" }
    //     The TV polls this every 3s (the pairingPoll rate limit allows
    //     60/min) until the phone approves.
    //
    //   POST /api/auth/device-pairing/exchange body { secret } (no auth)
    //     -> ok  : { ok, message: "Session established." } + Set-Cookie
    //              establishing the Supabase session (chunked
    //              sb-*-auth-token cookies — the session lives in the
    //              cookie jar, never in the JSON body);
    //     fail  : { ok:false, message, reason, retryable } — transient
    //              failures (retryable:true) may be retried with the
    //              SAME secret (the pairing is released back to
    //              "approved"); terminal failures need a fresh pairing.
    //
    //   GET /api/account/sync                  (auth: session cookies)
    //     -> { progress, favorites: [FavoriteRecord],
    //          favoriteDeletions }
    //   PUT /api/account/sync                  (auth: session cookies)
    //     body { favorites?: [FavoriteRecord], ... } — upserts the
    //     records (the "Add to My List" write path; omitted arrays are
    //     treated as empty and never touched).
    //
    //   DELETE /api/account/favorites?contentType=&contentId=
    //                                          (auth: session cookies)
    //     -> { ok, deletedAt } — the "remove from My List" write path.
    //
    // FavoriteRecord wire shape (shared validator progress-records.ts):
    //   key            = "{contentType}:{contentId}" (required, exact);
    //   contentType    = "movie" | "series" | "anime";
    //   contentId      = the catalog id ("movie-969681"), <= 120 chars;
    //   snapshot       = { title (<=240), poster (<=2000, may be ""),
    //                      backdrop?, year? 1800..3000, runtime?, rating?
    //                      0..10, genres? <=20x80, description?, isAnime?,
    //                      animeFormat? "movie"|"series" };
    //   status?        = "planned" | "watching" | "completed";
    //   createdAt/updatedAt = epoch milliseconds (> 0).
    //   A record that violates ANY bound is rejected by the server
    //   (HTTP 400) — the native builder clamps every field.
    // ============================================================

    /// <summary>Envelope of POST /api/auth/device-pairing/create.</summary>
    public class PairingCreateResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("pairing")]
        public PairingInfo Pairing { get; set; }
    }

    /// <summary>One device-pairing challenge (create response body).</summary>
    public class PairingInfo
    {
        /// <summary>The TV's bearer credential for status/exchange polls.</summary>
        [JsonProperty("secret")]
        public string Secret { get; set; }

        /// <summary>8-char code (no ambiguous chars) the user enters on their phone.</summary>
        [JsonProperty("shortCode")]
        public string ShortCode { get; set; }

        /// <summary>The QR URL (&lt;origin&gt;/authorize#s=...) — informational for the native TV.</summary>
        [JsonProperty("qrUrl")]
        public string QrUrl { get; set; }

        /// <summary>ISO-8601 instant; the pairing expires 5 minutes later.</summary>
        [JsonProperty("expiresAt")]
        public string ExpiresAt { get; set; }

        /// <summary>Display name the backend derived for this device.</summary>
        [JsonProperty("deviceName")]
        public string DeviceName { get; set; }
    }

    /// <summary>Envelope of POST /api/auth/device-pairing/status.</summary>
    public class PairingStatusResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        /// <summary>"pending" | "approved" | "exchanging" | "consumed" | "failed" | "expired" | "cancelled".</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>Envelope of POST /api/auth/device-pairing/exchange.</summary>
    public class PairingExchangeResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }

        /// <summary>True on transient failures — the exchange may be retried with the same secret.</summary>
        [JsonProperty("retryable")]
        public bool Retryable { get; set; }
    }

    /// <summary>Outcome of one exchange attempt (client-side projection).</summary>
    public class ExchangeOutcome
    {
        public bool Ok { get; set; }

        /// <summary>True when the failure is transient and a retry may succeed.</summary>
        public bool Retryable { get; set; }

        public string Message { get; set; }
    }

    /// <summary>Envelope of GET /api/account/sync (only favorites are consumed).</summary>
    public class AccountSyncResponse
    {
        [JsonProperty("favorites")]
        public List<FavoriteRecord> Favorites { get; set; }
    }

    /// <summary>One saved title in the user's cloud list (favorites row).</summary>
    public class FavoriteRecord
    {
        /// <summary>"{contentType}:{contentId}" — must match the two fields exactly.</summary>
        [JsonProperty("key")]
        public string Key { get; set; }

        /// <summary>"movie" | "series" | "anime".</summary>
        [JsonProperty("contentType")]
        public string ContentType { get; set; }

        /// <summary>Catalog id ("movie-969681").</summary>
        [JsonProperty("contentId")]
        public string ContentId { get; set; }

        [JsonProperty("snapshot")]
        public ContentSnapshot Snapshot { get; set; }

        /// <summary>"planned" | "watching" | "completed" (absent = planned).</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        /// <summary>Epoch milliseconds.</summary>
        [JsonProperty("createdAt")]
        public long CreatedAt { get; set; }

        /// <summary>Epoch milliseconds.</summary>
        [JsonProperty("updatedAt")]
        public long UpdatedAt { get; set; }
    }

    /// <summary>Title metadata that travels with a favorite (web ContentSnapshot).</summary>
    /// Optional fields are omitted from the JSON when null/empty — the server's
    /// record validator treats PRESENT-but-null/0 fields as invalid records,
    /// so NullValueHandling.Ignore is a wire-correctness requirement.
    public class ContentSnapshot
    {
        [JsonProperty("title")]
        public string Title { get; set; }

        /// <summary>May be empty (bounded at 2000 chars, empty allowed).</summary>
        [JsonProperty("poster")]
        public string Poster { get; set; }

        [JsonProperty("backdrop", NullValueHandling = NullValueHandling.Ignore)]
        public string Backdrop { get; set; }

        /// <summary>1800..3000 when present; omitted when unknown.</summary>
        [JsonProperty("year", NullValueHandling = NullValueHandling.Ignore)]
        public int? Year { get; set; }

        [JsonProperty("runtime", NullValueHandling = NullValueHandling.Ignore)]
        public string Runtime { get; set; }

        /// <summary>0..10 when present; omitted when unrated.</summary>
        [JsonProperty("rating", NullValueHandling = NullValueHandling.Ignore)]
        public double? Rating { get; set; }

        [JsonProperty("genres", NullValueHandling = NullValueHandling.Ignore)]
        public List<string> Genres { get; set; }

        [JsonProperty("description", NullValueHandling = NullValueHandling.Ignore)]
        public string Description { get; set; }

        [JsonProperty("isAnime", NullValueHandling = NullValueHandling.Ignore)]
        public bool? IsAnime { get; set; }

        /// <summary>"movie" | "series" (absent for regular titles).</summary>
        [JsonProperty("animeFormat", NullValueHandling = NullValueHandling.Ignore)]
        public string AnimeFormat { get; set; }
    }

    /// <summary>Envelope of PUT /api/account/sync and DELETE /api/account/favorites.</summary>
    public class SyncWriteResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    /// <summary>Error envelope entry of a failed resolution.</summary>
    public class ResolverError
    {
        [JsonProperty("code")]
        public string Code { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }

    // ============================================================
    // Stremio addon streams (PRIORITY 1 playback source).
    //
    // Verified against the backend source on 2026-11:
    //   GET /api/downloader/mavero
    //        ?mediaType=movie|series|anime
    //        &contentId={catalog id}      ("movie-969681")
    //        &tmdbId={tmdb digits}        (bounded sanity check)
    //        [&season=N&episode=M]        (REQUIRED for series/anime)
    //     -> { ok, consideredAddons,
    //          groups: [ { addonId, addonName, addonSlug, addonOrdering,
    //                      status: "loaded" | "empty" | "failed",
    //                      errorCode?, streams: [AddonStream...] } ] }
    //
    // IMDB CONVERSION IS SERVER-SIDE (verified in
    // apps/web/src/lib/server/streaming/stremio/addon-download-service.ts):
    // Stremio addons are usually keyed by IMDb ids ("tt…"), but the
    // endpoint never accepts one from the client — the backend loads the
    // content detail (getDetail) and derives the identifiers itself
    // (normalizeContentIdentifiers), then builds each addon's video id
    // according to THAT addon's own idProperty/idPrefixes ("tt…" or
    // "tmdb:…"). The TV app therefore only echoes the TMDB digits
    // embedded in the catalog id — no IMDB lookup is ever needed here.
    //
    // Stream kind taxonomy (server-side classification, phase 17):
    //   http / https          direct file (mkv/mp4/webm/extensionless)
    //   hls                   m3u8 manifest (adaptive)
    //   dash                  mpd manifest (frequently DRM — not playable)
    //   p2p / magnet / external  not playable by AVPlay
    // quality: "4K" | "1080p" | "720p" | "480p" | "auto"
    // codec:   "H.264" | "HEVC" | "AV1" | "VP9" | "unknown"
    // ============================================================

    /// <summary>Envelope of GET /api/downloader/mavero.</summary>
    public class AddonStreamsResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        /// <summary>Enabled addons CONSIDERED for this title (the query baseline).</summary>
        [JsonProperty("consideredAddons")]
        public int ConsideredAddons { get; set; }

        [JsonProperty("groups")]
        public List<AddonStreamGroup> Groups { get; set; }
    }

    /// <summary>One addon's resolution result (per-addon status model).</summary>
    public class AddonStreamGroup
    {
        [JsonProperty("addonId")]
        public string AddonId { get; set; }

        [JsonProperty("addonName")]
        public string AddonName { get; set; }

        [JsonProperty("addonSlug")]
        public string AddonSlug { get; set; }

        [JsonProperty("addonOrdering")]
        public int AddonOrdering { get; set; }

        /// <summary>"loaded" | "empty" | "failed" (a failed addon never affects others).</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        /// <summary>Closed error-code vocabulary entry; present when status = "failed".</summary>
        [JsonProperty("errorCode")]
        public string ErrorCode { get; set; }

        [JsonProperty("streams")]
        public List<AddonStream> Streams { get; set; }
    }

    /// <summary>One addon-supplied stream (safe presentation view — the backend
    /// never exposes manifest URLs, addon configuration or auth tokens).</summary>
    public class AddonStream
    {
        /// <summary>The playable media URL (HLS manifest or direct file), verbatim.</summary>
        [JsonProperty("url")]
        public string Url { get; set; }

        /// <summary>"http" | "https" | "hls" | "dash" | "p2p" | "magnet" | "external".</summary>
        [JsonProperty("kind")]
        public string Kind { get; set; }

        /// <summary>"4K" | "1080p" | "720p" | "480p" | "auto".</summary>
        [JsonProperty("quality")]
        public string Quality { get; set; }

        /// <summary>"H.264" | "HEVC" | "AV1" | "VP9" | "unknown".</summary>
        [JsonProperty("codec")]
        public string Codec { get; set; }

        /// <summary>"multi" | "dual" | "mono" | "unknown" (audio class).</summary>
        [JsonProperty("audio")]
        public string Audio { get; set; }

        /// <summary>Addon-derived container label ("mkv", "mp4", ...); may be absent.</summary>
        [JsonProperty("container")]
        public string Container { get; set; }

        /// <summary>Release filename when the addon supplied one ("Title.2024.1080p.WEB.mkv").</summary>
        [JsonProperty("filename")]
        public string Filename { get; set; }

        /// <summary>Addon-supplied long title; may be absent.</summary>
        [JsonProperty("title")]
        public string Title { get; set; }

        /// <summary>Addon-supplied short name; may be absent.</summary>
        [JsonProperty("name")]
        public string Name { get; set; }

        /// <summary>Addon-supplied description (size/languages/seeders text); may be absent.</summary>
        [JsonProperty("description")]
        public string Description { get; set; }

        /// <summary>Reported size in bytes when the addon supplied one.</summary>
        [JsonProperty("sizeBytes")]
        public long? SizeBytes { get; set; }

        /// <summary>"http" | "https" | "magnet" | "external" transport classification.</summary>
        [JsonProperty("transport")]
        public string Transport { get; set; }

        /// <summary>Lowercased stream host (leading "www." stripped) for display.</summary>
        [JsonProperty("host")]
        public string Host { get; set; }

        /// <summary>Source addon's display name, stamped by ApiService while
        /// flattening the groups (never on the wire — drives the
        /// "Addon 1080p" selector labels).</summary>
        [JsonIgnore]
        public string AddonName { get; set; }

        /// <summary>True when the stream is an HLS manifest AVPlay plays natively.</summary>
        public bool IsHls
        {
            get { return string.Equals(Kind, "hls", StringComparison.OrdinalIgnoreCase); }
        }

        /// <summary>True when the stream is a direct HTTP(S) file download URL.</summary>
        public bool IsDirectFile
        {
            get
            {
                return string.Equals(Kind, "http", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(Kind, "https", StringComparison.OrdinalIgnoreCase);
            }
        }
    }
}
