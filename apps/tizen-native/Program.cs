// ============================================================
// Mavero TV — native Tizen entry point (Tizen.NUI, C#).
//
// This is the NATIVE Tizen application (apps/tizen-native) that
// replaces the retired WebView/.wgt approach. It renders the TV
// home experience with Tizen.NUI and consumes the same public
// production API the web app serves (GET /api/tv/home on
// https://maveroweb.space) — see ApiService.cs.
//
// Lifecycle: Main → MaveroApp (NUIApplication) → OnCreate mounts
// HomePage on the default TV window (fixed 1920x1080).
// ============================================================
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>Tizen native entry point.</summary>
    internal static class Program
    {
        private static void Main(string[] args)
        {
            var app = new MaveroApp();
            app.Run(args);
        }
    }
}
