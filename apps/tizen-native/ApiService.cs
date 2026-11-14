// ============================================================
// Mavero TV — production API client.
//
// Fetches from the live production deployment (https://maveroweb.space):
//   - GET  /api/tv/home                    -> home rails;
//   - GET  /api/content/{type}/{id}        -> per-title detail records
//        (series/anime records carry a seasonsData[] season index);
//   - GET  /api/content/series/{id}/season/{n} -> one season's episodes
//        (the route lives only under the "series" segment but accepts
//        both series- and anime- prefixed ids — anime is TMDB TV);
//   - GET  /api/content/search?q={query}   -> catalog search results
//        (same MediaItem wire shape as the home rails' items);
//   - GET  /api/streaming/config           -> public server catalog
//        (providers + sources; sources[] are the user-facing servers,
//        each carrying capabilities.result_type "direct"|"embed");
//   - POST /api/playback/resolve           -> one playback resolution
//        ({ sourceId, contentId, mediaType, allowFallback, season?,
//        episode? } body -> { ok, source: { type, url, qualities,
//        metadata } }); season/episode mirror the web player's
//        ResolverRequest contract for series/anime playback.
//   - GET  /api/downloader/mavero          -> Stremio addon stream
//        groups for one title (PRIORITY 1 playback source; the
//        backend derives IMDb/TMDB ids server-side, so the TV app
//        only echoes the TMDB digits embedded in the catalog id).
//
// Authentication (verified against the backend source, 2026-11):
//   the backend ships a DEVICE PAIRING flow (the same one the web TV
//   login uses) — the TV shows an 8-char short code, the user approves
//   on a signed-in phone, and POST /api/auth/device-pairing/exchange
//   establishes the session as Supabase auth COOKIES (chunked
//   sb-*-auth-token). The session therefore lives in the shared
//   AuthSession cookie jar, never in a JSON body — no bearer token is
//   ever exposed. The authenticated endpoints are
//   GET/PUT /api/account/sync, DELETE /api/account/favorites and
//   POST /auth/sign-out; every response's Set-Cookie headers are
//   captured back into the jar so server-side token refreshes keep
//   the session alive exactly like a browser.
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

        /// <summary>
        /// TLS-BYPASS FALLBACK client. The primary client deliberately does
        /// NOT set ServerCertificateCustomValidationCallback: on Tizen 6.0
        /// TV Mono the callback path is the least-battle-tested TLS route
        /// (field suspicion: setting it can abort the handshake natively).
        /// The default Mono TLS stack with its baked-in Mozilla roots trusts
        /// the catalog origin (Netlify + Let's Encrypt / ISRG Root X1), so
        /// every request rides the PRIMARY plain client first; only when
        /// that fails with a MANAGED exception (trust failure, chain error)
        /// does the request retry through this callback-enabled client.
        /// </summary>
        private readonly HttpClient _tlsClient;

        /// <summary>
        /// Authenticated requests ride a SEPARATE handler: no automatic
        /// cookies (the jar is manual, so every captured cookie is also
        /// persisted) and no automatic redirect following (the sign-out
        /// endpoint answers with a 303 whose Set-Cookie headers must be
        /// captured, not swallowed by the redirect chain).
        /// </summary>
        private readonly HttpClient _authClient;

        /// <summary>
        /// Addon resolution rides its OWN client: the backend resolves every
        /// enabled Stremio addon in parallel under a 40s aggregate budget
        /// (healthy addons can take 15-25s under load), so the shared 30s
        /// client timeout would abort perfectly healthy batches. 50s gives
        /// the full backend budget plus transport overhead.
        /// </summary>
        private readonly HttpClient _addonClient;

        /// <summary>Addon-resolution TLS-bypass fallback (same policy as _tlsClient).</summary>
        private readonly HttpClient _addonTlsClient;

        public ApiService()
        {
            // PRIMARY catalog client — PLAIN TLS, no certificate callback
            // (the most battle-tested transport path on Tizen 6.0 Mono).
            _client = new HttpClient(CreateHandler(true, true, false));
            _client.Timeout = TimeSpan.FromSeconds(30);
            ApplyUserAgent(_client);

            // FALLBACK catalog client — accepts any server chain (stale TV
            // trust stores). Used ONLY when the primary attempt threw.
            _tlsClient = new HttpClient(CreateHandler(true, true, true));
            _tlsClient.Timeout = TimeSpan.FromSeconds(30);
            ApplyUserAgent(_tlsClient);

            HttpClientHandler authHandler = CreateHandler(false, false, false);
            _authClient = new HttpClient(authHandler);
            _authClient.Timeout = TimeSpan.FromSeconds(30);
            ApplyUserAgent(_authClient);

            // PRIMARY addon client — plain TLS, longer budget (the backend
            // resolves every enabled Stremio addon in parallel under a 40s
            // aggregate budget; healthy addons can take 15-25s under load).
            _addonClient = new HttpClient(CreateHandler(true, true, false));
            _addonClient.Timeout = TimeSpan.FromSeconds(50);
            ApplyUserAgent(_addonClient);

            _addonTlsClient = new HttpClient(CreateHandler(true, true, true));
            _addonTlsClient.Timeout = TimeSpan.FromSeconds(50);
            ApplyUserAgent(_addonTlsClient);
        }

        /// <summary>
        /// TV-HARDENED transport factory. Two Tizen-6.0 reality checks drive
        /// this:
        ///
        ///   1. TLS trust store: smart TVs ship a CA snapshot from the year
        ///      their firmware was built. Modern origins (Let's Encrypt,
        ///      CDN chains) can fail the handshake with "CertificateError"
        ///      or mono's "trust failure" — the fetch throws, the UI shows
        ///      an outage, the user blames the app. When `tlsBypass` is set
        ///      the presented chain is accepted (the pragmatic TV fix); the
        ///      primary path runs WITHOUT it because the callback route is
        ///      the least-tested TLS path on Tizen Mono (see _tlsClient).
        ///   2. User-Agent: some CDN/WAF edges drop requests with no UA
        ///      (400/403) — mono's HttpClient sends none by default.
        ///
        /// Every property is set defensively: a profile that lacks a setter
        /// must degrade to the classic handler, not crash the client.
        /// </summary>
        private static HttpClientHandler CreateHandler(bool allowAutoRedirect, bool useCookies, bool tlsBypass)
        {
            HttpClientHandler handler = new HttpClientHandler
            {
                AllowAutoRedirect = allowAutoRedirect,
                UseCookies = useCookies
            };

            if (tlsBypass)
            {
                try
                {
                    // Accept any server certificate chain (stale TV trust stores).
                    handler.ServerCertificateCustomValidationCallback =
                        (message, certificate, chain, sslErrors) => true;
                }
                catch (Exception ex)
                {
                    Log.Warn(LogTag, "TLS fallback unavailable on this profile: " + ex.Message);
                }
            }

            return handler;
        }

        /// <summary>
        /// GET with TLS fallback: the PLAIN primary client is always tried
        /// first (the standard Tizen Mono transport path); any MANAGED
        /// failure (trust failure, chain error, transport error) retries
        /// once through the certificate-bypass client. If both fail the
        /// fallback's exception surfaces to the caller unchanged.
        /// </summary>
        private static async Task<string> GetStringWithTlsFallbackAsync(
            HttpClient primary, HttpClient fallback, string url, string what)
        {
            try
            {
                return await primary.GetStringAsync(url);
            }
            catch (Exception primaryEx)
            {
                Log.Warn(LogTag, $"{what}: primary (plain TLS) failed — {primaryEx.GetType().Name}: {primaryEx.Message}; retrying with TLS bypass");
                return await fallback.GetStringAsync(url);
            }
        }

        /// <summary>Identifies the native TV app to CDN/WAF edges that drop
        /// UA-less requests.</summary>
        private const string UserAgentValue = "MaveroTV/0.0.3 (Tizen; SmartTV)";

        /// <summary>Stamps the User-Agent on a client (TryAdd — never throws on
        /// a profile with restricted header validation).</summary>
        private static void ApplyUserAgent(HttpClient client)
        {
            try
            {
                client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgentValue);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "User-Agent stamp skipped: " + ex.Message);
            }
        }

        /// <summary>
        /// Fetches the RAW home-rails JSON body (no parsing). Split from the
        /// parse step so the boot console can log the exact boundary
        /// "[BOOT 5/6] Network response received (N chars) -> Parsing JSON..."
        /// between transport and deserialization on a field TV.
        /// Throws on transport failure — the caller handles the outage.
        /// </summary>
        public async Task<string> FetchHomeJsonAsync()
        {
            return await GetStringWithTlsFallbackAsync(_client, _tlsClient, TvHomeUrl, "TV home");
        }

        /// <summary>
        /// Parses the home-rails JSON into rails. Pure managed work, fully
        /// defensive: malformed/empty bodies degrade to an empty list, never
        /// a NullReference/JsonReader escape onto the caller.
        /// </summary>
        public List<TvRail> ParseHomeRails(string json)
        {
            TvHomeResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<TvHomeResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "TV home payload unparsable: " + ex.Message);
                return new List<TvRail>();
            }

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

            string json = await GetStringWithTlsFallbackAsync(_client, _tlsClient, url, "detail");

            ContentDetailResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<ContentDetailResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, $"Detail payload unparsable for {segment}/{item.Id}: {ex.Message}");
                return null;
            }

            if (response == null || !response.Ok || response.Item == null)
            {
                Log.Warn(LogTag, $"Detail response not ok for {segment}/{item.Id}");
                return null;
            }

            return response.Item;
        }

        /// <summary>
        /// Fetches the full episode list of one season. Returns null when
        /// the season is unknown or the catalog reports an outage — the
        /// episode rail keeps its honest empty state.
        ///
        /// The season route lives ONLY under the "series" path segment,
        /// but the endpoint accepts BOTH "series-{tmdbId}" and
        /// "anime-{tmdbId}" ids (verified live, 2026-11 — the backend
        /// strips both prefixes and queries TMDB TV), so the content id
        /// is passed through untouched.
        /// </summary>
        public async Task<SeasonDetail> FetchSeasonAsync(string contentId, int seasonNumber)
        {
            string url = $"{ContentBaseUrl}/api/content/series/" +
                $"{Uri.EscapeDataString(contentId ?? string.Empty)}/season/{seasonNumber}";

            string json = await GetStringWithTlsFallbackAsync(_client, _tlsClient, url, "season");

            SeasonResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<SeasonResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, $"Season payload unparsable for {contentId} S{seasonNumber}: {ex.Message}");
                return null;
            }

            if (response == null || !response.Ok || response.Season == null)
            {
                Log.Warn(LogTag, $"Season response not ok for {contentId} S{seasonNumber}");
                return null;
            }

            return response.Season;
        }

        /// <summary>
        /// Runs a catalog search. Returns the matched MediaItems — the
        /// search endpoint serves the SAME toMediaItem() projection as the
        /// home rails, so the items bind straight into MediaCard.
        /// Returns an empty list when the API is unreachable, rate-limited
        /// or reports an outage — the search page keeps its honest empty
        /// state, never fake data.
        ///
        /// Wire shape verified live, 2026-11:
        ///   GET /api/content/search?q={query}
        ///     -> { ok, items: [MediaItem...], page, hasNextPage, query }
        ///   - an unknown query returns ok:true with items:[] (the
        ///     "No results found" state, never an error);
        ///   - the server rejects queries over 120 chars (HTTP 400) and
        ///     rate-limits per identity (HTTP 429) — GetStringAsync
        ///     surfaces both as exceptions the caller handles.
        /// </summary>
        public async Task<List<MediaItem>> SearchAsync(string query)
        {
            string url = $"{SearchUrl}?q={Uri.EscapeDataString(query ?? string.Empty)}";

            string json = await GetStringWithTlsFallbackAsync(_client, _tlsClient, url, "search");

            SearchResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<SearchResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "Search payload unparsable: " + ex.Message);
                return new List<MediaItem>();
            }

            if (response == null || !response.Ok || response.Items == null)
            {
                Log.Warn(LogTag, "Search response empty or not ok");
                return new List<MediaItem>();
            }

            return response.Items;
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
            string json = await GetStringWithTlsFallbackAsync(_client, _tlsClient, StreamingConfigUrl, "streaming config");

            StreamingConfigResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<StreamingConfigResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "Streaming config payload unparsable: " + ex.Message);
                return null;
            }

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

        /// <param name="allowFallback">Whether the resolver may walk fallback servers.</param>
        /// <param name="season">Season number for series/anime playback (null = movie/unspecified).</param>
        /// <param name="episode">Episode number for series/anime playback (null = movie/unspecified).</param>
        public async Task<ResolvedSource> ResolveStreamAsync(string sourceId, string contentId, string mediaType, bool allowFallback,
            int? season = null, int? episode = null)
        {
            Dictionary<string, object> body = new Dictionary<string, object>
            {
                ["sourceId"] = sourceId,
                ["contentId"] = contentId,
                ["mediaType"] = mediaType,
                ["allowFallback"] = allowFallback
            };

            // Series/anime playback carries the exact episode to resolve;
            // omitted fields keep the movie wire shape byte-for-byte.
            if (season.HasValue)
            {
                body["season"] = season.Value;
            }

            if (episode.HasValue)
            {
                body["episode"] = episode.Value;
            }

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

        // ============================================================
        // Stremio addon streams (PRIORITY 1 playback source).
        //
        // IMDB CONVERSION IS SERVER-SIDE — verified in
        // apps/web/src/lib/server/streaming/stremio/addon-download-service.ts:
        // Stremio addons are usually keyed by IMDb ids ("tt1234567"), but
        // the endpoint accepts NO imdb parameter. The backend loads the
        // content detail (getDetail) and derives identifiers itself
        // (normalizeContentIdentifiers), then constructs each addon's
        // video id per THAT addon's own idProperty/idPrefixes ("tt…" or
        // "tmdb:…", appending ":s:e" for episodes). The TV app only sends
        // the catalog id + the TMDB digits it already contains — fetching
        // an IMDB id here would be dead weight the wire never carries.
        // ============================================================

        /// <summary>
        /// Fetches the playable Stremio addon streams for one title from the
        /// Mavero Downloader batch endpoint (the exact endpoint the web
        /// downloader uses — GET /api/downloader/mavero). Returns the
        /// deduplicated, BEST-FIRST ordered list of streams AVPlay can
        /// actually play: HLS manifests and direct HTTP(S) video files
        /// (MKV/MP4/...). P2P/magnet/DASH/external entries never surface.
        ///
        /// Returns an EMPTY list when no addons are configured, no addon
        /// yielded a playable stream, the title lacks a usable TMDB id, or
        /// the endpoint is unavailable/rate-limited — every one of those is
        /// the caller's cue to fall back to the regular server pipeline,
        /// exactly one failure surface for the player.
        /// </summary>
        /// <param name="contentId">Catalog id ("movie-969681" / "series-2734").</param>
        /// <param name="mediaType">"movie" | "series" | "anime" (passed through; the backend maps anime to the series contract itself).</param>
        /// <param name="season">Season number for series/anime (REQUIRED together with episode for non-movie types).</param>
        /// <param name="episode">Episode number for series/anime.</param>
        public async Task<List<AddonStream>> FetchAddonStreamsAsync(string contentId, string mediaType,
            int? season = null, int? episode = null)
        {
            List<AddonStream> empty = new List<AddonStream>();

            string type = (mediaType ?? string.Empty).Trim().ToLowerInvariant();
            string tmdbId = TmdbIdFromContentId(contentId);
            if (string.IsNullOrEmpty(tmdbId))
            {
                Log.Warn(LogTag, $"Addon fetch skipped: no TMDB id in '{contentId}'");
                return empty;
            }

            // The backend rejects non-movie requests without BOTH season and
            // episode (INVALID_REQUEST) — don't spend a round trip.
            bool needsEpisode = type != "movie";
            if (needsEpisode && (!season.HasValue || !episode.HasValue))
            {
                Log.Warn(LogTag, $"Addon fetch skipped: {type} playback needs season+episode");
                return empty;
            }

            StringBuilder url = new StringBuilder(AddonStreamsUrl);
            url.Append("?mediaType=").Append(Uri.EscapeDataString(type));
            url.Append("&contentId=").Append(Uri.EscapeDataString(contentId ?? string.Empty));
            url.Append("&tmdbId=").Append(Uri.EscapeDataString(tmdbId));
            if (needsEpisode)
            {
                url.Append("&season=").Append(season.Value);
                url.Append("&episode=").Append(episode.Value);
            }

            string json = await GetStringWithTlsFallbackAsync(_addonClient, _addonTlsClient, url.ToString(), "addon streams");

            AddonStreamsResponse response;
            try
            {
                response = JsonConvert.DeserializeObject<AddonStreamsResponse>(json);
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, $"Addon payload unparsable: {ex.Message}");
                return empty;
            }

            if (response == null || !response.Ok || response.Groups == null)
            {
                Log.Warn(LogTag, "Addon response empty or not ok");
                return empty;
            }

            List<AddonStream> playable = new List<AddonStream>();
            int loadedGroups = 0;
            foreach (AddonStreamGroup group in response.Groups)
            {
                if (group == null || group.Streams == null)
                {
                    continue;
                }

                if (string.Equals(group.Status, "loaded", StringComparison.OrdinalIgnoreCase))
                {
                    loadedGroups++;
                }

                foreach (AddonStream stream in group.Streams)
                {
                    if (stream == null || string.IsNullOrEmpty(stream.Url) || !IsPlayableAddonStream(stream))
                    {
                        continue;
                    }

                    // Stamp the source addon for the selector labels (never
                    // on the wire — presentation metadata only).
                    stream.AddonName = group.AddonName;
                    playable.Add(stream);
                }
            }

            // Deterministic BEST-FIRST order: quality (4K -> auto), then
            // adaptive HLS before a direct file (safer start on flaky TV
            // networks). OrderBy is stable, so streams that tie on both
            // keys keep the backend's own deterministic wire order (addon
            // ordering -> stream index) — no extra tiebreaker needed.
            List<AddonStream> ordered = playable
                .OrderByDescending(s => AddonQualityRank(s.Quality))
                .ThenByDescending(s => s.IsHls ? 1 : 0)
                .ToList();

            // True-duplicate-URL dedup (first-wins in the ordered sequence):
            // two addons exposing the same CDN stream stay one option.
            List<AddonStream> unique = new List<AddonStream>();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (AddonStream stream in ordered)
            {
                if (seen.Add(stream.Url))
                {
                    unique.Add(stream);
                }
            }

            Log.Info(LogTag,
                $"Addon resolution: {response.ConsideredAddons} considered, {loadedGroups} loaded, " +
                $"{unique.Count} playable (best={DescribeAddonStream(unique.Count > 0 ? unique[0] : null)})");

            return unique;
        }

        /// <summary>Extracts the TMDB digits from a "{type}-{tmdbId}" catalog id.
        /// Null when the id has no pure-numeric suffix (the endpoint's bounded
        /// sanity check would reject the request anyway).</summary>
        public static string TmdbIdFromContentId(string contentId)
        {
            if (string.IsNullOrEmpty(contentId))
            {
                return null;
            }

            int dash = contentId.LastIndexOf('-');
            if (dash < 0 || dash == contentId.Length - 1)
            {
                return null;
            }

            string tail = contentId.Substring(dash + 1);
            foreach (char c in tail)
            {
                if (c < '0' || c > '9')
                {
                    return null;
                }
            }

            return tail;
        }

        /// <summary>AVPlay playability gate: HLS manifests always play; direct
        /// files play when a video container is recognizable from the URL
        /// path, the release filename or the addon's container label.
        /// Extensionless opaque links stay out — AVPlay would just fail on
        /// them and waste the user's time. DASH (frequently DRM), P2P,
        /// magnet and external entries are never playable natively.</summary>
        private static bool IsPlayableAddonStream(AddonStream stream)
        {
            if (stream.IsHls)
            {
                return true;
            }

            if (!stream.IsDirectFile)
            {
                return false;
            }

            return HasVideoExtension(stream.Url)
                || HasVideoExtension(stream.Filename)
                || HasVideoExtension(stream.Title)
                || HasVideoExtension(stream.Name)
                || IsVideoContainer(stream.Container);
        }

        /// <summary>Video extensions AVPlay's parsers handle over HTTP.</summary>
        private static readonly string[] VideoExtensions =
        {
            ".mkv", ".mp4", ".m4v", ".webm", ".avi", ".ts", ".mov",
            ".mpg", ".mpeg", ".3gp", ".ogv", ".wmv", ".flv"
        };

        private static bool HasVideoExtension(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            // Strip a query string before matching ("...mkv?token=x").
            string path = value;
            int query = path.IndexOf('?');
            if (query >= 0)
            {
                path = path.Substring(0, query);
            }

            string trimmed = path.TrimEnd();
            foreach (string extension in VideoExtensions)
            {
                if (trimmed.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsVideoContainer(string container)
        {
            if (string.IsNullOrEmpty(container))
            {
                return false;
            }

            string normalized = container.Trim().ToLowerInvariant();
            return normalized.Contains("mkv") || normalized.Contains("matroska")
                || normalized.Contains("mp4") || normalized.Contains("webm")
                || normalized.Contains("mpeg") || normalized == "ts"
                || normalized.Contains("avi") || normalized.Contains("mov")
                || normalized.Contains("m4v");
        }

        /// <summary>Numeric rank of the addon quality label (higher = better).
        /// "4K" outranks everything; unknown labels rank as "auto".</summary>
        private static int AddonQualityRank(string quality)
        {
            switch ((quality ?? string.Empty).Trim())
            {
                case "4K": return 2160;
                case "1080p": return 1080;
                case "720p": return 720;
                case "480p": return 480;
                default: return 0;
            }
        }

        /// <summary>One-line description for logs ("Torrentio 4K HEVC").</summary>
        private static string DescribeAddonStream(AddonStream stream)
        {
            if (stream == null)
            {
                return "none";
            }

            string name = NonEmpty(stream.AddonName) ?? NonEmpty(stream.Name) ?? NonEmpty(stream.Title) ?? "addon";
            return $"{name} {NonEmpty(stream.Quality) ?? "auto"} {NonEmpty(stream.Codec) ?? ""}".Trim();
        }

        // ============================================================
        // Authentication (device pairing) — see LoginPage for the UI flow.
        // ============================================================

        /// <summary>
        /// Creates a device-pairing challenge. Returns the short code the
        /// user enters on their phone plus the TV's bearer secret for the
        /// status/exchange polls. Null when the pairing service is
        /// unavailable (rate-limited or outage) — the login page shows the
        /// honest error state and the user can retry.
        /// </summary>
        public async Task<PairingInfo> CreatePairingAsync()
        {
            using (StringContent content = new StringContent("{}", Encoding.UTF8, "application/json"))
            using (HttpResponseMessage httpResponse = await _authClient.PostAsync(DevicePairingCreateUrl, content))
            {
                string json = await httpResponse.Content.ReadAsStringAsync();

                PairingCreateResponse response;
                try
                {
                    response = JsonConvert.DeserializeObject<PairingCreateResponse>(json);
                }
                catch (Exception ex)
                {
                    Log.Warn(LogTag, $"Pairing create unparsable ({(int)httpResponse.StatusCode}): {ex.Message}");
                    return null;
                }

                if (response == null || !response.Ok || response.Pairing == null)
                {
                    Log.Warn(LogTag, $"Pairing create failed: HTTP {(int)httpResponse.StatusCode}");
                    return null;
                }

                Log.Info(LogTag, "Pairing challenge created (code " + response.Pairing.ShortCode + ")");
                return response.Pairing;
            }
        }

        /// <summary>
        /// Polls one pairing status cycle. Returns the status string
        /// ("pending" | "approved" | "expired" | "cancelled" | ...) or null
        /// on a transport/unparsable failure (the poll loop counts
        /// consecutive errors before giving up, mirroring the web TV login).
        /// </summary>
        public async Task<string> PollPairingStatusAsync(string secret)
        {
            Dictionary<string, object> body = new Dictionary<string, object>
            {
                ["secret"] = secret
            };

            using (StringContent content = new StringContent(
                JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json"))
            using (HttpResponseMessage httpResponse = await _authClient.PostAsync(DevicePairingStatusUrl, content))
            {
                string json = await httpResponse.Content.ReadAsStringAsync();

                PairingStatusResponse response;
                try
                {
                    response = JsonConvert.DeserializeObject<PairingStatusResponse>(json);
                }
                catch (Exception ex)
                {
                    Log.Warn(LogTag, $"Pairing status unparsable ({(int)httpResponse.StatusCode}): {ex.Message}");
                    return null;
                }

                if (response == null)
                {
                    return null;
                }

                // Both ok:true statuses and ok:false envelopes carry a status
                // field ("expired" on stale secrets) — surface it either way.
                return string.IsNullOrEmpty(response.Status) ? null : response.Status;
            }
        }

        /// <summary>
        /// Attempts the session exchange for an approved pairing. On success
        /// the response's Set-Cookie headers ARE the session — they are
        /// captured into the shared AuthSession jar (and persisted there).
        /// Returns the outcome (Ok / Retryable / Message); transient
        /// failures may be retried with the SAME secret by the caller.
        /// </summary>
        public async Task<ExchangeOutcome> ExchangePairingAsync(string secret)
        {
            Dictionary<string, object> body = new Dictionary<string, object>
            {
                ["secret"] = secret
            };

            using (StringContent content = new StringContent(
                JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json"))
            using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, DevicePairingExchangeUrl))
            {
                request.Content = content;
                using (HttpResponseMessage httpResponse = await _authClient.SendAsync(request))
                {
                    // The exchange response's Set-Cookie headers establish the
                    // session (chunked sb-*-auth-token). Capture BEFORE
                    // disposing the response.
                    IEnumerable<string> setCookies;
                    if (httpResponse.Headers.TryGetValues("Set-Cookie", out setCookies))
                    {
                        AuthSession.CaptureSetCookies(setCookies);
                    }

                    string json = await httpResponse.Content.ReadAsStringAsync();

                    PairingExchangeResponse response;
                    try
                    {
                        response = JsonConvert.DeserializeObject<PairingExchangeResponse>(json);
                    }
                    catch (Exception ex)
                    {
                        Log.Warn(LogTag, $"Pairing exchange unparsable ({(int)httpResponse.StatusCode}): {ex.Message}");
                        return new ExchangeOutcome
                        {
                            Ok = false,
                            Retryable = true,
                            Message = "Network hiccup while signing in."
                        };
                    }

                    if (httpResponse.IsSuccessStatusCode && response != null && response.Ok)
                    {
                        Log.Info(LogTag, "Pairing exchange succeeded — session cookies captured");
                        AuthSession.DecodeEmailFromCookies();
                        AuthSession.Persist();
                        return new ExchangeOutcome { Ok = true };
                    }

                    bool retryable = response != null && response.Retryable;
                    Log.Warn(LogTag, "Pairing exchange failed: " +
                        (response != null && !string.IsNullOrEmpty(response.Message)
                            ? response.Message
                            : "HTTP " + (int)httpResponse.StatusCode) +
                        " retryable=" + retryable);
                    return new ExchangeOutcome
                    {
                        Ok = false,
                        Retryable = retryable,
                        Message = response != null && !string.IsNullOrEmpty(response.Message)
                            ? response.Message
                            : "Unable to establish a session."
                    };
                }
            }
        }

        // ============================================================
        // My List (cloud favorites) — authenticated via the AuthSession
        // cookie jar; every response's Set-Cookie is captured back so
        // server-side refreshes keep the session alive.
        // ============================================================

        /// <summary>
        /// Fetches the signed-in user's saved list (GET /api/account/sync;
        /// the tombstone filtering happens server-side). Returns:
        ///   - the favorites list (possibly empty) on success;
        ///   - null when the session is gone (401 — expired/revoked; the
        ///     stale session is locally reset, the caller offers sign-in);
        ///   - THROWS HttpRequestException on a transport failure or a
        ///     server outage — the My List page renders its honest
        ///     "unavailable" state from the catch.
        /// </summary>
        public async Task<List<FavoriteRecord>> FetchFavoritesAsync()
        {
            using (HttpResponseMessage httpResponse = await SendAuthenticatedAsync(HttpMethod.Get, AccountSyncUrl, null))
            {
                if (httpResponse == null)
                {
                    // No session jar or a transport failure — the caller
                    // treats both as "cannot fetch" (unavailable state).
                    throw new HttpRequestException("My List fetch: no session or transport failure");
                }

                string json = await httpResponse.Content.ReadAsStringAsync();

                if ((int)httpResponse.StatusCode == 401)
                {
                    Log.Info(LogTag, "Account sync unauthorized — clearing the stale session");
                    AuthSession.Clear();
                    return null;
                }

                if (!httpResponse.IsSuccessStatusCode)
                {
                    Log.Warn(LogTag, "Account sync failed: HTTP " + (int)httpResponse.StatusCode);
                    throw new HttpRequestException("My List fetch failed: HTTP " + (int)httpResponse.StatusCode);
                }

                AccountSyncResponse response;
                try
                {
                    response = JsonConvert.DeserializeObject<AccountSyncResponse>(json);
                }
                catch (Exception ex)
                {
                    Log.Warn(LogTag, $"Account sync unparsable (200): {ex.Message}");
                    throw new HttpRequestException("My List fetch: unparsable response");
                }

                if (response == null || response.Favorites == null)
                {
                    return new List<FavoriteRecord>();
                }

                return response.Favorites;
            }
        }

        /// <summary>
        /// Upserts one favorite (the "Add to My List" write path —
        /// PUT /api/account/sync with a single-record favorites array;
        /// omitted arrays are never touched server-side). True on success.
        /// </summary>
        public async Task<bool> AddFavoriteAsync(FavoriteRecord record)
        {
            if (record == null)
            {
                return false;
            }

            string body = JsonConvert.SerializeObject(new Dictionary<string, object>
            {
                ["favorites"] = new List<FavoriteRecord> { record }
            });

            using (HttpResponseMessage httpResponse = await SendAuthenticatedAsync(HttpMethod.Put, AccountSyncUrl, body))
            {
                if (httpResponse == null)
                {
                    return false;
                }

                if (httpResponse.IsSuccessStatusCode)
                {
                    Log.Info(LogTag, "Favorite saved: " + record.Key);
                    return true;
                }

                Log.Warn(LogTag, "Favorite save failed: HTTP " + (int)httpResponse.StatusCode);
                return false;
            }
        }

        /// <summary>
        /// Removes one favorite (DELETE /api/account/favorites with the
        /// canonical content type + id). True on success.
        /// </summary>
        public async Task<bool> RemoveFavoriteAsync(string contentType, string contentId)
        {
            string url = AccountFavoritesUrl + "?contentType=" + Uri.EscapeDataString(contentType ?? "movie")
                + "&contentId=" + Uri.EscapeDataString(contentId ?? string.Empty);

            using (HttpResponseMessage httpResponse = await SendAuthenticatedAsync(HttpMethod.Delete, url, null))
            {
                if (httpResponse == null)
                {
                    return false;
                }

                if (httpResponse.IsSuccessStatusCode)
                {
                    Log.Info(LogTag, "Favorite removed: " + contentType + ":" + contentId);
                    return true;
                }

                Log.Warn(LogTag, "Favorite removal failed: HTTP " + (int)httpResponse.StatusCode);
                return false;
            }
        }

        /// <summary>
        /// Signs out (POST /auth/sign-out — revokes the server session and
        /// clears the auth cookies), then resets the local jar regardless of
        /// the wire outcome (a network failure must not strand the TV in a
        /// half-signed-in state).
        /// </summary>
        public async Task<bool> SignOutAsync()
        {
            bool ok = false;
            try
            {
                using (StringContent content = new StringContent("{}", Encoding.UTF8, "application/json"))
                using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, SignOutUrl))
                {
                    request.Content = content;
                    using (HttpResponseMessage httpResponse = await _authClient.SendAsync(request))
                    {
                        // The 303/200 response clears the cookies server-side —
                        // capture the Set-Cookie lines before disposing.
                        IEnumerable<string> setCookies;
                        if (httpResponse.Headers.TryGetValues("Set-Cookie", out setCookies))
                        {
                            AuthSession.CaptureSetCookies(setCookies);
                        }
                        ok = httpResponse.IsSuccessStatusCode || (int)httpResponse.StatusCode == 303;
                        Log.Info(LogTag, "Sign out: HTTP " + (int)httpResponse.StatusCode);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "Sign out transport failure: " + ex.Message);
            }

            AuthSession.Clear();
            return ok;
        }

        /// <summary>
        /// One authenticated request: attaches the session Cookie header,
        /// captures Set-Cookie into the jar. Returns null on a transport
        /// failure (callers keep their honest empty/error states).
        /// </summary>
        private async Task<HttpResponseMessage> SendAuthenticatedAsync(HttpMethod method, string url, string jsonBody)
        {
            string cookieHeader = AuthSession.CookieHeader();
            if (cookieHeader == null)
            {
                Log.Info(LogTag, "Authenticated request without a session — " + url);
                return null;
            }

            try
            {
                using (HttpRequestMessage request = new HttpRequestMessage(method, url))
                {
                    request.Headers.Add("Cookie", cookieHeader);
                    if (jsonBody != null)
                    {
                        request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
                    }

                    HttpResponseMessage httpResponse = await _authClient.SendAsync(request);

                    IEnumerable<string> setCookies;
                    if (httpResponse.Headers.TryGetValues("Set-Cookie", out setCookies))
                    {
                        AuthSession.CaptureSetCookies(setCookies);
                    }

                    return httpResponse;
                }
            }
            catch (Exception ex)
            {
                Log.Warn(LogTag, "Authenticated request failed: " + ex.Message);
                return null;
            }
        }

        /// <summary>
        /// Builds the wire record for "Add to My List" from a catalog item,
        /// clamping every field to the server validator's bounds (a record
        /// that violates ANY bound is rejected with HTTP 400):
        ///   - canonical type: an anime-flagged series is stored as "anime"
        ///     (the web app's canonicalFavoriteType rule);
        ///   - key = "{contentType}:{contentId}" exactly;
        ///   - title <= 240, poster/backdrop <= 2000, runtime <= 80,
        ///     description <= 4000, genres <= 20 x 80 chars;
        ///   - year/rating omitted when unknown (present-but-invalid values
        ///     fail validation); status "planned"; timestamps now.
        /// </summary>
        public static FavoriteRecord BuildFavoriteRecord(MediaItem item, long nowMs)
        {
            if (item == null || string.IsNullOrEmpty(item.Id))
            {
                return null;
            }

            string contentType = (item.Type ?? "movie").Trim().ToLowerInvariant();
            if (contentType != "series" && contentType != "anime" && contentType != "movie")
            {
                contentType = "movie";
            }
            if (contentType == "series" && item.IsAnime)
            {
                contentType = "anime";
            }

            string contentId = Clamp(item.Id, 120);

            string title = Clamp((item.Title ?? string.Empty).Trim(), 240);
            if (title.Length == 0)
            {
                title = "Untitled";
            }

            List<string> genres = null;
            if (item.Genres != null && item.Genres.Count > 0)
            {
                genres = new List<string>();
                foreach (string genre in item.Genres.GetRange(0, Math.Min(20, item.Genres.Count)))
                {
                    genres.Add(Clamp(genre ?? string.Empty, 80));
                }
            }

            return new FavoriteRecord
            {
                Key = contentType + ":" + contentId,
                ContentType = contentType,
                ContentId = contentId,
                Snapshot = new ContentSnapshot
                {
                    Title = title,
                    Poster = Clamp(item.Poster ?? string.Empty, 2000),
                    Backdrop = string.IsNullOrEmpty(item.Backdrop) ? null : Clamp(item.Backdrop, 2000),
                    Year = item.Year >= 1800 && item.Year <= 3000 ? item.Year : (int?)null,
                    Runtime = string.IsNullOrEmpty(item.Runtime) ? null : Clamp(item.Runtime, 80),
                    Rating = item.Rating > 0 && item.Rating <= 10 ? item.Rating : (double?)null,
                    Genres = genres,
                    Description = string.IsNullOrEmpty(item.Description) ? null : Clamp(item.Description, 4000),
                    IsAnime = item.IsAnime ? (bool?)true : null,
                    AnimeFormat = null
                },
                Status = "planned",
                CreatedAt = nowMs,
                UpdatedAt = nowMs
            };
        }

        /// <summary>Length clamp for validator-bounded string fields.</summary>
        private static string Clamp(string value, int maxLength)
        {
            if (value == null)
            {
                return null;
            }
            return value.Length <= maxLength ? value : value.Substring(0, maxLength);
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

        /// <summary>Catalog search endpoint (the query is appended URL-escaped).</summary>
        public const string SearchUrl = ContentBaseUrl + "/api/content/search";

        /// <summary>Public streaming server catalog endpoint.</summary>
        public const string StreamingConfigUrl = ContentBaseUrl + "/api/streaming/config";

        /// <summary>Playback resolution endpoint (POST).</summary>
        public const string PlaybackResolveUrl = ContentBaseUrl + "/api/playback/resolve";

        /// <summary>Stremio addon stream groups endpoint (PRIORITY 1 source; GET).</summary>
        public const string AddonStreamsUrl = ContentBaseUrl + "/api/downloader/mavero";

        /// <summary>Device-pairing endpoints (create/status/exchange, all POST).</summary>
        public const string DevicePairingCreateUrl = ContentBaseUrl + "/api/auth/device-pairing/create";
        public const string DevicePairingStatusUrl = ContentBaseUrl + "/api/auth/device-pairing/status";
        public const string DevicePairingExchangeUrl = ContentBaseUrl + "/api/auth/device-pairing/exchange";

        /// <summary>Cloud favorites endpoints (GET/PUT sync, DELETE favorites).</summary>
        public const string AccountSyncUrl = ContentBaseUrl + "/api/account/sync";
        public const string AccountFavoritesUrl = ContentBaseUrl + "/api/account/favorites";

        /// <summary>Sign-out endpoint (POST, revokes the session + clears cookies).</summary>
        public const string SignOutUrl = ContentBaseUrl + "/auth/sign-out";

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
