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
// ============================================================
using System.Collections.Generic;
using Newtonsoft.Json;

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

    /// <summary>Error envelope entry of a failed resolution.</summary>
    public class ResolverError
    {
        [JsonProperty("code")]
        public string Code { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }
}
