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
//
// Crash diagnostics: on the emulator/TV a managed exception that
// escapes Main kills the process with NOTHING on screen ("nothing
// happens when I click the app icon"). To make every boot failure
// diagnosable from dlog, Main wraps the app run in try/catch and
// subscribes AppDomain.UnhandledException — both write the full
// exception through Tizen.Log under the MAVERO tag. To read it on
// a booted failure:  sdb dlog | grep MAVERO   (or `sdb shell
// lttng`-free plain `dlog -s MAVERO` inside the emulator shell).
// ============================================================
using System;
using Tizen;
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>Tizen native entry point.</summary>
    internal static class Program
    {
        private static void Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

            try
            {
                Log.Info(MaveroApp.LogTag, "Mavero TV boot: starting MaveroApp");
                var app = new MaveroApp();
                app.Run(args);
                Log.Info(MaveroApp.LogTag, "Mavero TV exit: app.Run returned cleanly");
            }
            catch (Exception ex)
            {
                // The failure that used to be invisible: dependency load
                // errors (missing tpk payload), API skew between the NuGet
                // refs and the platform, DALi init failures — all land here.
                Log.Error(MaveroApp.LogTag, "Mavero TV FATAL: " + ex.GetType().FullName
                    + ": " + ex.Message + "\n" + ex.StackTrace);
                throw; // preserve the crash for the platform crash handler
            }
        }

        /// <summary>Background-thread escapes (IO continuations, timers) also
        /// reach dlog instead of dying silently mid-run.</summary>
        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            Log.Error(MaveroApp.LogTag, "Mavero TV UNHANDLED (" + (e.IsTerminating ? "terminating" : "observed") + "): "
                + (ex != null ? ex.GetType().FullName + ": " + ex.Message + "\n" + ex.StackTrace
                              : Convert.ToString(e.ExceptionObject)));
        }
    }
}
