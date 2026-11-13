// ============================================================
// Mavero TV — application lifecycle (Tizen.NUI).
//
// NUIApplication boots the DALi/NUI toolkit, creates the default
// TV window and calls OnCreate, where we mount the HomePage view.
// The dark background is painted once here (window-level) and per
// view in Theme-matched colors, so the app never flashes white on
// boot.
// ============================================================
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>
    /// Application lifecycle. Creates the default TV window and mounts
    /// the <see cref="HomePage"/> on it.
    /// </summary>
    public class MaveroApp : NUIApplication
    {
        /// <summary>Log tag used across the native app (dlog/sdb logcat).</summary>
        public const string LogTag = "MAVERO";

        private HomePage _homePage;

        protected override void OnCreate()
        {
            base.OnCreate();

            Window window = GetDefaultWindow();
            window.BackgroundColor = Theme.Background;
            window.KeyEvent += OnKeyEvent;

            _homePage = new HomePage();
            window.Add(_homePage);
        }

        // Back key: terminate the app for now. Remote/DPad navigation
        // (back stack, focus engine) lands with the data-driven UI phase.
        private void OnKeyEvent(object sender, Window.KeyEventArgs e)
        {
            if (e.Key.State == Key.StateType.Up && e.Key.KeyPressedName == "XF86Back")
            {
                Exit();
            }
        }

        protected override void OnPause()
        {
            base.OnPause();
        }

        protected override void OnResume()
        {
            base.OnResume();
        }

        protected override void OnTerminate()
        {
            base.OnTerminate();
        }
    }
}
