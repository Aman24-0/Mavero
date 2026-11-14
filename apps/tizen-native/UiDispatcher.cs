// ============================================================
// Mavero TV — UI-thread marshaling helper.
//
// Tizen.NUI (tizen60 profile) installs no SynchronizationContext,
// so await-continuations (ApiService's HttpClient tasks) resume on
// the thread pool. DALi views must only be touched from the DALi
// (UI) thread, so background work posts closures here and a small
// Timer — a DALi object whose Tick fires on the UI thread — drains
// the queue.
//
// The pump is deliberately created eagerly (Start from the UI
// thread only, in the HomePage constructor): Timer must be
// constructed on the DALi thread, and Post() must therefore never
// touch it. A permanent 50ms pump that peeks at an empty queue is
// negligible for a TV app.
//
// Drain() absorbs exceptions from posted closures and routes them
// to the on-screen Diagnostics overlay (see Diagnostics.cs): one
// failing continuation (e.g. a player event racing a disposed view)
// must never wedge the pump — and, on a TV with no sdb attached, it
// must never die SILENTLY either. The overlay shows the error so a
// photo of the TV is enough to diagnose it.
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
        private const int PumpIntervalMs = 50;
        private const int MaxActionsPerTick = 16;

        private static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();
        private static Tizen.NUI.Timer _pump;

        /// <summary>Id of the DALi (main) thread, captured by Start().</summary>
        private static int _mainThreadId = -1;

        /// <summary>True when the calling thread is the DALi (UI) thread.</summary>
        public static bool IsOnUiThread
        {
            get { return _mainThreadId >= 0 && Thread.CurrentThread.ManagedThreadId == _mainThreadId; }
        }

        /// <summary>Starts the pump. Must be called once, from the UI thread.</summary>
        public static void Start()
        {
            _mainThreadId = Thread.CurrentThread.ManagedThreadId;

            if (_pump != null)
            {
                return;
            }

            _pump = new Tizen.NUI.Timer(PumpIntervalMs);
            _pump.Tick += (object source, Tizen.NUI.Timer.TickEventArgs args) =>
            {
                Drain();
                return true; // keep the pump running for the app lifetime
            };
            _pump.Start();
        }

        /// <summary>Safe from any thread; the action runs on the UI thread.</summary>
        public static void Post(Action action)
        {
            Queue.Enqueue(action);
        }

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
                    Log.Error(MaveroApp.LogTag, $"UI dispatch failed: {ex.Message}");
                    // Keep the app alive AND make the failure visible —
                    // field TVs have no sdb; the screen is the log.
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
