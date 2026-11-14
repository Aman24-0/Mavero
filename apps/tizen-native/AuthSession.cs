// ============================================================
// Mavero TV — signed-in session store (Tizen, API 6).
//
// The TV signs in through the backend's device-pairing flow (see
// LoginPage): after /api/auth/device-pairing/exchange succeeds, the
// session lives in the Supabase auth cookies the response sets
// (chunked sb-*-auth-token values). This class owns everything
// session-shaped for the whole app:
//
//   - the cookie jar: every Set-Cookie the server sends is captured
//     (name -> raw value) and replayed as a Cookie request header on
//     the authenticated endpoints (GET/PUT /api/account/sync,
//     DELETE /api/account/favorites, POST /auth/sign-out). The
//     server-side SSR hook refreshes expired Supabase tokens and
//     rotates the cookies on its responses — capturing Set-Cookie on
//     EVERY response keeps the jar fresh exactly like a browser.
//
//   - persistence: the jar + the user's email are serialized to a
//     compact JSON blob in the app's PRIVATE data directory
//     (Tizen.Applications.Application.Current.DirectoryInfo.Data —
//     SMACK-labeled per-app storage on device; other apps cannot read
//     it). Why not Tizen.Security.SecureRepository: its API6 DataManager
//     is a save-once store (Save refuses an existing alias and exposes
//     no Remove), while the Supabase cookie jar ROTATES on every
//     server-side token refresh — a store that cannot overwrite is the
//     wrong home for it. The app-private directory is the platform's
//     intended location for exactly this data.
//
//   - the user's email, decoded best-effort from the auth cookie
//     payload (base64/JSON, chunked or single) for the UI lines
//     ("Signed in as ..."). A decode failure never invalidates the
//     session — email is cosmetic.
//
// Thread-safety: writes/reads are locked; ApiService calls Capture
// from its IO threads and pages read on the UI thread.
//
// Guest mode: no jar, no email — the app behaves exactly as before
// (public catalog endpoints never need cookies).
// ============================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Tizen;

namespace MaveroTv
{
    /// <summary>App-wide signed-in state: cookie jar, email, persistence.</summary>
    public static class AuthSession
    {
        /// <summary>Persisted session file name inside the app's private data directory.</summary>
        private const string SessionFileName = "session.json";

        /// <summary>Log tag (shared with the app's dlog stream).</summary>
        private const string Tag = "MAVERO";

        private static readonly object Gate = new object();
        private static readonly Dictionary<string, string> Cookies = new Dictionary<string, string>();

        private static bool _loaded;
        private static string _email;

        /// <summary>True when a session cookie set is present (the user signed in).</summary>
        public static bool IsSignedIn
        {
            get
            {
                lock (Gate)
                {
                    return Cookies.Count > 0;
                }
            }
        }

        /// <summary>The signed-in user's email (null/"" when unknown or guest).</summary>
        public static string UserEmail
        {
            get
            {
                lock (Gate)
                {
                    return _email;
                }
            }
        }

        // ---- lifecycle ------------------------------------------------------

        /// <summary>
        /// Loads the persisted session from the app-private store.
        /// Called once from MaveroApp.OnCreate before any page is mounted;
        /// safe to call again (subsequent calls are no-ops).
        /// </summary>
        public static void LoadFromDisk()
        {
            lock (Gate)
            {
                if (_loaded)
                {
                    return;
                }

                _loaded = true;
            }

            PersistedSession session = TryReadFileStore();
            if (session == null)
            {
                Log.Info(Tag, "AuthSession: no persisted session — starting as guest");
                return;
            }

            lock (Gate)
            {
                Cookies.Clear();
                if (session.Cookies != null)
                {
                    foreach (KeyValuePair<string, string> pair in session.Cookies)
                    {
                        if (!string.IsNullOrEmpty(pair.Key) && pair.Value != null)
                        {
                            Cookies[pair.Key] = pair.Value;
                        }
                    }
                }
                _email = string.IsNullOrEmpty(session.Email) ? null : session.Email;
            }

            Log.Info(Tag, "AuthSession: session restored (" +
                (IsSignedIn ? CookiesCount() + " cookie(s)" : "empty jar") +
                ", email=" + (UserEmail ?? "unknown") + ")");
        }

        /// <summary>Removes every cookie + the persisted blob (sign out / 401 reset).</summary>
        public static void Clear()
        {
            lock (Gate)
            {
                Cookies.Clear();
                _email = null;
            }

            DeleteFileStore();
            Log.Info(Tag, "AuthSession: session cleared — guest mode");
        }

