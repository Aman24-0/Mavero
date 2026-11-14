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
// Crash diagnostics: the field-test TV runs with no PC and no
// `sdb dlog`, so every failure must become visible ON SCREEN:
//   - AppDomain.UnhandledException + TaskScheduler.UnobservedTask
//     Exception route into the Diagnostics overlay (Diagnostics.cs)
//     in addition to dlog — the TV itself becomes the log;
//   - an exception that escapes Main (DALi init failure, missing
//     tpk payload) still lands in dlog for emulator debugging;
//     nothing can render before the NUI window exists.
// To read it on a booted failure:  sdb dlog | grep MAVERO   (or
// `sdb shell dlog -s MAVERO` inside the emulator shell).
// ============================================================
using System;
using System.Threading.Tasks;
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
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

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
        /// reach dlog — and, when a window exists, the on-screen panel.</summary>
        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            Log.Error(MaveroApp.LogTag, "Mavero TV UNHANDLED (" + (e.IsTerminating ? "terminating" : "observed") + "): "
                + (ex != null ? ex.GetType().FullName + ": " + ex.Message + "\n" + ex.StackTrace
                              : Convert.ToString(e.ExceptionObject)));

            if (ex != null)
            {
                try
                {
                    Diagnostics.Report(ex, e.IsTerminating ? "unhandled exception" : "unhandled (observed)", null);
                }
                catch
                {
                    // Diagnostics needs the DALi pump; before OnCreate there is
                    // none — dlog above is the only channel and must not break.
                }
            }
        }

        /// <summary>Fire-and-forget task bodies that somehow escape their
        /// internal try/catch are observed (never crash the process) and
        /// surfaced on screen — the classic silent-boot-kill vector.</summary>
        private static void OnUnobservedTaskException(object sender, UnobservedTaskExceptionEventArgs e)
        {
            Exception ex = e.Exception != null && e.Exception.InnerExceptions.Count > 0
                ? e.Exception.InnerExceptions[0]
                : (Exception)e.Exception;

            Log.Error(MaveroApp.LogTag, "Mavero TV UNOBSERVED TASK: "
                + (ex != null ? ex.GetType().FullName + ": " + ex.Message : "unknown")
                + (e.Exception != null ? "\n" + e.Exception.StackTrace : string.Empty));

            e.SetObserved(); // keep the process alive — the UI is the reporter

            if (ex != null)
            {
                try
                {
                    Diagnostics.Report(ex, "unobserved task", null);
                }
                catch
                {
                    // Same guard as above: never let the reporter throw.
                }
            }
        }
    }
}
