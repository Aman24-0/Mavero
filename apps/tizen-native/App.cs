// ============================================================
// Mavero TV — application lifecycle + screen navigation (Tizen.NUI).
//
// NUIApplication boots the DALi/NUI toolkit, creates the default
// TV window and calls OnCreate, where we mount the HomePage view.
// The dark background is painted once here (window-level) and per
// view in Theme-matched colors, so the app never flashes white on
// boot.
//
// Screen navigation (two-level stack):
//   Home --Enter on card--> Detail --Back key / Back button--> Home
//   - OpenDetail: clears DALi focus, hides the HomePage (kept alive
//     so rails, scroll positions and focus survive the round-trip),
//     then adds the DetailPage on top of the window;
//   - CloseDetail: marks the detail page closed (fences its queued
//     fetch binding), clears focus, removes + disposes the page,
//     re-shows the HomePage and restores focus to the card the user
//     came from;
//   - Hardware Back key (remote: XF86Back, platform code 10009;
//     emulator/desktop: Escape): pops Detail when one is open,
//     otherwise terminates the app.
// ============================================================
using Tizen;
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>
    /// Application lifecycle and screen navigation. Mounts the
    /// <see cref="HomePage"/>, opens the <see cref="DetailPage"/> on
    /// selection and pops back on the hardware Back key.
    /// </summary>
    public class MaveroApp : NUIApplication
    {
        /// <summary>Log tag used across the native app (dlog/sdb logcat).</summary>
        public const string LogTag = "MAVERO";

        /// <summary>Platform key code of the remote's Back button (Tizen keymap).</summary>
        private const int BackKeyCode = 10009;

        private Window _window;
        private HomePage _homePage;
        private DetailPage _detailPage;

        protected override void OnCreate()
        {
            base.OnCreate();

            _window = GetDefaultWindow();
            _window.BackgroundColor = Theme.Background;
            _window.KeyEvent += OnKeyEvent;

            _homePage = new HomePage();
            _homePage.ItemSelected += OnItemSelected;
            _window.Add(_homePage);
        }

        // ---- screen navigation --------------------------------------------

        private void OnItemSelected(MediaItem item)
        {
            OpenDetail(item);
        }

        private void OpenDetail(MediaItem item)
        {
            if (_detailPage != null)
            {
                return; // already showing a detail page
            }

            Log.Info(LogTag, $"Navigate Home -> Detail: '{item.Title}' (id={item.Id})");

            // Detach focus from the card before the page hides, so the
            // FocusManager never holds a hidden view as its current focus.
            FocusManager.Instance.SetCurrentFocusView(null);
            _homePage.Hide();

            _detailPage = new DetailPage(item);
            _detailPage.PlayRequested += OnDetailPlayRequested;
            _detailPage.CloseRequested += OnDetailCloseRequested;
            _window.Add(_detailPage);
            _detailPage.SetInitialFocus();
        }

        private void CloseDetail()
        {
            if (_detailPage == null)
            {
                return;
            }

            DetailPage page = _detailPage;
            _detailPage = null;

            page.MarkClosing();
            page.PlayRequested -= OnDetailPlayRequested;
            page.CloseRequested -= OnDetailCloseRequested;

            // Clear focus before removing the page: the focused Play/Back
            // button must not linger in the FocusManager as its tree dies.
            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();

            _homePage.Show();
            _homePage.RestoreFocus();

            Log.Info(LogTag, "Navigate Detail -> Home (focus restored to the last card)");
        }

        private void OnDetailPlayRequested()
        {
            // The native video player consumes this in the next iteration.
            Log.Info(LogTag, "PlayRequested reached app layer — video player lands next iteration");
        }

        private void OnDetailCloseRequested()
        {
            CloseDetail();
        }

        // Back key: pop Detail when one is open, otherwise exit the app.
        private void OnKeyEvent(object sender, Window.KeyEventArgs e)
        {
            if (e.Key.State != Key.StateType.Up)
            {
                return;
            }

            // The remote reports the Back key as "XF86Back" (platform code
            // 10009); desktops/emulators surface it as "Escape".
            bool isBack = e.Key.KeyPressedName == "XF86Back"
                || e.Key.KeyPressedName == "Escape"
                || e.Key.KeyCode == BackKeyCode;

            if (!isBack)
            {
                return;
            }

            if (_detailPage != null)
            {
                CloseDetail();
            }
            else
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
