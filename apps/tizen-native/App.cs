// ============================================================
// Mavero TV — application lifecycle + screen navigation (Tizen.NUI).
//
// NUIApplication boots the DALi/NUI toolkit, creates the default
// TV window and calls OnCreate, where we mount the HomePage view.
// The dark background is painted once here (window-level) and per
// view in Theme-matched colors, so the app never flashes white on
// boot.
//
// Screen navigation (four-level stack):
//   Home --Enter on card--> Detail --PLAY/episode--> Player --Back--> Detail
//   --Back--> Home --Back--> exit
//   Home --SEARCH pill / search key--> Search --Enter on result--> Detail
//   (any later level Back pops one screen: Player -> Detail -> Search -> Home
//   -> exit; the Detail page returns to whichever screen opened it — Home
//   or Search — via _detailReturnPage)
//
// Series/anime playback carries a PlaybackTarget (season + episode)
// from the detail page's Play button (Season 1 Episode 1 default) or
// the picked EpisodeCard; movies pass null.
//
//   - OpenSearch: clears DALi focus, hides the HomePage (kept alive
//     so rails, scroll positions and focus survive the round-trip),
//     then adds the SearchPage on top of the window;
//   - CloseSearch: marks the search page closed (fences its queued
//     search binds), clears focus, removes + disposes the page,
//     re-shows the HomePage and restores focus to the card the user
//     came from;
//   - OpenDetail: clears DALi focus, hides the page the user is on
//     (HomePage OR SearchPage — remembered in _detailReturnPage so
//     Back restores the right one; both stay alive so their state
//     survives the round-trip), then adds the DetailPage on top of
//     the window;
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
//     re-shows the remembered return page (Home or Search) and
//     restores focus to the card the user came from;
//   - Hardware Back key (remote: XF86Back, platform code 10009;
//     emulator/desktop: Escape): pops the topmost screen — a popup
//     on the player first (PlayerPage.HandleBack), then the player,
//     then the detail page, then the search page, then terminates
//     the app. Non-Back keys are forwarded to the player as remote
//     activity so the overlay can wake up; a remote's dedicated
//     search key (XF86Search) opens Search directly from Home.
// ============================================================
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>
    /// Application lifecycle and screen navigation. Mounts the
    /// <see cref="HomePage"/>, opens the <see cref="SearchPage"/> from the
    /// header's SEARCH pill, the <see cref="DetailPage"/> on selection (from
    /// either screen), the <see cref="PlayerPage"/> on PLAY and pops back
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
        private SearchPage _searchPage;
        private DetailPage _detailPage;
        private PlayerPage _playerPage;
        private MediaItem _detailItem;

        /// <summary>The screen (Home or Search) the Detail page was opened
        /// from — Back returns to it and restores its focus.</summary>
        private View _detailReturnPage;

        protected override void OnCreate()
        {
            base.OnCreate();

            _window = GetDefaultWindow();
            _window.BackgroundColor = Theme.Background;
            _window.KeyEvent += OnKeyEvent;

            _homePage = new HomePage();
            _homePage.ItemSelected += OnItemSelected;
            _homePage.SearchRequested += OnSearchRequested;
            _window.Add(_homePage);
        }

        // ---- screen navigation --------------------------------------------

        private void OnItemSelected(MediaItem item)
        {
            OpenDetail(item);
        }

        private void OnSearchRequested()
        {
            OpenSearch();
        }

        private void OpenSearch()
        {
            if (_searchPage != null || _detailPage != null || _playerPage != null)
            {
                return; // search is only reachable from a clean Home screen
            }

            Log.Info(LogTag, "Navigate Home -> Search");

            // Detach focus from the card before the page hides, so the
            // FocusManager never holds a hidden view as its current focus.
            FocusManager.Instance.SetCurrentFocusView(null);
            _homePage.Hide();

            _searchPage = new SearchPage();
            _searchPage.ItemSelected += OnSearchItemSelected;
            _searchPage.CloseRequested += OnSearchCloseRequested;
            _window.Add(_searchPage);
            _searchPage.SetInitialFocus();
        }

        private void CloseSearch()
        {
            if (_searchPage == null)
            {
                return;
            }

            SearchPage page = _searchPage;
            _searchPage = null;

            page.MarkClosing();
            page.ItemSelected -= OnSearchItemSelected;
            page.CloseRequested -= OnSearchCloseRequested;

            // Clear focus before removing the page: the focused key must
            // not linger in the FocusManager as its tree dies.
            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();

            _homePage.Show();
            _homePage.RestoreFocus();

            Log.Info(LogTag, "Navigate Search -> Home (focus restored to the last card)");
        }

        private void OnSearchItemSelected(MediaItem item)
        {
            OpenDetail(item);
        }

        private void OnSearchCloseRequested()
        {
            CloseSearch();
        }

        private void OpenDetail(MediaItem item)
        {
            if (_detailPage != null)
            {
                return; // already showing a detail page
            }

            Log.Info(LogTag, $"Navigate {(_searchPage != null ? "Search" : "Home")} -> Detail: " +
                $"'{item.Title}' (id={item.Id})");
            _detailItem = item;

            // Detach focus from the card before the page hides, so the
            // FocusManager never holds a hidden view as its current focus.
            // The page beneath (Home or Search) is remembered so Back
            // restores the right one; both stay alive with their state.
            FocusManager.Instance.SetCurrentFocusView(null);
            if (_searchPage != null)
            {
                _detailReturnPage = _searchPage;
                _searchPage.Hide();
            }
            else
            {
                _detailReturnPage = _homePage;
                _homePage.Hide();
            }

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

            if (_detailReturnPage != null && _detailReturnPage == _searchPage)
            {
                _searchPage.Show();
                _searchPage.RestoreFocus();
            }
            else
            {
                _homePage.Show();
                _homePage.RestoreFocus();
            }
            _detailReturnPage = null;

            Log.Info(LogTag, "Navigate Detail -> " +
                (_searchPage != null ? "Search" : "Home") + " (focus restored to the last card)");
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
                // A remote's dedicated search key (X11 keysym XF86Search)
                // opens Search directly from a clean Home screen.
                if (_playerPage == null && _detailPage == null && _searchPage == null
                    && e.Key.KeyPressedName == "XF86Search")
                {
                    OpenSearch();
                }

                return;
            }

            if (_detailPage != null)
            {
                CloseDetail();
            }
            else if (_searchPage != null)
            {
                CloseSearch();
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
