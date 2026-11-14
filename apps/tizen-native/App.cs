// ============================================================
// Mavero TV — application lifecycle + screen navigation (Tizen.NUI).
//
// NUIApplication boots the DALi/NUI toolkit, creates the default
// TV window and calls OnCreate, where we mount the HomePage view.
// The dark background is painted once here (window-level) and per
// view in Theme-matched colors, so the app never flashes white on
// boot.
//
// Screen navigation (six-level stack):
//   Home --Enter on card--> Detail --PLAY/episode--> Player --Back--> Detail
//   --Back--> Home --Back--> exit
//   Home --SEARCH pill / search key--> Search --Enter on result--> Detail
//   Home --MY LIST pill--> (signed in) My List --Enter on title--> Detail
//   Home --MY LIST pill--> (guest) Login --pairing approved--> My List
//   (any later level Back pops one screen: Player -> Detail -> Search ->
//   My List -> Login -> exit; the Detail page returns to whichever screen
//   opened it — Home, Search or My List — via _detailReturnPage)
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
//   - OpenMyList / CloseMyList: same round-trip pattern for the My
//     List grid (only reachable when signed in — AuthSession);
//   - OpenLogin / CloseLogin: the device-pairing sign-in screen for
//     guests; a completed pairing (SignedInCompleted) closes Login
//     and lands on My List — the intent the user expressed when
//     pressing MY LIST;
//   - OpenDetail: clears DALi focus, hides the page the user is on
//     (HomePage, SearchPage OR MyListPage — remembered in
//     _detailReturnPage so Back restores the right one; all stay
//     alive so their state survives the round-trip), then adds the
//     DetailPage on top of the window;
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
//     re-shows the remembered return page (Home, Search or My List)
//     and restores focus to the card the user came from;
//   - Hardware Back key (remote: XF86Back, platform code 10009;
//     emulator/desktop: Escape): pops the topmost screen — a popup
//     on the player first (PlayerPage.HandleBack), then the player,
//     then the detail page, then the search page, then My List,
//     then Login, then terminates the app. Non-Back keys are
//     forwarded to the player as remote activity so the overlay can
//     wake up; a remote's dedicated search key (XF86Search) opens
//     Search directly from Home.
// ============================================================
using System;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>
    /// Application lifecycle and screen navigation. Mounts the
    /// <see cref="HomePage"/>, opens the <see cref="SearchPage"/> from the
    /// header's SEARCH pill, the <see cref="MyListPage"/> (or the
    /// <see cref="LoginPage"/> for guests) from the MY LIST pill, the
    /// <see cref="DetailPage"/> on selection (from Home, Search or My List),
    /// the <see cref="PlayerPage"/> on PLAY and pops back level by level on
    /// the hardware Back key.
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
        private MyListPage _myListPage;
        private LoginPage _loginPage;
        private DetailPage _detailPage;
        private PlayerPage _playerPage;
        private MediaItem _detailItem;

        /// <summary>Shared API client — created in BOOT STAGE 2 (after the
        /// boot console exists) so a crash during HttpClient/TLS setup is
        /// pinpointed on screen instead of dying silently.</summary>
        private ApiService _apiService;

        /// <summary>The screen (Home, Search or My List) the Detail page was
        /// opened from — Back returns to it and restores its focus.</summary>
        private View _detailReturnPage;

        protected override void OnCreate()
        {
            base.OnCreate();

            Log.Info(LogTag, "Mavero TV boot: OnCreate entered");

            // UI-THREAD CONTRACT (Tizen NUI / DALi):
            //   1. Install the SynchronizationContext FIRST — every `await`
            //      continuation captured on the DALi thread from here on runs
            //      back on the DALi thread through UiDispatcher's pump, so
            //      post-await UI mutations can never land on the thread pool
            //      (the classic silent SIGSEGV on TV hardware).
            //   2. Start the dispatcher pump — ONE persistent Tizen.NUI.Timer
            //      created + started HERE on the DALi thread; background
            //      threads only ConcurrentQueue.Enqueue (zero native calls).
            //      Starting it BEFORE anything risky also guarantees that
            //      every Diagnostics.Report below can actually render.
            //   3. Register the window with Diagnostics — every caught failure
            //      renders on screen (the field TV has no sdb / dlog access).
            UiSynchronizationContext.Install();
            _window = GetDefaultWindow();
            Diagnostics.Initialize(_window);
            UiDispatcher.Initialize();

            try
            {
                // Restore the persisted session (secure store, file fallback)
                // BEFORE any page mounts — DetailPage builds its My List pill
                // from AuthSession at construction time.
                AuthSession.LoadFromDisk();

                _window.BackgroundColor = Theme.Background;
                _window.KeyEvent += OnKeyEvent;

                Log.Info(LogTag, "Mavero TV boot: default window ready, staging boot console");

                // LIVE BOOT CONSOLE: paints a bottom-strip log on the TV and
                // runs the risky boot steps in staged 150ms ticks — each
                // step's [BOOT k/6] line renders on screen BEFORE its code
                // executes, so a NATIVE crash (SIGSEGV/SIGABRT — invisible to
                // every managed handler) still leaves the culprit's line on
                // the screen. The TV is the log; a photo of it suffices.
                BootLog.Initialize(_window);

                BootStage[] stages = new BootStage[]
                {
                    new BootStage("[BOOT 1/6] Window & Dispatcher initialized",
                        BootStage1_Confirm),
                    new BootStage("[BOOT 2/6] Creating ApiService & HttpClient (plain TLS first)...",
                        BootStage2_CreateApi),
                    new BootStage("[BOOT 3/6] Constructing HomePage shell (Header & Empty Layout)...",
                        BootStage3_BuildShell),
                    new BootStage("[BOOT 4/6] Starting network fetch (Home feed)...",
                        BootStage4_StartFetch),
                };
                BootLog.RunStages(stages);
            }
            catch (Exception ex)
            {
                // Boot must never die silently: the user has no sdb. Show the
                // error + stack on screen (the overlay paints asset-free, so
                // this works even if the res/ payload is broken).
                Diagnostics.Report(ex, "startup", null);
            }
        }

        // ---- staged boot steps (BootLog.RunStages calls these) ---------------

        /// <summary>Stage 1 — confirms the synchronous pre-console boot (window,
        /// sync context, dispatcher pump, session restore) on screen.</summary>
        private void BootStage1_Confirm()
        {
            Log.Info(LogTag, "Mavero TV boot: stage 1 — window + dispatcher ready");
        }

        /// <summary>Stage 2 — HttpClient/TLS setup in isolation. A native abort
        /// here (TLS/handler profile issue on Tizen Mono) leaves
        /// "[BOOT 2/6] ..." as the last console line on screen.</summary>
        private void BootStage2_CreateApi()
        {
            _apiService = new ApiService();
            Log.Info(LogTag, "Mavero TV boot: stage 2 — ApiService + HttpClient created");
        }

        /// <summary>Stage 3 — the HomePage SHELL only (header, rails host, status
        /// label; no network). A native abort during NUI construction leaves
        /// "[BOOT 3/6] ..." as the last console line on screen.</summary>
        private void BootStage3_BuildShell()
        {
            _homePage = new HomePage(_apiService);
            _homePage.ItemSelected += OnItemSelected;
            _homePage.SearchRequested += OnSearchRequested;
            _homePage.MyListRequested += OnMyListRequested;
            _window.Add(_homePage);

            // Window children stack in add order: HomePage (added LAST) would
            // cover the boot console with its opaque background. Raise the
            // console back on top so stages 4-6 stay visible.
            BootLog.RaiseToTop();

            Log.Info(LogTag, "Mavero TV boot: stage 3 — HomePage shell mounted");
        }

        /// <summary>Stage 4 — starts the home-feed pipeline; its network-paced
        /// continuations report BOOT 5/6 (response + parse) and BOOT 6/6
        /// (MediaCard bind) on the console as they happen.</summary>
        private void BootStage4_StartFetch()
        {
            _homePage.BeginFetch();
            Log.Info(LogTag, "Mavero TV boot: stage 4 — home fetch started");
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

        private void OnMyListRequested()
        {
            if (AuthSession.IsSignedIn)
            {
                OpenMyList();
            }
            else
            {
                OpenLogin();
            }
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

        // ---- My List / Login navigation ------------------------------------

        private void OpenMyList()
        {
            if (_myListPage != null || _loginPage != null || _detailPage != null || _playerPage != null)
            {
                return; // My List is only reachable from a clean Home screen
            }

            Log.Info(LogTag, "Navigate Home -> My List");

            FocusManager.Instance.SetCurrentFocusView(null);
            _homePage.Hide();

            _myListPage = new MyListPage();
            _myListPage.ItemSelected += OnMyListItemSelected;
            _myListPage.CloseRequested += OnMyListCloseRequested;
            _myListPage.LoginRequested += OnMyListLoginRequested;
            _window.Add(_myListPage);
            _myListPage.SetInitialFocus();
        }

        private void CloseMyList()
        {
            if (_myListPage == null)
            {
                return;
            }

            MyListPage page = _myListPage;
            _myListPage = null;

            page.MarkClosing();
            page.ItemSelected -= OnMyListItemSelected;
            page.CloseRequested -= OnMyListCloseRequested;
            page.LoginRequested -= OnMyListLoginRequested;

            // Clear focus before removing the page: the focused key must
            // not linger in the FocusManager as its tree dies.
            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();

            _homePage.Show();
            _homePage.RestoreFocus();

            Log.Info(LogTag, "Navigate My List -> Home (focus restored to the last card)");
        }

        private void OnMyListItemSelected(MediaItem item)
        {
            OpenDetail(item);
        }

        private void OnMyListCloseRequested()
        {
            CloseMyList();
        }

        /// <summary>The session died on the My List screen — swap to Login.</summary>
        private void OnMyListLoginRequested()
        {
            CloseMyList();
            OpenLogin();
        }

        private void OpenLogin()
        {
            if (_loginPage != null || _myListPage != null || _detailPage != null || _playerPage != null)
            {
                return; // Login is only reachable from a clean Home screen
            }

            Log.Info(LogTag, "Navigate Home -> Login (device pairing)");

            FocusManager.Instance.SetCurrentFocusView(null);
            _homePage.Hide();

            _loginPage = new LoginPage();
            _loginPage.CloseRequested += OnLoginCloseRequested;
            _loginPage.SignedInCompleted += OnLoginSignedInCompleted;
            _loginPage.OpenMyListRequested += OnLoginOpenMyListRequested;
            _window.Add(_loginPage);
            _loginPage.SetInitialFocus();
        }

        private void CloseLogin()
        {
            if (_loginPage == null)
            {
                return;
            }

            LoginPage page = _loginPage;
            _loginPage = null;

            page.MarkClosing();
            page.CloseRequested -= OnLoginCloseRequested;
            page.SignedInCompleted -= OnLoginSignedInCompleted;
            page.OpenMyListRequested -= OnLoginOpenMyListRequested;

            // Clear focus before removing the page: the focused key must
            // not linger in the FocusManager as its tree dies.
            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();

            _homePage.Show();
            _homePage.RestoreFocus();

            Log.Info(LogTag, "Navigate Login -> Home (focus restored to the last card)");
        }

        /// <summary>Close Login WITHOUT showing Home underneath (the caller
        /// immediately opens another page on top of the still-hidden Home).</summary>
        private void CloseLoginOnly()
        {
            if (_loginPage == null)
            {
                return;
            }

            LoginPage page = _loginPage;
            _loginPage = null;

            page.MarkClosing();
            page.CloseRequested -= OnLoginCloseRequested;
            page.SignedInCompleted -= OnLoginSignedInCompleted;
            page.OpenMyListRequested -= OnLoginOpenMyListRequested;

            FocusManager.Instance.SetCurrentFocusView(null);
            _window.Remove(page);
            page.Dispose();
        }

        /// <summary>Pairing succeeded — the user pressed MY LIST to get here,
        /// so continue the intent and land on My List.</summary>
        private void OnLoginSignedInCompleted()
        {
            CloseLoginOnly();
            OpenMyList();
        }

        /// <summary>Already signed in, OPEN MY LIST pressed on the login screen.</summary>
        private void OnLoginOpenMyListRequested()
        {
            CloseLoginOnly();
            OpenMyList();
        }

        private void OnLoginCloseRequested()
        {
            CloseLogin();
        }

        private void OpenDetail(MediaItem item)
        {
            if (_detailPage != null)
            {
                return; // already showing a detail page
            }

            Log.Info(LogTag, $"Navigate {(_searchPage != null ? "Search" : _myListPage != null ? "My List" : "Home")} -> Detail: " +
                $"'{item.Title}' (id={item.Id})");
            _detailItem = item;

            // Detach focus from the card before the page hides, so the
            // FocusManager never holds a hidden view as its current focus.
            // The page beneath (Home, Search or My List) is remembered so
            // Back restores the right one; all stay alive with their state.
            FocusManager.Instance.SetCurrentFocusView(null);
            if (_searchPage != null)
            {
                _detailReturnPage = _searchPage;
                _searchPage.Hide();
            }
            else if (_myListPage != null)
            {
                _detailReturnPage = _myListPage;
                _myListPage.Hide();
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
            else if (_detailReturnPage != null && _detailReturnPage == _myListPage)
            {
                _myListPage.Show();
                _myListPage.RestoreFocus();
            }
            else
            {
                _homePage.Show();
                _homePage.RestoreFocus();
            }
            _detailReturnPage = null;

            Log.Info(LogTag, "Navigate Detail -> " +
                (_searchPage != null ? "Search" : _myListPage != null ? "My List" : "Home") +
                " (focus restored to the last card)");
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
            try
            {
                HandleKeyEvent(e);
            }
            catch (Exception ex)
            {
                // A key-handler escape must not kill the app: show it.
                Diagnostics.Report(ex, "key handling", null);
            }
        }

        private void HandleKeyEvent(Window.KeyEventArgs e)
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

            // While the diagnostics panel is up it owns the screen: RETRY is
            // a focused button (Enter runs it); BACK leaves the app for real.
            if (Diagnostics.IsShowing)
            {
                if (isBack)
                {
                    Exit();
                }
                return;
            }

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
                    && _myListPage == null && _loginPage == null
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
            else if (_myListPage != null)
            {
                CloseMyList();
            }
            else if (_loginPage != null)
            {
                CloseLogin();
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
