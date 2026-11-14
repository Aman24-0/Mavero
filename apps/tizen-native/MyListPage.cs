// ============================================================
// Mavero TV — My List screen (Tizen.NUI, API 6).
//
// The signed-in user's cloud favorites, rendered as the same 6-column
// poster grid the search results use. Opened from the Home header's
// MY LIST pill (only when signed in — App.cs routes guests to the
// LoginPage instead); App.cs handles the hardware Back key to pop
// back to the HomePage.
//
// Data: GET /api/account/sync (authenticated via the AuthSession
// cookie jar — the session cookies ride along, and every response's
// Set-Cookie is captured back so server-side token refreshes keep
// the session alive). The server filters tombstones and orders the
// rows by updated_at (newest first); the page projects each
// FavoriteRecord into the MediaItem shape MediaCard renders:
//   Id = contentId ("movie-969681"), Title/Poster/Year/... from the
//   record's snapshot, Type = the record's canonical contentType.
//
// Layout on the fixed 1920x1080 screen:
//   [0..160]    header — MAVERO brand + accent bar, BACK pill top-right;
//   [168..212]  subtitle — "N titles - signed in as {email}";
//   [232..1080] grid viewport — vertical ScrollView, 6 MediaCards per
//               row, keep-in-view scrolling on focus.
//
// States (honest, never fake data):
//   loading     — "Loading your list...";
//   empty       — "Your list is empty - add titles from any detail page";
//   unsigned    — session missing/expired/revoked: a message plus a
//                 SIGN IN pill (LoginRequested -> App.cs swaps in the
//                 LoginPage);
//   unavailable — transport failure;
//   bound       — subtitle + grid.
//
// D-pad focus flow (every link explicit):
//   BACK --Down--> first card; row 0 cards --Up--> BACK; Left/Right
//   chains along each row (edges clamp); nearest-column Up/Down
//   between rows. Enter on a card opens the DetailPage.
//
// Threading: the fetch completes on the thread pool; grid binding is
// marshaled through UiDispatcher (DALi objects are only touched on
// the UI thread). MarkClosing() fences binds against a page the user
// already backed out of.
//
// API 6 notes: same pivot pattern, ScrollView usage and CS0618
// suppression as SearchPage.cs / HomePage.cs.
// ============================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

// CS0618: Tizen.NUI.ScrollView is the only scrollable container in the
// API6 profile (same suppression as HomePage.cs / SearchPage.cs).
#pragma warning disable CS0618

namespace MaveroTv
{
    /// <summary>My List screen: the signed-in user's saved titles as a grid.</summary>
    public class MyListPage : View
    {
        // Honest state lines (no fake content on outages).
        private const string StatusLoading = "Loading your list...";
        private const string StatusEmpty = "Your list is empty - add titles from any detail page";
        private const string StatusUnavailable = "My List unavailable - check the network connection";
        private const string StatusSignedOut = "Your session ended - sign in to see your list";

        private readonly ApiService _api = new ApiService();
        private readonly List<List<MediaCard>> _rows = new List<List<MediaCard>>();

        private FocusButton _backButton;
        private FocusButton _signInButton;
        private TextLabel _subtitle;
        private TextLabel _status;
        private ScrollView _gridScroll;
        private View _gridContent;
        private bool _closed;

        /// <summary>The card the user last focused — restored after Detail round-trips.</summary>
        private MediaCard _focusedCard;

        /// <summary>Raised when the user presses Enter/OK on a saved title card.</summary>
        public event Action<MediaItem> ItemSelected;

        /// <summary>Raised when the user leaves the screen (BACK pill or the
        /// hardware Back key).</summary>
        public event Action CloseRequested;

        /// <summary>Raised when the session is gone and the user asks to sign
        /// in (SIGN IN pill) — App.cs swaps in the LoginPage.</summary>
        public event Action LoginRequested;

        public MyListPage()
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            Add(CreateHeader());
            _subtitle = CreateSubtitle();
            Add(_subtitle);
            CreateGridHost();

            _status = CreateStatus();
            Add(_status);

            _signInButton = new FocusButton("SIGN IN", Theme.HeaderSearchButtonWidth,
                Theme.HeaderSearchButtonHeight, true)
            {
                // Centered under the status line.
                Position2D = new Position2D(Theme.ScreenWidth / 2,
                    Theme.MyListViewportY + 200)
            };
            _signInButton.Selected += OnSignInSelected;
            _signInButton.Hide();
            Add(_signInButton);