        // ---- cookie jar -----------------------------------------------------

        /// <summary>
        /// Captures Set-Cookie header values from one response. Values are
        /// raw header lines ("name=value; Path=/; HttpOnly..."); only the
        /// first name=value pair of each line is kept. Persists the jar
        /// whenever it actually changed (cookie rotation on token refresh).
        /// </summary>
        public static void CaptureSetCookies(IEnumerable<string> setCookieLines)
        {
            if (setCookieLines == null)
            {
                return;
            }

            bool changed = false;
            lock (Gate)
            {
                foreach (string line in setCookieLines)
                {
                    string name = ParseCookieName(line);
                    if (name == null)
                    {
                        continue;
                    }

                    string value = ParseCookieValue(line);
                    string existing;
                    if (!Cookies.TryGetValue(name, out existing) || existing != value)
                    {
                        Cookies[name] = value;
                        changed = true;
                    }
                }
            }

            if (changed)
            {
                Persist();
            }
        }

        /// <summary>The Cookie header value for the authenticated endpoints
        /// (null when the jar is empty — guests send no Cookie header).</summary>
        public static string CookieHeader()
        {
            lock (Gate)
            {
                if (Cookies.Count == 0)
                {
                    return null;
                }

                StringBuilder header = new StringBuilder();
                foreach (KeyValuePair<string, string> pair in Cookies)
                {
                    if (header.Length > 0)
                    {
                        header.Append("; ");
                    }
                    header.Append(pair.Key).Append('=').Append(pair.Value);
                }
                return header.ToString();
            }
        }

        /// <summary>Number of stored cookie pairs (diagnostics).</summary>
        private static int CookiesCount()
        {
            lock (Gate)
            {
                return Cookies.Count;
            }
        }

        /// <summary>Splits "name=value; attrs" — the cookie name part.</summary>
        private static string ParseCookieName(string line)
        {
            if (string.IsNullOrEmpty(line))
            {
                return null;
            }

            int semicolon = line.IndexOf(';');
            string pair = semicolon >= 0 ? line.Substring(0, semicolon) : line;
            int equals = pair.IndexOf('=');
            if (equals <= 0)
            {
                return null;
            }

            return pair.Substring(0, equals).Trim();
        }

        /// <summary>Splits "name=value; attrs" — everything after the first '='
        /// of the pair (cookie values may themselves contain '=').</summary>
        private static string ParseCookieValue(string line)
        {
            int semicolon = line.IndexOf(';');
            string pair = semicolon >= 0 ? line.Substring(0, semicolon) : line;
            int equals = pair.IndexOf('=');
            return equals >= 0 && equals + 1 <= pair.Length
                ? pair.Substring(equals + 1).Trim()
                : string.Empty;
        }

        // ---- persistence ------------------------------------------------------

        /// <summary>Persisted blob shape.</summary>
        private class PersistedSession
        {
            [JsonProperty("cookies")]
            public Dictionary<string, string> Cookies { get; set; }

            [JsonProperty("email")]
            public string Email { get; set; }

            [JsonProperty("savedAt")]
            public long SavedAt { get; set; }
        }

        /// <summary>Serializes + writes the jar to the app-private store.</summary>
        public static void Persist()
        {
            Dictionary<string, string> snapshot;
            string email;
            lock (Gate)
            {
                if (Cookies.Count == 0)
                {
                    return; // guest state has nothing to persist
                }
                snapshot = new Dictionary<string, string>(Cookies);
                email = _email;
            }

            PersistedSession blob = new PersistedSession
            {
                Cookies = snapshot,
                Email = email,
                SavedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
            TryWriteFileStore(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(blob)));
        }

        // ---- app-private file store -------------------------------------------

        private static string SessionPath()
        {
            return Path.Combine(Tizen.Applications.Application.Current.DirectoryInfo.Data,
                SessionFileName);
        }

        private static PersistedSession TryReadFileStore()
        {
            try
            {
                string path = SessionPath();
                if (!File.Exists(path))
                {
                    return null;
                }

                Log.Info(Tag, "AuthSession: persisted session found");
                return Deserialize(File.ReadAllBytes(path));
            }
            catch (Exception ex)
            {
                Log.Warn(Tag, "AuthSession: session read failed: " + ex.Message);
                return null;
            }
        }

