// ============================================================
// Mavero TV — search screen UI (Tizen.NUI, API 6).
//
// Opened from the HomePage header's SEARCH pill (or a remote's
// dedicated search key); App.cs swaps this page onto the window and
// handles the hardware Back key to pop back to the HomePage.
//
// Layout on the fixed 1920x1080 screen:
//   [0..160]    header — MAVERO brand + accent bar (home chrome),
//               BACK pill top-right;
//   [160..244]  search field — a wide FocusButton showing the live
//               query text ("batman _") or a placeholder hint;
//               Enter/OK on it runs the search, Up goes to BACK;
//   [268..560]  virtual keyboard (VirtualKeyboard: staggered QWERTY
//               rows + DEL / SPACE / SEARCH special row);
//   [588..622]  status line — hint, "Searching...", result count,
//               "No results found" / unavailable states;
//   [636..1080] results grid — a vertically scrollable host with 6
//               MediaCards per row (same poster cards as the home
//               rails), keep-in-view scrolling on focus.
//
// D-pad focus flow (every link explicit, deterministic, never
// escapes into the chrome):
//   BACK --Down--> search field --Down--> keyboard top row
//   (field --Up--> BACK; keyboard top row --Up--> field);
//   keyboard rows interlink Left/Right/Up/Down (nearest-center on
//   the staggered rows); SEARCH key --Down--> first results row;
//   results row 0 --Up--> nearest special key; result rows interlink
//   vertically by nearest column; Enter on a result card opens the
//   DetailPage. Pressing Up from the keyboard therefore returns to
//   the header and Down from the keyboard enters the results, and
//   focus STAYS on the keyboard after a search — the user refines
//   the query or presses Down to browse (no focus stealing).
//
// States: the page opens on the type-a-query hint; an empty/blank
// query never reaches the API; results bind with a count line; an
// empty result list shows "No results found"; a failed or
// rate-limited request shows the honest unavailable state. No fake
// data anywhere.
//
// Threading: the search fetch completes on the thread pool; grid
// binding is marshaled through UiDispatcher (DALi objects are only
// touched on the UI thread). A generation counter fences stale
// responses against a newer search; MarkClosing() fences binds
// against a page the user already backed out of.
//
// API 6 notes: same pivot pattern, ScrollView usage and CS0618
// suppression as HomePage.cs / DetailPage.cs.
// ============================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

// CS0618: Tizen.NUI.ScrollView is the only scrollable container in the
// API6 profile (same suppression as HomePage.cs / DetailPage.cs).
#pragma warning disable CS0618

namespace MaveroTv
{
    /// <summary>Search screen: query display, virtual keyboard, results grid.</summary>
    public class SearchPage : View
    {
        /// <summary>Honest state lines for the status area.</summary>
        private const string StatusHint = "Type to search the Mavero catalog - press SEARCH when ready";
        private const string StatusUnavailable = "Search unavailable - check the network connection";

        private readonly ApiService _api = new ApiService();
        private readonly List<List<MediaCard>> _resultRows = new List<List<MediaCard>>();

        private FocusButton _backButton;
        private FocusButton _searchField;
        private VirtualKeyboard _keyboard;
        private TextLabel _status;
        private ScrollView _resultsScroll;
        private View _resultsContent;
        private int _contentHeight;
        private bool _closed;

        /// <summary>The result card the user last focused — restored after
        /// Detail round-trips.</summary>
        private MediaCard _focusedCard;

        /// <summary>Guards against a stale search response binding over a newer one.</summary>
        private int _searchGeneration;

        /// <summary>Raised when the user presses Enter/OK on a result card.</summary>
        public event Action<MediaItem> ItemSelected;

        /// <summary>Raised when the user leaves the search screen (BACK pill
        /// or the hardware Back key).</summary>
        public event Action CloseRequested;

        public SearchPage()
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            Add(CreateHeader());

            _searchField = CreateSearchField();
            Add(_searchField);

            _keyboard = new VirtualKeyboard
            {
                Position2D = new Position2D(0, Theme.KeyboardTopY)
            };
            _keyboard.QueryChanged += OnQueryChanged;
            _keyboard.SearchRequested += OnSearchRequested;
            Add(_keyboard);

            _status = CreateStatus();
            Add(_status);

            CreateResultsHost();

            // Header focus cluster: BACK sits above the field.
            _searchField.UpFocusableView = _backButton;
            _backButton.DownFocusableView = _searchField;

            // Keyboard top row <-> field ("Up from the keyboard returns
            // to the header; Down from the field enters the keyboard").
            _keyboard.ConnectHeader(_searchField);

            _backButton.Selected += OnBackSelected;
            _searchField.Selected += OnFieldSelected;

            UiDispatcher.Start(); // idempotent; pumps search binds too
        }

        /// <summary>Lands focus on the keyboard's first letter key (Q) so the
        /// user can start typing immediately.</summary>
        public void SetInitialFocus()
        {
            FocusButton first = _keyboard != null ? _keyboard.FirstKey : null;
            if (first != null)
            {
                FocusManager.Instance.SetCurrentFocusView(first);
            }
        }