            UiDispatcher.Start(); // idempotent; pumps the list bind too
            _ = LoadListAsync();
        }

        /// <summary>Lands focus on BACK until the grid binds (the honest
        /// loading state has exactly one focusable — the escape hatch).</summary>
        public void SetInitialFocus()
        {
            FocusManager.Instance.SetCurrentFocusView(_backButton);
        }

        /// <summary>Fences in-flight list binding before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        /// <summary>Re-arms focus when the page returns from the Detail screen:
        /// the last focused card, else the first row, else BACK.</summary>
        public void RestoreFocus()
        {
            View target = _focusedCard;
            if (target == null && _rows.Count > 0 && _rows[0].Count > 0)
            {
                target = _rows[0][0];
            }
            if (target == null)
            {
                target = _backButton;
            }

            FocusManager.Instance.SetCurrentFocusView(target);
        }

        // ---- chrome -------------------------------------------------------

        /// <summary>Home-style header: brand + accent bar, BACK pill top-right.</summary>
        private View CreateHeader()
        {
            TextLabel brand = new TextLabel
            {
                Text = "MAVERO",
                TextColor = Theme.TextPrimary,
                PointSize = 36,
                Position2D = new Position2D(Theme.PageMargin, 48),
                Size2D = new Size2D(600, 72),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            View accentBar = new View
            {
                Position2D = new Position2D(Theme.PageMargin, 128),
                Size2D = new Size2D(96, 6),
                BackgroundColor = Theme.Accent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _backButton = new FocusButton("BACK", Theme.BackButtonWidth, Theme.BackButtonHeight, false)
            {
                Position2D = new Position2D(
                    Theme.SearchBackButtonX + Theme.BackButtonWidth / 2,
                    Theme.BackButtonY + Theme.BackButtonHeight / 2)
            };
            _backButton.Selected += OnBackSelected;

            View header = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, 160),
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            header.Add(brand);
            header.Add(accentBar);
            header.Add(_backButton);
            return header;
        }

        private static TextLabel CreateSubtitle()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.MyListSubtitlePointSize,
                Position2D = new Position2D(Theme.PageMargin, Theme.MyListSubtitleY),
                Size2D = new Size2D(Theme.RailViewportWidth, Theme.MyListSubtitleHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private static TextLabel CreateStatus()
        {
            return new TextLabel
            {
                Text = StatusLoading,
                TextColor = Theme.TextSecondary,
                PointSize = 20,
                Position2D = new Position2D(Theme.PageMargin, Theme.MyListViewportY + 48),
                Size2D = new Size2D(Theme.RailViewportWidth, 44),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Vertical viewport hosting the grid rows.</summary>
        private void CreateGridHost()
        {
            _gridContent = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.GridViewportWidth, 0), // height set once the list binds
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _gridScroll = new ScrollView
            {
                Position2D = new Position2D(Theme.GridX, Theme.MyListViewportY),
                Size2D = new Size2D(Theme.GridViewportWidth, Theme.MyListViewportHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
            };

            _gridScroll.Add(_gridContent);
            Add(_gridScroll);
        }

        // ---- data -> UI binding -------------------------------------------

        /// <summary>Reload entry for the diagnostics RETRY button (re-fetches
        /// the cloud list and rebinds the grid).</summary>
        public void ReloadList()
        {
            ShowStatus(StatusLoading);
            _ = LoadListAsync();
        }

        private async Task LoadListAsync()
        {
            try
            {
                Log.Info(MaveroApp.LogTag, "My List fetch: " +
                    (AuthSession.IsSignedIn ? "signed in" : "no session"));
                List<FavoriteRecord> favorites = await _api.FetchFavoritesAsync();
                Log.Info(MaveroApp.LogTag,
                    "My List fetched — " + (favorites != null ? favorites.Count.ToString() : "null") +
                    " record(s); binding on UI thread");
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    try
                    {
                        BindList(favorites);
                    }
                    catch (Exception ex)
                    {
                        // Visible failure with a working RETRY — never a silent exit.
                        Log.Error(MaveroApp.LogTag, "My List bind failed: " + ex.Message);
                        Diagnostics.Report(ex, "my list bind", ReloadList);
                    }
                });
            }
            catch (Exception ex)
            {
                Log.Error(MaveroApp.LogTag, "My List fetch failed: " + ex.Message);
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    ShowUnsignedOrUnavailable(StatusUnavailable);
                });
            }
        }