        private static void TryWriteFileStore(byte[] bytes)
        {
            try
            {
                File.WriteAllBytes(SessionPath(), bytes);
                Log.Info(Tag, "AuthSession: session persisted (app-private store)");
            }
            catch (Exception ex)
            {
                Log.Error(Tag, "AuthSession: session persistence failed: " + ex.Message);
            }
        }

        private static void DeleteFileStore()
        {
            try
            {
                string path = SessionPath();
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception)
            {
                // Best-effort cleanup.
            }
        }

        private static PersistedSession Deserialize(byte[] bytes)
        {
            try
            {
                return JsonConvert.DeserializeObject<PersistedSession>(Encoding.UTF8.GetString(bytes));
            }
            catch (Exception ex)
            {
                Log.Warn(Tag, "AuthSession: persisted session unparsable: " + ex.Message);
                return null;
            }
        }

        // ---- email decode (cosmetic) -----------------------------------------

        /// <summary>
        /// Best-effort decode of the signed-in user's email from the jar
        /// (called right after a successful exchange). The Supabase auth
        /// cookie payload is base64(JSON session); when chunked, the base
        /// cookie holds a JSON array of the base64 fragments. Any failure
        /// leaves the email unset — the session itself is unaffected.
        /// </summary>
        public static void DecodeEmailFromCookies()
        {
            try
            {
                string authCookie = FindAuthCookieValue();
                if (string.IsNullOrEmpty(authCookie))
                {
                    return;
                }

                string json = DecodeBase64(NormalizeBase64(authCookie));
                if (json == null)
                {
                    return;
                }

                Dictionary<string, object> session = JsonConvert
                    .DeserializeObject<Dictionary<string, object>>(json);
                if (session == null || !session.ContainsKey("user"))
                {
                    return;
                }

                Dictionary<string, object> user = session["user"] as Dictionary<string, object>;
                object emailBox;
                if (user != null && user.TryGetValue("email", out emailBox) && emailBox != null)
                {
                    string email = emailBox.ToString();
                    if (!string.IsNullOrEmpty(email))
                    {
                        lock (Gate)
                        {
                            _email = email;
                        }
                        Log.Info(Tag, "AuthSession: signed in as " + email);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Info(Tag, "AuthSession: email decode skipped (" + ex.GetType().Name + ")");
            }
        }

        /// <summary>The sb-*-auth-token cookie value (reassembled when chunked).</summary>
        private static string FindAuthCookieValue()
        {
            lock (Gate)
            {
                foreach (KeyValuePair<string, string> pair in Cookies)
                {
                    // @supabase/ssr names: "sb-<project-ref>-auth-token" plus
                    // optional ".0"/".1"... chunk fragments. The base name is
                    // the one to decode.
                    if (pair.Key.StartsWith("sb-", StringComparison.Ordinal)
                        && pair.Key.EndsWith("-auth-token", StringComparison.Ordinal)
                        && !pair.Key.Contains("."))
                    {
                        string value = pair.Value;
                        if (!string.IsNullOrEmpty(value) && value.Length > 2 && value[0] == '[')
                        {
                            // Chunked form: the base cookie holds
                            // ["<b64 fragment>","<b64 fragment>",...] — the
                            // fragments concatenated ARE the full payload.
                            string[] fragments = TryParseStringArray(value);
                            if (fragments != null && fragments.Length > 0)
                            {
                                StringBuilder joined = new StringBuilder();
                                foreach (string fragment in fragments)
                                {
                                    joined.Append(fragment);
                                }
                                return joined.ToString();
                            }
                            return null;
                        }
                        return value;
                    }
                }
                return null;
            }
        }

        /// <summary>Parse a JSON string array without a typed schema.</summary>
        private static string[] TryParseStringArray(string json)
        {
            try
            {
                return JsonConvert.DeserializeObject<string[]>(json);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>base64(-url) -> UTF-8; tolerates missing padding; null on garbage.</summary>
        private static string DecodeBase64(string normalized)
        {
            try
            {
                byte[] bytes = Convert.FromBase64String(normalized);
                return Encoding.UTF8.GetString(bytes);
            }
            catch (FormatException)
            {
                return null;
            }
        }

        /// <summary>Switches base64url to base64 and re-pads to a valid length.</summary>
        private static string NormalizeBase64(string value)
        {
            string clean = value.Replace('-', '+').Replace('_', '/').Trim();
            int padding = clean.Length % 4;
            if (padding == 2)
            {
                return clean + "==";
            }
            if (padding == 3)
            {
                return clean + "=";
            }
            return padding == 1 ? null : clean; // length %4 == 1 is never valid
        }
    }
}