        /// <summary>Fences in-flight search binding before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        /// <summary>Re-arms focus when the page returns from the Detail screen:
        /// the last focused result card, else the keyboard.</summary>
        public void RestoreFocus()
        {
            View target = _focusedCard;
            if (target == null && _keyboard != null)
            {
                target = _keyboard.FirstKey;
            }

            if (target != null)
            {
                FocusManager.Instance.SetCurrentFocusView(target);
            }
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

        /// <summary>The query display: a wide pill showing the live query text
        /// (with a typing cursor) or the placeholder. Enter runs the search.</summary>
        private FocusButton CreateSearchField()
        {
            return new FocusButton(Theme.SearchFieldPlaceholder, Theme.SearchFieldWidth,
                Theme.SearchFieldHeight, false, Theme.CardTitlePointSize + 2)
            {
                // Center pivot: Position2D measures to the field's own center.
                Position2D = new Position2D(
                    Theme.PageMargin + Theme.SearchFieldWidth / 2,
                    Theme.SearchFieldY + Theme.SearchFieldHeight / 2)
            };
        }

        private static TextLabel CreateStatus()
        {
            return new TextLabel
            {
                Text = StatusHint,
                TextColor = Theme.TextSecondary,
                PointSize = 16,
                Position2D = new Position2D(Theme.PageMargin, Theme.SearchStatusY),
                Size2D = new Size2D(Theme.RailViewportWidth, Theme.SearchStatusHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Vertical viewport hosting the result-grid rows.</summary>
        private void CreateResultsHost()
        {
            _resultsContent = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.GridViewportWidth, 0), // height set once results bind
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _resultsScroll = new ScrollView
            {
                Position2D = new Position2D(Theme.GridX, Theme.ResultsViewportY),
                Size2D = new Size2D(Theme.GridViewportWidth, Theme.ResultsViewportHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
            };

            _resultsScroll.Add(_resultsContent);
            Add(_resultsScroll);
        }

        // ---- search flow ---------------------------------------------------

        private void OnQueryChanged(string query)
        {
            Log.Info(MaveroApp.LogTag, $"Search query now: '{query}'");

            // Live typing display: query + cursor underscore; the placeholder
            // returns once the query is empty again.
            _searchField.SetLabel(string.IsNullOrEmpty(query)
                ? Theme.SearchFieldPlaceholder
                : query + " _");
        }

        private void OnFieldSelected()
        {
            Log.Info(MaveroApp.LogTag, "Search field activated — running the search");
            RunSearch(_keyboard.Query);
        }

        private void OnSearchRequested(string query)
        {
            Log.Info(MaveroApp.LogTag, "SEARCH key pressed — running the search");
            RunSearch(query);
        }

        /// <summary>Runs one catalog search (trimmed, capped at the server's
        /// 120-char limit). Empty queries never reach the API — the hint
        /// stays up instead.</summary>
        private void RunSearch(string query)
        {
            string trimmed = (query ?? string.Empty).Trim();
            if (trimmed.Length == 0)
            {
                SetStatus(StatusHint);
                return;
            }

            if (trimmed.Length > Theme.SearchQueryMaxChars)
            {
                trimmed = trimmed.Substring(0, Theme.SearchQueryMaxChars);
            }

            int generation = ++_searchGeneration;
            Log.Info(MaveroApp.LogTag, $"Search '{trimmed}' (generation {generation})");

            ClearResults();
            SetStatus("Searching for '" + trimmed + "'...");
            _ = SearchAsync(trimmed, generation);
        }

        private async Task SearchAsync(string query, int generation)
        {
            try
            {
                List<MediaItem> items = await _api.SearchAsync(query);
                Log.Info(ApiService.LogTag,
                    $"Search '{query}' returned {items.Count} item(s); binding on UI thread");
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _searchGeneration)
                    {
                        return; // page gone or a newer search superseded this one
                    }
                    try
                    {
                        BindResults(query, items);
                    }
                    catch (Exception ex)
                    {
                        // Visible failure with a working RETRY — never a silent exit.
                        Log.Error(ApiService.LogTag, "Search bind failed: " + ex.Message);
                        Diagnostics.Report(ex, "search results bind", () => RunSearch(query));
                    }
                });
            }
            catch (Exception ex)
            {
                Log.Warn(ApiService.LogTag, $"Search '{query}' failed: {ex.Message}");
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _searchGeneration)
                    {
                        return;
                    }
                    ClearResults();
                    SetStatus(StatusUnavailable);
                });
            }
        }

        // ---- results grid ---------------------------------------------------

        /// <summary>Builds the 6-column result grid and wires its focus links:
        /// Left/Right along each row, nearest-column Up/Down between rows,
        /// row 0 Up -> the keyboard's special row, specials Down -> row 0.</summary>
        private void BindResults(string query, List<MediaItem> items)
        {
            ClearResults();

            if (items == null || items.Count == 0)
            {
                SetStatus("No results found for '" + query + "'");
                return;
            }

            SetStatus(items.Count + (items.Count == 1 ? " result for '" : " results for '")
                + query + "'");

            List<MediaCard> previousRow = null;
            for (int start = 0; start < items.Count; start += Theme.GridColumns)
            {
                int columnCount = Math.Min(Theme.GridColumns, items.Count - start);
                int rowIndex = _resultRows.Count;

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

                    card.FocusGained += OnResultFocusGained;
                    card.Selected += OnResultSelected;

                    if (previous != null)
                    {
                        previous.RightFocusableView = card;
                        card.LeftFocusableView = previous;
                    }

                    _resultsContent.Add(card);
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
                    // First results row: Up returns to the keyboard's special
                    // row. The keyboard spans the full screen width, so the
                    // card centers shift by the grid's x offset into that space.
                    foreach (MediaCard card in row)
                    {
                        card.UpFocusableView = FocusLink.Nearest(_keyboard.SpecialKeys,
                            Theme.GridX + card.Position2D.X);
                    }
                }

                _resultRows.Add(row);
                previousRow = row;
            }

            if (_resultRows.Count > 0)
            {
                // Keyboard specials -> first results row (rewired on every
                // bind so the links never dangle on disposed cards).
                List<MediaCard> firstRow = _resultRows[0];
                foreach (FocusButton special in _keyboard.SpecialKeys)
                {
                    special.DownFocusableView = FocusLink.Nearest(firstRow,
                        special.Position2D.X - Theme.GridX);
                }
            }

            _contentHeight = (_resultRows.Count - 1) * Theme.GridRowPitch + Theme.CardHeight;
            _resultsContent.Size2D = new Size2D(Theme.GridViewportWidth, _contentHeight);
            _resultsScroll.ScrollPositionMax = new Vector2(
                0f, Math.Max(0f, _contentHeight - Theme.ResultsViewportHeight));

            Log.Info(MaveroApp.LogTag,
                $"Search results bound: {items.Count} item(s) in {_resultRows.Count} row(s) " +
                $"for '{query}' — focus stays on the keyboard");

            // Focus policy: after a search the keyboard KEEPS focus — the
            // user refines the query or presses Down to enter the grid.
        }

        /// <summary>Removes and disposes every result card (focus-safe) and
        /// detaches the keyboard specials' links into the dead grid.</summary>
        private void ClearResults()
        {
            if (_resultRows.Count == 0)
            {
                return;
            }

            foreach (FocusButton special in _keyboard.SpecialKeys)
            {
                special.DownFocusableView = null;
            }

            View focused = FocusManager.Instance.GetCurrentFocusView();
            foreach (List<MediaCard> row in _resultRows)
            {
                foreach (MediaCard card in row)
                {
                    if (focused == card)
                    {
                        FocusManager.Instance.SetCurrentFocusView(null);
                    }
                }
            }

            foreach (List<MediaCard> row in _resultRows)
            {
                foreach (MediaCard card in row)
                {
                    _resultsContent.Remove(card);
                    card.Dispose();
                }
            }
            _resultRows.Clear();
            _focusedCard = null;
            _contentHeight = 0;

            _resultsScroll.ScrollPosition = new Vector2(0f, 0f);
            _resultsScroll.ScrollPositionMax = new Vector2(0f, 0f);
        }

        /// <summary>Vertical keep-in-view scrolling for the result grid (the
        /// focused card's row stays inside the viewport).</summary>
        private void OnResultFocusGained(object source, EventArgs e)
        {
            MediaCard card = source as MediaCard;
            if (card == null)
            {
                return;
            }

            _focusedCard = card;

            int rowIndex = -1;
            for (int r = 0; r < _resultRows.Count; r++)
            {
                if (_resultRows[r].Contains(card))
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
            float scrollY = _resultsScroll.ScrollPosition.Y;
            float targetY = scrollY;
            if (rowTop < scrollY)
            {
                targetY = rowTop;
            }
            else if (rowTop + Theme.CardHeight > scrollY + Theme.ResultsViewportHeight)
            {
                targetY = rowTop + Theme.CardHeight - Theme.ResultsViewportHeight;
            }

            if (Math.Abs(targetY - scrollY) > 0.5f)
            {
                _resultsScroll.ScrollTo(new Vector2(0f, targetY), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }
        }

        // ---- selection (Enter/OK) -----------------------------------------

        private void OnResultSelected(MediaItem item)
        {
            Log.Info(MaveroApp.LogTag,
                $"Search result selected: '{item.Title}' (id={item.Id}, year={item.Year}) " +
                "— opening detail");
            ItemSelected?.Invoke(item);
        }

        private void OnBackSelected()
        {
            Log.Info(MaveroApp.LogTag, "Back button pressed on search — returning home");
            CloseRequested?.Invoke();
        }

        // ---- helpers --------------------------------------------------------

        private void SetStatus(string message)
        {
            _status.Text = message ?? string.Empty;
        }
    }
}
#pragma warning restore CS0618
