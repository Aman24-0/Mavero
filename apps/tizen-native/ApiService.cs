// ============================================================
// Mavero TV — production API client.
//
// Fetches the TV home rails from the live production deployment
// (https://maveroweb.space/api/tv/home) and per-title detail
// records from https://maveroweb.space/api/content/{type}/{id}.
// Both endpoints compose the same cached TMDB-backed catalog
// services the web app uses, with CORS `*` and a public cache
// header — they were built exactly for this native TV client.
//
// Detail endpoint shape (verified live, 2026-11):
//   - ids are "{type}-{tmdbId}" ("movie-969681", "series-2734");
//   - the {type} path segment MUST come from the item's own type:
//     /api/content/movie/series-2734 silently returns a DIFFERENT
//     title instead of an error, so FetchDetailAsync derives the
//     segment from MediaItem.Type and never from a hardcoded one;
//   - response: { ok, item: { title, maturity, runtime, rating,
//     genres, description, backdrop, trailerKey, cast[] ... } }.
// ============================================================
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Tizen;

namespace MaveroTv
{
    /// <summary>HTTP client for the Mavero production API.</summary>
    public class ApiService
    {
        private readonly HttpClient _client;

        public ApiService()
        {
            _client = new HttpClient();
            _client.Timeout = TimeSpan.FromSeconds(20);
        }

        /// <summary>
        /// Fetches the home rails. Returns an empty list when the API is
        /// unreachable or reports a catalog outage (ok:false) — the UI
        /// keeps its honest empty state, never fake data.
        /// </summary>
        public async Task<List<TvRail>> FetchHomeRailsAsync()
        {
            string json = await _client.GetStringAsync(TvHomeUrl);

            TvHomeResponse response = JsonConvert.DeserializeObject<TvHomeResponse>(json);
            if (response == null || !response.Ok || response.Rails == null)
            {
                Log.Warn(LogTag, "TV home response empty or not ok");
                return new List<TvRail>();
            }

            return response.Rails;
        }

        /// <summary>
        /// Fetches the full detail record for one title. Returns null when
        /// the id is unknown or the catalog reports an outage — callers
        /// keep whatever rail-level data they already hold.
        /// </summary>
        public async Task<MediaDetail> FetchDetailAsync(MediaItem item)
        {
            string segment = DetailSegmentFor(item);
            string url = $"{ContentBaseUrl}/api/content/{segment}/{Uri.EscapeDataString(item.Id ?? string.Empty)}";

            string json = await _client.GetStringAsync(url);

            ContentDetailResponse response = JsonConvert.DeserializeObject<ContentDetailResponse>(json);
            if (response == null || !response.Ok || response.Item == null)
            {
                Log.Warn(LogTag, $"Detail response not ok for {segment}/{item.Id}");
                return null;
            }

            return response.Item;
        }

        /// <summary>
        /// Maps a catalog type onto the detail endpoint's path segment.
        /// The server matches strictly (a mismatched segment returns a
        /// wrong-but-valid item, not an error), so the segment must be
        /// the item's own type; movies are the safe default for legacy
        /// items without a type.
        /// </summary>
        private static string DetailSegmentFor(MediaItem item)
        {
            string type = (item.Type ?? string.Empty).Trim().ToLowerInvariant();
            return string.IsNullOrEmpty(type) ? "movie" : type;
        }

        /// <summary>Production origin serving the public TV API.</summary>
        public const string ContentBaseUrl = "https://maveroweb.space";

        /// <summary>Full home-rails endpoint (kept for log diagnostics).</summary>
        public const string TvHomeUrl = ContentBaseUrl + "/api/tv/home";

        /// <summary>dlog tag for all API logging.</summary>
        public const string LogTag = "MAVERO";
    }
}
