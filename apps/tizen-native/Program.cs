// ============================================================
// Mavero TV — native Tizen entry point (Tizen.NUI, C#).
//
// JIT/TYPE-LOAD ISOLATION (field-TV boot-death rule, v0.0.4):
//   On the real Samsung TV the process used to die BEFORE any managed
//   handler ever ran — while the OS splash was still up. A .NET JIT
//   compiles Main as ONE method: if Main directly referenced App/NUI/
//   JSON types, their type-load and JIT failures would abort BEFORE
//   Main's try/catch could ever execute. The fix:
//     - Main references ONLY System types (Exception, Console) plus
//       the single call to Start();
//     - Start() is [MethodImpl(MethodImplOptions.NoInlining)] so JIT
//       never inlines its body into Main — every Tizen/NUI/App type
//       load happens INSIDE Start(), safely inside Main's try/catch;
//     - any TypeLoadException/MissingMethodException/FileNotFound
//       (the tpk payload problem class) is now REPORTED instead of
//       dying invisibly (Console.Error → platform crash log + the
//       launcher's stderr capture).
//
// Lifecycle: Main → Start → MaveroApp (NUIApplication) → OnCreate
// (STAGE 1 minimal green frame) → +500ms deferred boot → HomePage.
//
// Screen diagnostics: the field TV runs with no PC and no `sdb dlog`,
// so the app paints its own boot console (BootLog.cs) + Diagnostics
// overlay (Diagnostics.cs) — the TV screen itself is the log.
// ============================================================
using System;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;

namespace MaveroTv
{
    /// <summary>Tizen native entry point (JIT-isolated, System-only Main).</summary>
    internal static class Program
    {
        private static void Main(string[] args)
        {
            // ONLY System types below — any richer reference (Tizen.Log,
            // NUIApplication, MaveroApp) would pull Tizen/NUI type loads
            // into Main's JIT compilation, defeating the isolation.
            try
            {
                Start(args);
            }
            catch (Exception ex)
            {
                // Reached for: TypeLoadException/MissingMethodException during
                // Start()'s JIT, tpk payload holes, NUIApplication ctor aborts —
                // everything that previously killed the process pre-handler.
                Console.Error.WriteLine("MAVERO FATAL: " + ex.GetType().FullName + ": " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                Console.Error.Flush();
                throw; // preserve the crash for the platform crash handler
            }
        }

        /// <summary>
        /// The real entry body, kept OUT of Main's JIT frame. Everything
        /// Tizen-flavored (Tizen.Log, MaveroApp, NUI) loads here — one
        /// level beneath Main's guard.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Start(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;

            Tizen.Log.Info(MaveroApp.LogTag, "Mavero TV boot: Program.Main reached (JIT-isolated entry OK)");
            Console.Error.WriteLine("MAVERO: Program.Main reached");

            var app = new MaveroApp();
            app.Run(args);
            Tizen.Log.Info(MaveroApp.LogTag, "Mavero TV exit: app.Run returned cleanly");
        }

        /// <summary>Background-thread escapes (IO continuations, timers) also
        /// reach dlog — and, when a window exists, the on-screen panel.</summary>
        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            Tizen.Log.Error(MaveroApp.LogTag, "Mavero TV UNHANDLED (" + (e.IsTerminating ? "terminating" : "observed") + "): "
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

            Tizen.Log.Error(MaveroApp.LogTag, "Mavero TV UNOBSERVED TASK: "
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
