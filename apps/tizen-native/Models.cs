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
}
