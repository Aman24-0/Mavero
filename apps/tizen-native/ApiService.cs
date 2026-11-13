// ============================================================
// Mavero TV — production API client.
//
// Fetches the TV home rails from the live production deployment
// (https://maveroweb.space/api/tv/home). The endpoint composes the
// same cached TMDB-backed catalog services the web app's Discover
// and Explorer pages use, with CORS `*` and a public cache header —
// it was built exactly for this native TV client.
//
// This phase proves the data path inside the native runtime: the
// fetched rail titles are printed through Tizen.Log (visible via
// `sdb dlog` / Tizen Studio log view). Rendering the cards from
// this data is the next iteration.
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

        /// <summary>Production origin serving the public TV API.</summary>
        public const string TvHomeUrl = "https://maveroweb.space/api/tv/home";

        /// <summary>dlog tag for all API logging.</summary>
        public const string LogTag = "MAVERO";
    }
}
