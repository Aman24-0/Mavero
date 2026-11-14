// ============================================================
// Mavero TV — UI-thread marshaling helper.
//
// Tizen.NUI (tizen40/tizen60 profiles alike) installs no
// SynchronizationContext, so await-continuations (ApiService's
// HttpClient tasks) resume on the thread pool. DALi views must only
// be touched from the DALi (UI) thread, so background work posts
// closures here and ONE persistent pump Timer drains the queue.
//
// ZERO-NATIVE-ON-BACKGROUND-THREAD CONTRACT (field-TV crash rule):
//   Tizen.NUI.Timer is a native DALi/Ecore object. Creating or
//   Start()/Stop()-ing one from a ThreadPool thread aborts natively
//   (SIGSEGV/SIGABRT) on real TV hardware. Therefore:
//     - Initialize() runs ONCE on the DALi thread (App.OnCreate) and
//       is the ONLY place a Timer is created or started;
//     - Post() from ANY thread does nothing but
//       ConcurrentQueue.Enqueue — 100% managed memory, zero DALi;
//     - PostDelayed() also only enqueues; the one-shot timer is
//       created later, ON the DALi thread, by the pump itself;
//     - the pump Timer stays alive for the whole app lifetime and
//       ticks every 25ms — peeking an empty queue is negligible.
//
// Drain() absorbs exceptions from posted closures and routes them
// to the on-screen Diagnostics overlay (see Diagnostics.cs): one
// failing continuation (e.g. a player event racing a disposed view)
// must never wedge the pump — and, on a TV with no sdb attached, it
// must never die SILENTLY either.
//
// UiSynchronizationContext (same file, below) completes the story:
// installed on the DALi thread during OnCreate, every `await`
// continuation captured from the UI thread is Posted back here, so
// 100% of post-await UI mutations run on the main NUI thread even
// if a call site forgets an explicit UiDispatcher.Post.
// ============================================================
using System;
using System.Collections.Concurrent;
using System.Threading;
using Tizen;
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>Marshals closures onto the DALi UI thread.</summary>
    internal static class UiDispatcher
    {
        /// <summary>Pump cadence. 25ms = every TV frame budget (40ms @25fps
        /// gets at least one drain pass); a tick on an empty queue is a
        /// cheap ConcurrentQueue peek on the DALi thread.</summary>
        private const int PumpIntervalMs = 25;

        private const int MaxActionsPerTick = 16;

        private static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();
        private static readonly object InitGate = new object();
        private static Tizen.NUI.Timer _pump;

        /// <summary>Id of the DALi (main) thread, captured by Initialize().</summary>
        private static int _mainThreadId = -1;

        /// <summary>True when the calling thread is the DALi (UI) thread.</summary>
        public static bool IsOnUiThread
        {
            get { return _mainThreadId >= 0 && Thread.CurrentThread.ManagedThreadId == _mainThreadId; }
        }

        /// <summary>True once Initialize() has installed the pump.</summary>
        public static bool IsInitialized
        {
            get { return _pump != null; }
        }

        /// <summary>
        /// Starts the pump. MUST be called from the DALi (UI) thread —
        /// App.OnCreate does it before anything else risky. Idempotent:
        /// later page-constructor calls are no-ops. Never throws.
        /// </summary>
        public static void Initialize()
        {
            _mainThreadId = Thread.CurrentThread.ManagedThreadId;

            lock (InitGate)
            {
                if (_pump != null)
                {
                    return;
                }

                try
                {
                    // ONE persistent DALi Timer, created + started on the
                    // DALi thread (we are on it — Initialize is called from
                    // OnCreate). Background threads NEVER reach this code.
                    _pump = new Tizen.NUI.Timer(PumpIntervalMs);
                    _pump.Tick += (object source, Tizen.NUI.Timer.TickEventArgs args) =>
                    {
                        Drain();
                        return true; // keep the pump running for the app lifetime
                    };
                    _pump.Start();
                }
                catch (Exception ex)
                {
                    // A dead pump would strand every queued continuation and
                    // every Diagnostics.Post — log it loudly; the exception
                    // itself is rethrown so OnCreate's guard shows it on screen.
                    Log.Error(MaveroApp.LogTag, "UiDispatcher pump failed to start: " + ex.Message);
                    _pump = null;
                    throw;
                }
            }
        }

        /// <summary>Legacy alias kept for the page constructors — idempotent.</summary>
        public static void Start()
        {
            Initialize();
        }

        /// <summary>
        /// Safe from ANY thread. The action runs on the DALi thread.
        /// Deliberately touches NOTHING native: a ConcurrentQueue enqueue
        /// is pure managed memory (the field-TV native-crash rule).
        /// </summary>
        public static void Post(Action action)
        {
            if (action == null)
            {
                return;
            }

            Queue.Enqueue(action);
        }

        /// <summary>
        /// Safe from ANY thread. Schedules the action to run on the DALi
        /// thread after `delayMs`. The one-shot Tizen.NUI.Timer is created
        /// ON the DALi thread by the pump (never by the caller's thread) —
        /// background threads only enqueue, honoring the zero-native rule.
        /// </summary>
        public static void PostDelayed(Action action, int delayMs)
        {
            if (action == null || delayMs <= 0)
            {
                Post(action);
                return;
            }

            Post(() =>
            {
                // We are now ON the DALi thread — creating/starting a Timer
                // here is legal. One-shot: the Tick returns false so DALi
                // stops it; disposal is deferred to the next pump pass so we
                // never Dispose a Timer from inside its own Tick callback.
                Tizen.NUI.Timer oneShot = new Tizen.NUI.Timer((uint)delayMs);
                oneShot.Tick += (object source, Tizen.NUI.Timer.TickEventArgs args) =>
                {
                    try
                    {
                        action();
                    }
                    catch (Exception ex)
                    {
                        Log.Error(MaveroApp.LogTag, "Delayed UI action failed: " + ex.Message);
                        Diagnostics.ReportNonFatal(ex, "delayed UI action");
                    }

                    Tizen.NUI.Timer finished = source as Tizen.NUI.Timer;
                    Post(() =>
                    {
                        try
                        {
                            if (finished != null)
                            {
                                finished.Dispose();
                            }
                        }
                        catch
                        {
                            // a double-dispose must never take the app down
                        }
                    });
                    return false; // one-shot: stop ticking
                };
                oneShot.Start();
            });
        }

        /// <summary>Runs queued closures on the DALi thread (pump Tick).</summary>
        private static void Drain()
        {
            for (int i = 0; i < MaxActionsPerTick; i++)
            {
                Action action;
                if (!Queue.TryDequeue(out action))
                {
                    break;
                }

                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    // Keep the app alive AND make the failure visible —
                    // field TVs have no sdb; the screen is the log.
                    Log.Error(MaveroApp.LogTag,
                        "UI dispatch failed: " + ex.GetType().FullName + ": " + ex.Message);
                    Diagnostics.ReportNonFatal(ex, "UI dispatch");
                }
            }
        }
    }

    /// <summary>
    /// SynchronizationContext installed on the DALi thread during OnCreate.
    ///
    /// Tizen.NUI installs no SynchronizationContext, so by default every
    /// `await` continuation captured on the UI thread resumes on the thread
    /// pool — any UI mutation there is a native crash on TV hardware. With
    /// this context installed, continuations captured from the UI thread are
    /// marshaled through UiDispatcher's pump and run on the DALi thread,
    /// exactly like the main-thread dispatcher model on every other UI
    /// platform. Thread-pool-originated callbacks (player events, polling
    /// loops) keep using the explicit UiDispatcher.Post.
    /// </summary>
    internal sealed class UiSynchronizationContext : SynchronizationContext
    {
        /// <summary>Installs the context on the calling (DALi) thread. Idempotent.</summary>
        public static void Install()
        {
            if (!(SynchronizationContext.Current is UiSynchronizationContext))
            {
                SynchronizationContext.SetSynchronizationContext(new UiSynchronizationContext());
            }
        }

        public override void Post(SendOrPostCallback d, object state)
        {
            if (d == null)
            {
                return;
            }

            UiDispatcher.Post(() =>
            {
                try
                {
                    d(state);
                }
                catch (Exception ex)
                {
                    Log.Error(MaveroApp.LogTag,
                        "Continuation failed on UI thread: " + ex.GetType().FullName + ": " + ex.Message);
                    Diagnostics.ReportNonFatal(ex, "await continuation");
                }
            });
        }

        public override void Send(SendOrPostCallback d, object state)
        {
            if (d == null)
            {
                return;
            }

            if (UiDispatcher.IsOnUiThread)
            {
                // Inline on the DALi thread — a pump round-trip would deadlock
                // nothing but would still be pointless latency.
                d(state);
                return;
            }

            // Blocking Send from a background thread: queue the work and wait.
            // Nothing in the app calls Send today (await only uses Post), but
            // BCL internals occasionally do — block without holding the pump.
            using (ManualResetEventSlim done = new ManualResetEventSlim(false, 0))
            {
                Exception captured = null;
                UiDispatcher.Post(() =>
                {
                    try
                    {
                        d(state);
                    }
                    catch (Exception ex)
                    {
                        captured = ex;
                    }
                    finally
                    {
                        done.Set();
                    }
                });

                done.Wait(TimeSpan.FromSeconds(10));

                if (captured != null)
                {
                    Log.Warn(MaveroApp.LogTag, "Send failed: " + captured.Message);
                    throw captured;
                }
            }
        }
    }
}