        private void BindList(List<FavoriteRecord> favorites)
        {
            if (favorites == null)
            {
                // Not signed in (401 cleared the stale session) — offer the
                // sign-in escape hatch instead of a bare error.
                ShowUnsignedOrUnavailable(StatusSignedOut);
                return;
            }

            if (favorites.Count == 0)
            {
                _subtitle.Text = "MY LIST";
                ShowStatus(StatusEmpty);
                return;
            }

            List<MediaItem> items = new List<MediaItem>();
            foreach (FavoriteRecord record in favorites)
            {
                MediaItem item = ToMediaItem(record);
                if (item != null)
                {
                    items.Add(item);
                }
            }

            if (items.Count == 0)
            {
                _subtitle.Text = "MY LIST";
                ShowStatus(StatusEmpty);
                return;
            }

            _subtitle.Text = items.Count + (items.Count == 1 ? " title" : " titles") +
                (string.IsNullOrEmpty(AuthSession.UserEmail)
                    ? string.Empty
                    : " - signed in as " + AuthSession.UserEmail);
            _status.Hide();

            BindGrid(items);

            Log.Info(MaveroApp.LogTag,
                "My List bound: " + items.Count + " title(s) in " + _rows.Count + " row(s)");
        }

        /// <summary>Projects a cloud favorite into the MediaItem shape MediaCard
        /// renders (ids/keys mirror the web app's favoriteToMedia mapping).</summary>
        private static MediaItem ToMediaItem(FavoriteRecord record)
        {
            if (record == null || string.IsNullOrEmpty(record.ContentId))
            {
                return null;
            }

            ContentSnapshot snapshot = record.Snapshot;
            return new MediaItem
            {
                Id = record.ContentId,
                Title = snapshot != null && !string.IsNullOrEmpty(snapshot.Title)
                    ? snapshot.Title
                    : "Untitled",
                Type = record.ContentType ?? "movie",
                IsAnime = snapshot != null && snapshot.IsAnime == true,
                Poster = snapshot != null ? snapshot.Poster : null,
                Backdrop = snapshot != null ? snapshot.Backdrop : null,
                Year = snapshot != null && snapshot.Year.HasValue ? snapshot.Year.Value : 0,
                Runtime = snapshot != null ? snapshot.Runtime : null,
                Rating = snapshot != null && snapshot.Rating.HasValue ? snapshot.Rating.Value : 0,
                Genres = snapshot != null ? snapshot.Genres : null,
                Description = snapshot != null ? snapshot.Description : null
            };
        }

        // ---- grid ---------------------------------------------------------

        /// <summary>Builds the 6-column grid and wires its focus links:
        /// Left/Right along each row, nearest-column Up/Down between rows,
        /// row 0 Up -> BACK, BACK Down -> the first card.</summary>
        private void BindGrid(List<MediaItem> items)
        {
            ClearGrid();

            List<MediaCard> previousRow = null;
            for (int start = 0; start < items.Count; start += Theme.GridColumns)
            {
                int columnCount = Math.Min(Theme.GridColumns, items.Count - start);
                int rowIndex = _rows.Count;

                List<MediaCard> row = new List<MediaCard>();
                MediaCard previous = null;
                for (int i = 0; i < columnCount; i++)
                {
                    MediaItem item = items[start + i];
                    if (item == null)
                    {
                        continue;
                    }

                    MediaCard card = new MediaCard(item)
                    {
                        // Center pivot: Position2D measures to the card's own
                        // center, so the 1.05 focus scale grows in place.
                        Position2D = new Position2D(
                            i * Theme.GridCellWidth + Theme.CardWidth / 2,
                            rowIndex * Theme.GridRowPitch + Theme.CardHeight / 2)
                    };

                    card.FocusGained += OnCardFocusGained;
                    card.Selected += OnCardSelected;

                    if (previous != null)
                    {
                        previous.RightFocusableView = card;
                        card.LeftFocusableView = previous;
                    }

                    _gridContent.Add(card);
                    row.Add(card);
                    previous = card;
                }

                if (row.Count == 0)
                {
                    continue;
                }

                if (previousRow != null)
                {
                    // Between rows: nearest-column links in both directions
                    // (clamped automatically by the nearest pick).
                    foreach (MediaCard above in previousRow)
                    {
                        above.DownFocusableView = FocusLink.Nearest(row, above.Position2D.X);
                    }

                    foreach (MediaCard below in row)
                    {
                        below.UpFocusableView = FocusLink.Nearest(previousRow, below.Position2D.X);
                    }
                }
                else
                {
                    // First row: Up returns to the header's BACK pill.
                    foreach (MediaCard card in row)
                    {
                        card.UpFocusableView = _backButton;
                    }
                }

                _rows.Add(row);
                previousRow = row;
            }

            if (_rows.Count > 0 && _rows[0].Count > 0)
            {
                _backButton.DownFocusableView = _rows[0][0];
            }

            int contentHeight = (_rows.Count - 1) * Theme.GridRowPitch + Theme.CardHeight;
            _gridContent.Size2D = new Size2D(Theme.GridViewportWidth, contentHeight);
            _gridScroll.ScrollPositionMax = new Vector2(
                0f, Math.Max(0f, contentHeight - Theme.MyListViewportHeight));

            FocusManager.Instance.SetCurrentFocusView(_rows[0][0]);
        }

