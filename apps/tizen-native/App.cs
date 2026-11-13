// ============================================================
// Mavero TV — application lifecycle + screen navigation (Tizen.NUI).
//
// NUIApplication boots the DALi/NUI toolkit, creates the default
// TV window and calls OnCreate, where we mount the HomePage view.
// The dark background is painted once here (window-level) and per
// view in Theme-matched colors, so the app never flashes white on
// boot.
//
// Screen navigation (three-level stack):
//   Home --Enter on card--> Detail --PLAY/episode--> Player --Back--> Detail
//   --Back--> Home --Back--> exit
//
// Series/anime playback carries a PlaybackTarget (season + episode)
// from the detail page's Play button (Season 1 Episode 1 default) or
// the picked EpisodeCard; movies pass null.
//
//   - OpenDetail: clears DALi focus, hides the HomePage (kept alive
//     so rails, scroll positions and focus survive the round-trip),
//     then adds the DetailPage on top of the window;
//   - OpenPlayer: clears focus, hides the DetailPage and switches
//     the WINDOW background to transparent — the video rendered by
//     Tizen.Multimedia.Player composites on the video layer BELOW
//     the DALi surface, so every opaque layer above it must go or
//     it would cover the picture (PlayerPage itself is transparent
//     and shows an opaque black curtain until playback starts);
//   - ClosePlayer: tears down the player, restores the opaque
//     window background and re-shows the DetailPage (Play focused);
//   - CloseDetail: marks the detail page closed (fences its queued
//     fetch binding), clears focus, removes + disposes the page,
//     re-shows the HomePage and restores focus to the card the user
//     came from;
//   - Hardware Back key (remote: XF86Back, platform code 10009;
//     emulator/desktop: Escape): pops the topmost screen — a popup
//     on the player first (PlayerPage.HandleBack), then the player,
//     then the detail page, then terminates the app. Non-Back keys
//     are forwarded to the player as remote activity so the overlay
//     can wake up.
// ============================================================
using Tizen;
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>
    /// Application lifecycle and screen navigation. Mounts the
    /// <see cref="HomePage"/>, opens the <see cref="DetailPage"/> on
    /// selection, the <see cref="PlayerPage"/> on PLAY and pops back
    /// level by level on the hardware Back key.
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
        private PlayerPage _playerPage;
        private MediaItem _detailItem;

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
            _detailItem = item;

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
            _detailItem = null;

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

        private void OnDetailCloseRequested()
        {
            CloseDetail();
        }

        private void OnDetailPlayRequested(PlaybackTarget target)
        {
            OpenPlayer(target);
        }

        private void OpenPlayer(PlaybackTarget target)
        {
            if (_playerPage != null || _detailPage == null)
            {
                return;
            }

            Log.Info(LogTag,
                $"Navigate Detail -> Player: '{_detailItem.Title}' (id={_detailItem.Id})" +
                (target != null ? $" target={target.Label}" : string.Empty));

            FocusManager.Instance.SetCurrentFocusView(null);
            _detailPage.Hide();

            // The video layer composites BELOW the DALi surface: everything
            // opaque above it must go transparent or it would cover the
            // picture. The page paints its own black curtain until playback.
            _window.BackgroundColor = Color.Transparent;

            _playerPage = new PlayerPage(_detailItem, _window, target);
            _playerPage.CloseRequested += OnPlayerCloseRequested;
            _window.Add(_playerPage);
            _playerPage.SetInitialFocus();
        }

        private void ClosePlayer()
        {
            if (_playerPage == null)
            {
                return;
            }

            PlayerPage page = _playerPage;
            _playerPage = null;

            page.MarkClosing();
            page.ShutdownPlayer();
            page.CloseRequested -= OnPlayerCloseRequested;

            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();

            _window.BackgroundColor = Theme.Background;
            _detailPage.Show();
            _detailPage.RestoreFocus();

            Log.Info(LogTag, "Navigate Player -> Detail");
        }

        private void OnPlayerCloseRequested()
        {
            ClosePlayer();
        }

        // ---- hardware keys --------------------------------------------------

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

            if (_playerPage != null)
            {
                if (isBack)
                {
                    // A popup on the player eats the first Back press.
                    if (!_playerPage.HandleBack())
                    {
                        ClosePlayer();
                    }
                }
                else
                {
                    // D-pad keys with nothing focused reach the window here —
                    // they wake the auto-hidden overlay.
                    _playerPage.NotifyRemoteActivity();
                }
                return;
            }

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
