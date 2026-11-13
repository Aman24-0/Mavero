// ============================================================
// Mavero TV — production API client.
//
// Fetches from the live production deployment (https://maveroweb.space):
//   - GET  /api/tv/home                    -> home rails;
//   - GET  /api/content/{type}/{id}        -> per-title detail records;
//   - GET  /api/streaming/config           -> public server catalog
//        (providers + sources; sources[] are the user-facing servers,
//        each carrying capabilities.result_type "direct"|"embed");
//   - POST /api/playback/resolve           -> one playback resolution
//        ({ sourceId, contentId, mediaType, allowFallback } body ->
//        { ok, source: { type, url, qualities, metadata } }).
//
// Detail endpoint shape (verified live, 2026-11):
//   - ids are "{type}-{tmdbId}" ("movie-969681", "series-2734");
//   - the {type} path segment MUST come from the item's own type:
//     /api/content/movie/series-2734 silently returns a DIFFERENT
//     title instead of an error, so FetchDetailAsync derives the
//     segment from MediaItem.Type and never from a hardcoded one.
//
// Streaming shape (verified live, 2026-11): a "direct" resolution
// url is a playable stream (HLS/MP4 — Tizen's AVPlay handles both);
// an "embed" url is an HTML player page that the native player can
// only attempt. ResolveStreamAsync therefore prefers direct-capable
// servers and treats embeds as the last resort, mirroring the web
// player's source-priority rule.
// ============================================================
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
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
            _client.Timeout = TimeSpan.FromSeconds(30);
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
        /// Fetches the public server catalog and projects it into the
        /// ordered server list the player UI shows. Sources are filtered
        /// to enabled + public entries that support the title's media type
        /// (provider capabilities gate; unknown providers stay included),
        /// ordered by their configured ordering. Returns null when the
        /// config endpoint is unavailable.
        /// </summary>
        public async Task<StreamingSourceList> FetchStreamingSourcesAsync(string mediaType)
        {
            string json = await _client.GetStringAsync(StreamingConfigUrl);

            StreamingConfigResponse response = JsonConvert.DeserializeObject<StreamingConfigResponse>(json);
            if (response == null || !response.Ok || response.Config == null)
            {
                Log.Warn(LogTag, "Streaming config response empty or not ok");
                return null;
            }

            PublicStreamingConfig config = response.Config;
            Dictionary<string, PublicProvider> providersById = new Dictionary<string, PublicProvider>();
            if (config.Providers != null)
            {
                foreach (PublicProvider provider in config.Providers)
                {
                    if (provider != null && !string.IsNullOrEmpty(provider.Id))
                    {
                        providersById[provider.Id] = provider;
                    }
                }
            }

            List<ServerEntry> entries = new List<ServerEntry>();
            if (config.Sources != null)
            {
                foreach (PublicSource source in config.Sources)
                {
                    if (source == null || string.IsNullOrEmpty(source.Id) || !source.Enabled)
                    {
                        continue;
                    }

                    if (!string.Equals(source.Visibility, "public", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    PublicProvider provider = null;
                    providersById.TryGetValue(source.ProviderId, out provider);

                    // Media-type gate on the provider capabilities; sources of
                    // unknown providers stay included rather than silently hidden.
                    if (provider?.Capabilities != null && !SupportsMediaType(provider.Capabilities, mediaType))
                    {
                        continue;
                    }

                    // result_type: the source's own capabilities win; the
                    // provider's are the fallback; "embed" is the safe default.
                    string resultType =
                        NonEmpty(source.Capabilities?.ResultType) ??
                        NonEmpty(provider?.Capabilities?.ResultType) ??
                        "embed";

                    entries.Add(new ServerEntry
                    {
                        SourceId = source.Id,
                        Name = source.Name,
                        ResultType = resultType,
                        Status = source.Status,
                        Ordering = source.Ordering
                    });
                }
            }

            entries = entries.OrderBy(e => e.Ordering).ToList();

            string defaultSourceId = null;
            if (config.Defaults != null && !string.IsNullOrEmpty(mediaType))
            {
                config.Defaults.TryGetValue(mediaType.ToLowerInvariant(), out defaultSourceId);
            }

            Log.Info(LogTag,
                $"Streaming config: {entries.Count} server(s) for {mediaType}; " +
                $"default={(defaultSourceId ?? "none")}; " +
                $"direct-capable={entries.Count(e => e.IsDirect)}");

            return new StreamingSourceList
            {
                Entries = entries,
                DefaultSourceId = defaultSourceId
            };
        }

        /// <summary>
        /// Resolves one playback source. Returns null on any failure (HTTP
        /// error, !ok envelope, resolver error) — callers fall through to
        /// the next candidate and the UI keeps an honest status.
        /// </summary>
        public async Task<ResolvedSource> ResolveStreamAsync(string sourceId, string contentId, string mediaType, bool allowFallback)
        {
            Dictionary<string, object> body = new Dictionary<string, object>
            {
                ["sourceId"] = sourceId,
                ["contentId"] = contentId,
                ["mediaType"] = mediaType,
                ["allowFallback"] = allowFallback
            };

            string payload = JsonConvert.SerializeObject(body);
            using (StringContent content = new StringContent(payload, Encoding.UTF8, "application/json"))
            using (HttpResponseMessage httpResponse = await _client.PostAsync(PlaybackResolveUrl, content))
            {
                string json = await httpResponse.Content.ReadAsStringAsync();

                ResolveResponse response;
                try
                {
                    response = JsonConvert.DeserializeObject<ResolveResponse>(json);
                }
                catch (Exception ex)
                {
                    Log.Warn(LogTag, $"Resolve payload unparsable ({(int)httpResponse.StatusCode}): {ex.Message}");
                    return null;
                }

                if (response == null || !response.Ok || response.Source == null)
                {
                    string code = response?.Error?.Code ?? $"HTTP {(int)httpResponse.StatusCode}";
                    Log.Warn(LogTag, $"Resolve failed for {sourceId}: {code}");
                    return null;
                }

                return response.Source;
            }
        }

        private static bool SupportsMediaType(SourceCapabilities capabilities, string mediaType)
        {
            string type = (mediaType ?? string.Empty).Trim().ToLowerInvariant();
            switch (type)
            {
                case "series": return capabilities.Series;
                case "anime": return capabilities.Anime;
                default: return capabilities.Movie;
            }
        }

        private static string NonEmpty(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
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

        /// <summary>Public streaming server catalog endpoint.</summary>
        public const string StreamingConfigUrl = ContentBaseUrl + "/api/streaming/config";

        /// <summary>Playback resolution endpoint (POST).</summary>
        public const string PlaybackResolveUrl = ContentBaseUrl + "/api/playback/resolve";

        /// <summary>dlog tag for all API logging.</summary>
        public const string LogTag = "MAVERO";
    }

    /// <summary>The ordered server list the player UI consumes.</summary>
    public class StreamingSourceList
    {
        /// <summary>Enabled public servers, ordered by configured ordering.</summary>
        public List<ServerEntry> Entries { get; set; }

        /// <summary>Admin-configured default source id for the media type.</summary>
        public string DefaultSourceId { get; set; }
    }

    /// <summary>One user-facing server option (a projection of PublicSource).</summary>
    public class ServerEntry
    {
        public string SourceId { get; set; }

        public string Name { get; set; }

        /// <summary>"direct" | "embed" (from the source/provider capabilities).</summary>
        public string ResultType { get; set; }

        /// <summary>"active" | "experimental".</summary>
        public string Status { get; set; }

        public int Ordering { get; set; }

        /// <summary>True when resolution is expected to yield a playable stream.</summary>
        public bool IsDirect
        {
            get { return string.Equals(ResultType, "direct", StringComparison.OrdinalIgnoreCase); }
        }
    }
}
