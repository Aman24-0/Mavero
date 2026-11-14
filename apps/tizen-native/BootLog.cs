// ============================================================
// Mavero TV — live boot console (on-screen boot breadcrumb log).
//
// The field-test TV has NO PC and NO `sdb dlog`. A NATIVE crash
// (SIGSEGV/SIGABRT in DALi, in Mono's TLS handshake, in a NUI
// visual) kills the process instantly — try/catch, AppDomain
// .UnhandledException and TaskScheduler.UnobservedTaskException
// never see it, so the Diagnostics overlay never renders. The ONLY
// channel that survives is the screen itself: whatever the TV was
// last told to paint is still there after the process dies.
//
// BootLog exploits exactly that. It paints a bottom-strip console
// on the default window and runs the boot sequence in staged
// 150ms ticks on the DALi thread:
//
//   phase SHOW (tick 2k):   append "[BOOT k/6] <step>..." to the
//                           console — NOTHING else this tick, so
//                           DALi renders the line for >=150ms
//                           (several frames) before the step runs;
//   phase RUN  (tick 2k+1): execute the step, guardedly. On success
//                           the line becomes "... OK"; on ANY managed
//                           exception the line becomes "... FAILED",
//                           the Diagnostics panel opens, staging stops.
//
// If the process dies natively inside a step, the TV screen keeps
// showing the LAST rendered frame — the console line of the exact
// step that killed it. A photo of the TV pinpoints the culprit:
//
//   [BOOT 1/6] Window & Dispatcher initialized
//   [BOOT 2/6] Creating ApiService & HttpClient (plain TLS first)...
//   [BOOT 3/6] Constructing HomePage shell (Header & Empty Layout)...
//   [BOOT 4/6] Starting network fetch (Home feed)...
//   [BOOT 5/6] Network response received (N chars) -> Parsing JSON...
//   [BOOT 6/6] Populating MediaCards into UI...
//   [BOOT] COMPLETE - app healthy
//
// Steps 5/6 and 6/6 are network-paced (not timer-paced): the fetch
// continuation reports 5/6 when the body arrives, and 6/6 is
// appended BEFORE the MediaCard bind, which is deferred one
// PostDelayed(120ms) pass so the line renders before the riskiest
// NUI construction of the whole app.
//
// Threading: every method is safe from any thread (non-UI callers
// are marshaled through UiDispatcher). The staging Timer and the
// hide Timer are created ONLY on the DALi thread — the zero-native
// background-thread rule of UiDispatcher.cs applies here too.
// ============================================================
using System;
using System.Collections.Generic;
using System.Text;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>One staged boot step: the console line shown for it and the work it runs.</summary>
    internal sealed class BootStage
    {
        /// <summary>Console line rendered BEFORE Run() executes (>=150ms earlier).</summary>
        public string Line;

        /// <summary>The step's work. Runs on the DALi thread, 150ms after Line rendered.</summary>
        public Action Run;

        public BootStage(string line, Action run)
        {
            Line = line;
            Run = run;
        }
    }

    /// <summary>On-screen live boot console — the TV screen is the boot log.</summary>
    internal static class BootLog
    {
        private const int StageTickMs = 150;
        private const int HideAfterCompleteMs = 6000;
        private const int MaxBodyLines = 8;
        private const int PanelHeight = 300;
        private const int RiskyStepRenderLeadMs = 120;

        private static Window _window;
        private static View _panel;
        private static TextLabel _body;

        private static readonly List<string> Lines = new List<string>();
        private static readonly object Gate = new object();

        private static Tizen.NUI.Timer _stageTimer;
        private static List<BootStage> _stages;
        private static int _stageIndex;

        /// <summary>True while the console is on screen (Step/Complete still paint).</summary>
        private static bool _alive;

        /// <summary>True once the console finished a full boot and was hidden.</summary>
        private static bool _retired;

        /// <summary>Captures the window and paints the empty console. DALi thread only
        /// (called from App.OnCreate BEFORE any risky boot step).</summary>
        public static void Initialize(Window window)
        {
            try
            {
                _window = window;
                if (_window == null)
                {
                    return;
                }

                View panel = new View
                {
                    Position2D = new Position2D(0, Theme.ScreenHeight - PanelHeight),
                    Size2D = new Size2D(Theme.ScreenWidth, PanelHeight),
                    BackgroundColor = new Color(0f, 0f, 0f, 0.92f),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };

                TextLabel header = new TextLabel
                {
                    Text = "MAVERO TV BOOT CONSOLE",
                    TextColor = Theme.Accent,
                    PointSize = 16,
                    Position2D = new Position2D(24, 12),
                    Size2D = new Size2D(Theme.ScreenWidth - 48, 34),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                panel.Add(header);

                _body = new TextLabel
                {
                    Text = string.Empty,
                    TextColor = Theme.TextPrimary,
                    PointSize = 14,
                    MultiLine = true,
                    Position2D = new Position2D(24, 52),
                    Size2D = new Size2D(Theme.ScreenWidth - 48, PanelHeight - 70),
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
                panel.Add(_body);

                _panel = panel;
                _alive = true;
                _retired = false;
                _window.Add(_panel);
            }
            catch (Exception ex)
            {
                // The console must never take the boot down with it.
                Log.Warn(MaveroApp.LogTag, "BootLog init failed: " + ex.Message);
                _panel = null;
                _body = null;
                _alive = false;
            }
        }

        /// <summary>
        /// Runs the staged boot sequence. DALi thread only (App.OnCreate).
        /// Each stage is shown for one 150ms tick, THEN executed on the next
        /// tick — the step's console line is rendered on the TV screen for
        /// at least 150ms before the step's code runs, so a native crash
        /// leaves the culprit's line visible.
        /// </summary>
        public static void RunStages(BootStage[] stages)
        {
            if (!_alive || _panel == null || stages == null || stages.Length == 0)
            {
                // Console unavailable (or nothing to stage) — run everything
                // inline so boot still happens.
                if (stages != null)
                {
                    foreach (BootStage stage in stages)
                    {
                        SafeRun(stage);
                    }
                }
                return;
            }

            _stages = new List<BootStage>(stages);
            _stageIndex = 0;

            try
            {
                // Staging timer: created + started on the DALi thread (we are
                // on it). Stops itself (Tick returns false) after the last stage.
                _stageTimer = new Tizen.NUI.Timer(StageTickMs);
                _stageTimer.Tick += OnStageTick;
                _stageTimer.Start();
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "BootLog staging timer failed: " + ex.Message);
                // Degrade: run every remaining stage inline, no staging.
                while (_stageIndex < _stages.Count)
                {
                    SafeRun(_stages[_stageIndex]);
                    _stageIndex++;
                }
                _stages = null;
            }
        }

        /// <summary>Two-phase staging tick: SHOW the next line, or RUN the shown step.</summary>
        private static bool OnStageTick(object source, Tizen.NUI.Timer.TickEventArgs args)
        {
            // Odd tick (RUN): _showPending == true means the current stage's
            // line is already on screen (one full 150ms tick has passed since
            // the SHOW tick rendered it) — run it now.
            if (_showPending)
            {
                _showPending = false;
                BootStage stage = _stages[_stageIndex];
                bool ok = SafeRun(stage);
                AppendLineSuffix(ok ? " OK" : " FAILED");

                if (!ok)
                {
                    StopStagingTimer();
                    return false; // staging over; panel stays with the FAILED line
                }

                _stageIndex++;
                if (_stageIndex >= _stages.Count)
                {
                    // All staged steps done — network-paced steps (5/6, 6/6)
                    // and Complete() continue via Step()/StepBefore().
                    StopStagingTimer();
                    return false;
                }
                return true; // next tick SHOWs the following stage's line
            }

            // Even tick (SHOW): render the current stage's line, run nothing.
            AppendLine(_stages[_stageIndex].Line + " ...");
            _showPending = true;
            return true;
        }

        private static bool _showPending;

        private static void StopStagingTimer()
        {
            Tizen.NUI.Timer timer = _stageTimer;
            _stageTimer = null;
            _stages = null;
            if (timer == null)
            {
                return;
            }

            UiDispatcher.Post(() =>
            {
                try
                {
                    timer.Dispose();
                }
                catch
                {
                    // deferred dispose off the Tick callback; never fatal
                }
            });
        }

        /// <summary>Runs one stage guardedly. Returns false when it threw (the
        /// Diagnostics panel is opened for it).</summary>
        private static bool SafeRun(BootStage stage)
        {
            try
            {
                if (stage.Run != null)
                {
                    stage.Run();
                }
                return true;
            }
            catch (Exception ex)
            {
                Log.Error(MaveroApp.LogTag, "Boot stage failed: " + ex.GetType().FullName + ": " + ex.Message);
                Diagnostics.Report(ex, "boot stage", null);
                return false;
            }
        }

        /// <summary>
        /// Appends an informational line (safe from any thread). Used for the
        /// network-paced steps (5/6) and failure notes. No-op once retired.
        /// </summary>
        public static void Step(string line)
        {
            if (UiDispatcher.IsOnUiThread)
            {
                AppendLine(line);
                return;
            }

            UiDispatcher.Post(() => AppendLine(line));
        }

        /// <summary>
        /// Shows `line` on the console, THEN runs `riskyWork` on the DALi
        /// thread ~120ms later (after the line has rendered). The deferral
        /// keeps the "exact step before death" guarantee for the riskiest
        /// NUI construction (the MediaCard bind). Safe from any thread.
        /// </summary>
        public static void StepBefore(string line, Action riskyWork)
        {
            void Run()
            {
                AppendLine(line);
                UiDispatcher.PostDelayed(() =>
                {
                    try
                    {
                        riskyWork();
                    }
                    catch (Exception ex)
                    {
                        AppendLineSuffix(" FAILED");
                        Log.Error(MaveroApp.LogTag, "Risky boot step failed: " + ex.Message);
                        Diagnostics.Report(ex, "boot risky step", null);
                    }
                }, RiskyStepRenderLeadMs);
            }

            if (UiDispatcher.IsOnUiThread)
            {
                Run();
                return;
            }

            UiDispatcher.Post(Run);
        }

        /// <summary>Marks the boot complete and hides the console after a delay
        /// (the app keeps running; the console served its purpose). Safe anywhere.</summary>
        public static void Complete()
        {
            if (UiDispatcher.IsOnUiThread)
            {
                CompleteOnUi();
                return;
            }

            UiDispatcher.Post(CompleteOnUi);
        }

        private static void CompleteOnUi()
        {
            if (!_alive)
            {
                return;
            }

            AppendLine("[BOOT] COMPLETE - app healthy");

            try
            {
                // One-shot hide timer, created on the DALi thread (we are on
                // it — CompleteOnUi always runs posted/on the UI thread).
                Tizen.NUI.Timer hideTimer = new Tizen.NUI.Timer(HideAfterCompleteMs);
                hideTimer.Tick += (object source, Tizen.NUI.Timer.TickEventArgs args) =>
                {
                    UiDispatcher.Post(RemovePanel);
                    return false; // one-shot
                };
                hideTimer.Start();
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "BootLog hide timer failed: " + ex.Message);
            }
        }

        /// <summary>Keeps the console visible above a freshly-shown Diagnostics
        /// overlay, so the error stack AND the last boot line are both readable.
        /// DALi thread only.</summary>
        public static void RaiseToTop()
        {
            try
            {
                if (_alive && _panel != null)
                {
                    _panel.RaiseToTop();
                }
            }
            catch
            {
                // cosmetic only
            }
        }

        /// <summary>Removes the console from the window. DALi thread only.</summary>
        private static void RemovePanel()
        {
            View panel = _panel;
            _panel = null;
            _body = null;
            _alive = false;
            _retired = true;

            if (panel == null || _window == null)
            {
                return;
            }

            try
            {
                _window.Remove(panel);
                panel.Dispose();
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "BootLog removal failed: " + ex.Message);
            }
        }

        /// <summary>Appends a line, trimming the oldest when the panel is full.
        /// DALi thread only.</summary>
        private static void AppendLine(string line)
        {
            if (!_alive || _body == null)
            {
                return;
            }

            lock (Gate)
            {
                Lines.Add(line);
                while (Lines.Count > MaxBodyLines)
                {
                    Lines.RemoveAt(0);
                }

                StringBuilder text = new StringBuilder();
                for (int i = 0; i < Lines.Count; i++)
                {
                    if (i > 0)
                    {
                        text.Append('\n');
                    }
                    text.Append(Lines[i]);
                }

                try
                {
                    _body.Text = text.ToString();
                }
                catch (Exception ex)
                {
                    Log.Warn(MaveroApp.LogTag, "BootLog paint failed: " + ex.Message);
                }
            }
        }

        /// <summary>Rewrites the last line's trailing status ("... OK" / "... FAILED").
        /// DALi thread only.</summary>
        private static void AppendLineSuffix(string suffix)
        {
            if (!_alive || _body == null)
            {
                return;
            }

            lock (Gate)
            {
                if (Lines.Count == 0)
                {
                    return;
                }

                Lines[Lines.Count - 1] = Lines[Lines.Count - 1] + suffix;
                StringBuilder text = new StringBuilder();
                for (int i = 0; i < Lines.Count; i++)
                {
                    if (i > 0)
                    {
                        text.Append('\n');
                    }
                    text.Append(Lines[i]);
                }

                try
                {
                    _body.Text = text.ToString();
                }
                catch
                {
                    // repaint failure is never fatal
                }
            }
        }

        /// <summary>Unused-retirement probe (kept for clarity: Step/Complete
        /// no-op after the console retires).</summary>
        public static bool IsRetired
        {
            get { return _retired; }
        }
    }
}
