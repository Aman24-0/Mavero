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
// Drain() absorbs exceptions from posted closures (logged via
// Tizen.Log): one failing continuation (e.g. a player event racing
// a disposed view) must never wedge the pump for every later post.
// ============================================================
using System;
using System.Collections.Concurrent;
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
        private static Timer _pump;

        /// <summary>Starts the pump. Must be called once, from the UI thread.</summary>
        public static void Start()
        {
            if (_pump != null)
            {
                return;
            }

            _pump = new Timer(PumpIntervalMs);
            _pump.Tick += (object source, Timer.TickEventArgs args) =>
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
                }
            }
        }
    }
}
