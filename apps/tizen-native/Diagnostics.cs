// ============================================================
// Mavero TV — on-screen runtime diagnostics (Tizen.NUI, API 6).
//
// The field-test TV has NO PC and NO `sdb dlog`: any exception that
// would otherwise kill the process silently just drops the user back
// to the TV home screen with nothing to show for it. This module is
// the safety net for exactly that workflow:
//
//   - Report() / ReportNonFatal() render a full-screen dark panel
//     with the error type, message and the top stack frames in a
//     large readable TextLabel, plus a RETRY button (Enter/OK).
//     RETRY re-runs the failed operation when the caller supplied a
//     retry action (home reload, season reload, ...); without one it
//     becomes CLOSE and simply dismisses the panel.
//   - Program.cs (AppDomain.UnhandledException +
//     TaskScheduler.UnobservedTaskException) and MaveroApp.OnCreate /
//     OnKeyEvent funnel here, so startup, navigation and background
//     failures all become readable on screen instead of silent exits.
//
// Construction is fully defensive: the overlay paints with plain
// colors only (no res/ image assets, no 9-patch, no remote loads), so
// a diagnostics failure can never take the app down with it — worst
// case the panel degrades to a bare black screen + text. Every NUI
// touch is wrapped; a failure inside Report logs and returns.
//
// Threading: callers may sit on any thread. When the caller IS the DALi
// thread the overlay is built inline (also the pump-less fallback: if
// boot fails BEFORE UiDispatcher.Initialize() ran, a Post() would land
// in a queue nobody drains and the panel would never appear — the exact
// silent-boot-kill this file exists to prevent); otherwise the NUI work
// is posted through UiDispatcher.
// ============================================================
using System;
using System.Text;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>On-screen crash/diagnostics reporter (the TV is the log).</summary>
    internal static class Diagnostics
    {
        private const int MaxStackFrames = 8;
        private const int MaxMessageChars = 400;
        private const int MaxStackChars = 900;

        private static Window _window;
        private static DiagnosticOverlay _overlay;

        /// <summary>True while the diagnostic panel is on screen (Back exits the app).</summary>
        public static bool IsShowing
        {
            get { return _overlay != null; }
        }

        /// <summary>Captures the window once, from OnCreate (UI thread).</summary>
        public static void Initialize(Window window)
        {
            _window = window;
        }

        /// <summary>
        /// Shows the error panel. `retry` (optional) runs when the user
        /// presses RETRY; without one the button acts as CLOSE.
        /// Safe from any thread; never throws.
        /// </summary>
        public static void Report(Exception ex, string context, Action retry)
        {
            if (ex == null)
            {
                return;
            }

            Log.Error(MaveroApp.LogTag,
                $"DIAGNOSTICS ({context ?? "runtime"}): {ex.GetType().FullName}: {ex.Message}\n{ex.StackTrace}");

            if (UiDispatcher.IsOnUiThread)
            {
                if (UiDispatcher.IsInitialized)
                {
                    // Already the DALi thread AND the pump is live: still Post,
                    // never build inline. The overlay must be constructed AND
                    // focused on a LATER pump pass — building + focusing a
                    // freshly-added view tree on the current pass aborts
                    // natively on real TV hardware (FocusManager vs an
                    // un-laid-out view). One pump pass later is safe.
                    UiDispatcher.Post(() => SafeShowOverlay(ex, context, retry));
                    return;
                }

                // Pump-less boot edge case (OnCreate failed before the pump
                // could start): inline is the only channel that can ever show
                // this panel — a Post() would strand in the queue forever.
                // Best-effort focus (guarded); dlog above is the backup log.
                SafeShowOverlay(ex, context, retry);
                return;
            }

            UiDispatcher.Post(() => SafeShowOverlay(ex, context, retry));
        }

        /// <summary>Guarded overlay build — the reporter must never kill the app.</summary>
        private static void SafeShowOverlay(Exception ex, string context, Action retry)
        {
            try
            {
                ShowOverlay(ex, context, retry);
            }
            catch (Exception inner)
            {
                // The reporter itself must never kill the app.
                Log.Error(MaveroApp.LogTag,
                    "Diagnostics overlay failed: " + inner.GetType().FullName + ": " + inner.Message);
            }
        }

        /// <summary>Non-fatal variant (queued-bind failures, player hiccups...):
        /// same panel, CLOSE instead of RETRY. Never throws.</summary>
        public static void ReportNonFatal(Exception ex, string context)
        {
            Report(ex, context, null);
        }

        /// <summary>Dismisses the overlay (RETRY/CLOSE press). UI thread only.</summary>
        private static void DismissOverlay()
        {
            DiagnosticOverlay overlay = _overlay;
            _overlay = null;
            if (overlay == null || _window == null)
            {
                return;
            }

            try
            {
                FocusManager.Instance.SetCurrentFocusView(null);
                _window.Remove(overlay);
                overlay.Dispose();
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "Diagnostics dismiss failed: " + ex.Message);
            }
        }

        private static void ShowOverlay(Exception ex, string context, Action retry)
        {
            if (_window == null)
            {
                return; // no window yet — dlog is the only channel
            }

            // Replace any previous panel (the newest failure wins).
            DismissOverlay();

            _overlay = new DiagnosticOverlay(ex, context, retry != null, () =>
            {
                bool hasRetry = retry != null;
                DismissOverlay();
                if (hasRetry)
                {
                    try
                    {
                        retry();
                    }
                    catch (Exception retryEx)
                    {
                        // A failing retry loops back through the reporter.
                        Report(retryEx, context + " retry", null);
                    }
                }
            });
            _window.Add(_overlay);

            // Keep the boot console readable above the panel: the stack trace
            // AND the last [BOOT k/6] line together pinpoint a native crash.
            BootLog.RaiseToTop();

            // Focus the RETRY/CLOSE button AFTER the panel has rendered: the
            // overlay was just added to the window, and focusing an
            // un-laid-out view aborts natively on real TV hardware (the same
            // trap as the home rail focus handoff — a ~120ms render lead
            // fixes it). Pump-less inline path: best-effort immediate focus.
            DiagnosticOverlay overlayForFocus = _overlay;
            if (UiDispatcher.IsInitialized)
            {
                UiDispatcher.PostDelayed(() =>
                {
                    try
                    {
                        if (overlayForFocus != null)
                        {
                            overlayForFocus.FocusRetryButton();
                        }
                    }
                    catch (Exception focusEx)
                    {
                        Log.Warn(MaveroApp.LogTag, "Diagnostics focus failed: " + focusEx.Message);
                    }
                }, 120);
            }
            else
            {
                try
                {
                    _overlay.FocusRetryButton();
                }
                catch (Exception focusEx)
                {
                    Log.Warn(MaveroApp.LogTag, "Diagnostics focus failed: " + focusEx.Message);
                }
            }
        }

        /// <summary>Formats "Type: message" for the headline line.</summary>
        private static string Headline(Exception ex)
        {
            string name = ex.GetType().Name;
            string message = ex.Message ?? string.Empty;
            if (message.Length > MaxMessageChars)
            {
                message = message.Substring(0, MaxMessageChars) + "…";
            }
            return name + ": " + message;
        }

        /// <summary>Formats the top stack frames, one per line, app frames first.</summary>
        private static string StackSummary(Exception ex)
        {
            string stack = ex.StackTrace ?? string.Empty;
            if (string.IsNullOrEmpty(stack))
            {
                return "(no stack trace)";
            }

            string[] lines = stack.Replace("\r", "").Split('\n');
            StringBuilder summary = new StringBuilder();
            int taken = 0;
            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.Length == 0)
                {
                    continue;
                }

                if (summary.Length > 0)
                {
                    summary.Append('\n');
                }
                summary.Append(line);
                taken++;
                if (taken >= MaxStackFrames || summary.Length >= MaxStackChars)
                {
                    summary.Append("\n…");
                    break;
                }
            }
            return summary.ToString();
        }

        /// <summary>The full-screen error panel (plain colors only — asset-free).</summary>
        private sealed class DiagnosticOverlay : View
        {
            private readonly Action _onRetry;
            private readonly string _context;
            private readonly Exception _error;
            private readonly bool _hasRetry;
            private FocusButton _retryButton;

            public DiagnosticOverlay(Exception error, string context, bool hasRetry, Action onRetry)
            {
                _error = error;
                _context = context;
                _hasRetry = hasRetry;
                _onRetry = onRetry;

                Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
                BackgroundColor = new Color(0.02f, 0.02f, 0.02f, 0.97f);
                PivotPoint = Theme.TopLeftPivot;
                PositionUsesPivotPoint = true;

                BuildContent();
            }

            private void BuildContent()
            {
                bool hasRetry = _hasRetry;

                TextLabel banner = new TextLabel
                {
                    Text = "MAVERO TV - RUNTIME ERROR",
                    TextColor = Theme.Accent,
                    PointSize = 30,
                    Position2D = new Position2D(Theme.PageMargin, 96),
                    Size2D = new Size2D(Theme.RailViewportWidth, 56),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                Add(banner);

                TextLabel contextLine = new TextLabel
                {
                    Text = "Stage: " + (string.IsNullOrEmpty(_context) ? "unknown" : _context),
                    TextColor = Theme.TextSecondary,
                    PointSize = 18,
                    Position2D = new Position2D(Theme.PageMargin, 168),
                    Size2D = new Size2D(Theme.RailViewportWidth, 40),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                Add(contextLine);

                TextLabel headline = new TextLabel
                {
                    Text = Diagnostics.Headline(_error),
                    TextColor = Theme.TextPrimary,
                    PointSize = 24,
                    MultiLine = true,
                    Position2D = new Position2D(Theme.PageMargin, 240),
                    Size2D = new Size2D(Theme.RailViewportWidth, 200),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                Add(headline);

                TextLabel stack = new TextLabel
                {
                    Text = Diagnostics.StackSummary(_error),
                    TextColor = Theme.TextSecondary,
                    PointSize = 14,
                    MultiLine = true,
                    Position2D = new Position2D(Theme.PageMargin, 460),
                    Size2D = new Size2D(Theme.RailViewportWidth, 380),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                Add(stack);

                TextLabel hint = new TextLabel
                {
                    Text = hasRetry
                        ? "Press OK on RETRY to reload this screen"
                        : "Press OK to continue - BACK exits the app",
                    TextColor = Theme.TextSecondary,
                    PointSize = 16,
                    Position2D = new Position2D(Theme.PageMargin, 880),
                    Size2D = new Size2D(Theme.RailViewportWidth, 36),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                Add(hint);

                _retryButton = new FocusButton(hasRetry ? "RETRY" : "CLOSE",
                    320, 84, true)
                {
                    // Center pivot: Position2D measures to the button's center.
                    Position2D = new Position2D(Theme.PageMargin + 160, 972 + 42)
                };
                _retryButton.Selected += OnRetrySelected;
                Add(_retryButton);
            }

            private void OnRetrySelected()
            {
                // _onRetry is always wired (ShowOverlay passes a wrapper that
                // dismisses the panel, then runs the caller's retry if any).
                try
                {
                    _onRetry();
                }
                catch (Exception ex)
                {
                    Log.Error(MaveroApp.LogTag, "Diagnostics retry failed: " + ex.Message);
                }
            }

            /// <summary>Lands focus on the RETRY/CLOSE button (UI thread).</summary>
            public void FocusRetryButton()
            {
                if (_retryButton != null)
                {
                    FocusManager.Instance.SetCurrentFocusView(_retryButton);
                }
            }
        }
    }
}