        /// <summary>Removes and disposes every card (focus-safe).</summary>
        private void ClearGrid()
        {
            if (_rows.Count == 0)
            {
                return;
            }

            View focused = FocusManager.Instance.GetCurrentFocusView();
            foreach (List<MediaCard> row in _rows)
            {
                foreach (MediaCard card in row)
                {
                    if (focused == card)
                    {
                        FocusManager.Instance.SetCurrentFocusView(null);
                    }
                }
            }

            foreach (List<MediaCard> row in _rows)
            {
                foreach (MediaCard card in row)
                {
                    _gridContent.Remove(card);
                    card.Dispose();
                }
            }
            _rows.Clear();
            _focusedCard = null;

            _gridScroll.ScrollPosition = new Vector2(0f, 0f);
            _gridScroll.ScrollPositionMax = new Vector2(0f, 0f);
        }

        /// <summary>Vertical keep-in-view scrolling for the grid (the focused
        /// card's row stays inside the viewport).</summary>
        private void OnCardFocusGained(object source, EventArgs e)
        {
            MediaCard card = source as MediaCard;
            if (card == null)
            {
                return;
            }

            _focusedCard = card;

            int rowIndex = -1;
            for (int r = 0; r < _rows.Count; r++)
            {
                if (_rows[r].Contains(card))
                {
                    rowIndex = r;
                    break;
                }
            }

            if (rowIndex < 0)
            {
                return;
            }

            int rowTop = rowIndex * Theme.GridRowPitch;
            float scrollY = _gridScroll.ScrollPosition.Y;
            float targetY = scrollY;
            if (rowTop < scrollY)
            {
                targetY = rowTop;
            }
            else if (rowTop + Theme.CardHeight > scrollY + Theme.MyListViewportHeight)
            {
                targetY = rowTop + Theme.CardHeight - Theme.MyListViewportHeight;
            }

            if (Math.Abs(targetY - scrollY) > 0.5f)
            {
                _gridScroll.ScrollTo(new Vector2(0f, targetY), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }
        }

        // ---- states -------------------------------------------------------

        /// <summary>The session-missing state: honest message + SIGN IN pill.</summary>
        private void ShowUnsignedOrUnavailable(string message)
        {
            ClearGrid();
            _subtitle.Text = "MY LIST";
            _status.Text = message;
            _status.Show();

            bool showSignIn = message == StatusSignedOut;
            if (showSignIn)
            {
                _signInButton.Show();
                _backButton.DownFocusableView = _signInButton;
                _signInButton.UpFocusableView = _backButton;
                FocusManager.Instance.SetCurrentFocusView(_signInButton);
            }
            else
            {
                _signInButton.Hide();
                _backButton.DownFocusableView = null;
                FocusManager.Instance.SetCurrentFocusView(_backButton);
            }
        }

        private void ShowStatus(string message)
        {
            ClearGrid();
            _status.Text = message;
            _status.Show();
            _signInButton.Hide();
            _backButton.DownFocusableView = null;
            FocusManager.Instance.SetCurrentFocusView(_backButton);
        }

        // ---- selection (Enter/OK) -----------------------------------------

        private void OnCardSelected(MediaItem item)
        {
            Log.Info(MaveroApp.LogTag,
                "My List title selected: '" + item.Title + "' (id=" + item.Id + ") — opening detail");
            ItemSelected?.Invoke(item);
        }

        private void OnBackSelected()
        {
            Log.Info(MaveroApp.LogTag, "Back button pressed on My List — returning home");
            CloseRequested?.Invoke();
        }

        private void OnSignInSelected()
        {
            Log.Info(MaveroApp.LogTag, "SIGN IN pressed on My List — opening login");
            LoginRequested?.Invoke();
        }
    }
}
#pragma warning restore CS0618
