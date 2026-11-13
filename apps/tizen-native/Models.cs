// ============================================================
// Mavero TV — API data models.
//
// These classes mirror the JSON that GET /api/tv/home returns.
// The server shape is produced by toMediaItem() in
// apps/web/src/lib/server/content/presenter.ts against the
// MediaItem type in apps/web/src/lib/data/content.ts — the
// camelCase keys below are the exact wire format (id/title/
// year/type/poster/...), NOT the pre-Phase-7 guesses
// (PosterPath/VoteAverage never existed on this endpoint).
// ============================================================
using System.Collections.Generic;
using Newtonsoft.Json;

namespace MaveroTv
{
    /// <summary>One media title on a home rail.</summary>
    public class MediaItem
    {
        /// <summary>Composite catalog id ("tmdb:movie:12345" style).</summary>
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
}
