// ============================================================
// Mavero TV — the virtual on-screen keyboard (Tizen.NUI, API 6).
//
// TV remotes have no physical keyboard, so search input is a fully
// D-pad navigable QWERTY grid:
//
//     Q W E R T Y U I O P
//      A S D F G H J K L
//       Z X C V B N M
//     [ DEL ]  [ SPACE ]  [ SEARCH ]
//
// The three letter rows are staggered like a real keyboard; the
// special row underneath carries DEL (backspace), SPACE and the
// SEARCH call-to-action (primary CTA tier — the cyan fill IS the
// focus feedback, same language as the detail page's PLAY).
//
// Every key is a FocusButton (the same 9-patch pill + cyan-ring
// focus language as every other button in the app), sized from the
// Theme constants in the "Search page" block.
//
// Focus engine integration:
//   - ALL links are explicit and computed once at build time, so
//     navigation is deterministic and never escapes into the page
//     chrome: Left/Right chains along each row (edges clamp) and
//     nearest-center Up/Down links between rows — staggered rows
//     map each key to the key whose center is closest above/below
//     it, which is exactly how physical staggered keyboards feel;
//   - the row ABOVE the keyboard (the search field) and the rows
//     BELOW it (search result cards) are connected by SearchPage
//     via ConnectHeader() and the exposed key rows, using the
//     FocusLink.Nearest helper;
//   - KeyEvent handling is inside FocusButton (Enter/OK only);
//     arrow keys fall through to the FocusManager's built-in
//     navigation over the wired links.
//
// Enter/OK behaviour per key:
//   letter  -> appends the letter to the query (capped at the
//              server's 120-char INVALID_QUERY limit);
//   SPACE   -> appends a space (no leading spaces — the server
//              trims them away anyway);
//   DEL     -> removes the last character (no-op when empty);
//   SEARCH  -> SearchRequested fires with the trimmed query.
// ============================================================
using System;
using System.Collections.Generic;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>
    /// Nearest-center focus helper shared by the search screen. Maps
    /// staggered keyboard rows onto each other and keyboard rows onto
    /// result-grid columns.
    /// </summary>
    internal static class FocusLink
    {
        /// <summary>
        /// Picks the view whose center X is closest to centerX. The
        /// keyboard keys and the result-grid MediaCards are all laid out
        /// with a CENTER pivot, so Position2D.X IS the view's center —
        /// callers pass coordinates in the SAME space the list's views
        /// live in (caller handles cross-container offsets).
        /// </summary>
        public static View Nearest(IReadOnlyList<View> views, float centerX)
        {
            if (views == null || views.Count == 0)
            {
                return null;
            }

            View best = null;
            float bestDistance = float.MaxValue;
            foreach (View view in views)
            {
                float distance = Math.Abs(view.Position2D.X - centerX);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = view;
                }
            }

            return best;
        }
    }

    /// <summary>D-pad navigable virtual QWERTY keyboard for the search screen.</summary>
    public class VirtualKeyboard : View
    {
        /// <summary>The query text accumulated from key presses.</summary>
        private string _query = string.Empty;

        private readonly List<FocusButton> _row0 = new List<FocusButton>();
        private readonly List<FocusButton> _row1 = new List<FocusButton>();
        private readonly List<FocusButton> _row2 = new List<FocusButton>();
        private readonly List<FocusButton> _specials = new List<FocusButton>();

        /// <summary>Raised after the query changed (letter/space/backspace).</summary>
        public event Action<string> QueryChanged;

        /// <summary>Raised on Enter/OK on the SEARCH key — carries the trimmed query.</summary>
        public event Action<string> SearchRequested;

        public VirtualKeyboard()
        {
            // Full-width block holding 4 rows (3 letter rows + specials);
            // SearchPage positions it at Theme.KeyboardTopY.
            Size2D = new Size2D(Theme.ScreenWidth, 4 * Theme.KeyRowPitch - Theme.KeyGap);
            BackgroundColor = Color.Transparent;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            BuildLetterRow(_row0, "QWERTYUIOP", Theme.KeyRow0X, 0);
            BuildLetterRow(_row1, "ASDFGHJKL", Theme.KeyRow1X, 1);
            BuildLetterRow(_row2, "ZXCVBNM", Theme.KeyRow2X, 2);
            BuildSpecialRow();
            WireRowLinks();
        }

        // ---- public surface ------------------------------------------------

        /// <summary>The query text accumulated so far (never trimmed).</summary>
        public string Query
        {
            get { return _query; }
        }

        /// <summary>The first letter key (Q) — the keyboard's initial focus spot.</summary>
        public FocusButton FirstKey
        {
            get { return _row0.Count > 0 ? _row0[0] : null; }
        }

        /// <summary>The special keys in layout order (DEL, SPACE, SEARCH).</summary>
        /// SearchPage links the results grid's first row against this row
        /// (Up from results -> keyboard, Down from specials -> results).
        public IReadOnlyList<FocusButton> SpecialKeys
        {
            get { return _specials; }
        }

        /// <summary>
        /// Wires the search field (the focusable view ABOVE the keyboard)
        /// into the focus flow: the field's Down lands on the top-row key
        /// nearest the field's center, and every top-row key's Up returns
        /// to the field ("Up from the keyboard goes back to the header").
        /// </summary>
        public void ConnectHeader(View headerField)
        {
            if (headerField == null || _row0.Count == 0)
            {
                return;
            }

            // The field is a FocusButton with a center pivot, so its
            // Position2D.X IS the center — map the field onto the top
            // letter row by that center.
            headerField.DownFocusableView = FocusLink.Nearest(_row0, headerField.Position2D.X);

            foreach (FocusButton key in _row0)
            {
                key.UpFocusableView = headerField;
            }
        }

        // ---- construction --------------------------------------------------

        /// <summary>Builds one staggered letter row with Left/Right focus chains.</summary>
        private void BuildLetterRow(List<FocusButton> row, string letters, int rowX, int rowIndex)
        {
            FocusButton previous = null;
            for (int i = 0; i < letters.Length; i++)
            {
                FocusButton key = new FocusButton(letters[i].ToString(), Theme.KeyWidth,
                    Theme.KeyHeight, false, Theme.KeyboardLetterPointSize)
                {
                    // Center pivot: Position2D measures to the key's own center,
                    // so the focus scale grows symmetrically in place.
                    Position2D = new Position2D(
                        rowX + i * (Theme.KeyWidth + Theme.KeyGap) + Theme.KeyWidth / 2,
                        rowIndex * Theme.KeyRowPitch + Theme.KeyHeight / 2)
                };

                char letter = letters[i]; // per-iteration copy for the closure
                key.Selected += () => AppendLetter(letter);

                if (previous != null)
                {
                    previous.RightFocusableView = key;
                    key.LeftFocusableView = previous;
                }

                Add(key);
                row.Add(key);
                previous = key;
            }
        }

        /// <summary>Builds the DEL / SPACE / SEARCH special row.</summary>
        private void BuildSpecialRow()
        {
            int y = 3 * Theme.KeyRowPitch + Theme.KeyHeight / 2;
            int x = Theme.KeySpecialRowX;

            FocusButton del = new FocusButton("DEL", Theme.DelKeyWidth, Theme.KeyHeight,
                false, Theme.KeyboardSpecialPointSize)
            {
                Position2D = new Position2D(x + Theme.DelKeyWidth / 2, y)
            };
            del.Selected += OnDeleteSelected;

            int spaceX = x + Theme.DelKeyWidth + Theme.KeySpecialGap;
            FocusButton space = new FocusButton("SPACE", Theme.SpaceKeyWidth, Theme.KeyHeight,
                false, Theme.KeyboardSpecialPointSize)
            {
                Position2D = new Position2D(spaceX + Theme.SpaceKeyWidth / 2, y)
            };
            space.Selected += OnSpaceSelected;

            int searchX = spaceX + Theme.SpaceKeyWidth + Theme.KeySpecialGap;
            FocusButton search = new FocusButton("SEARCH", Theme.SearchKeyWidth, Theme.KeyHeight,
                true, Theme.KeyboardSpecialPointSize)
            {
                // Primary CTA tier: the cyan fill on focus marks SEARCH as
                // the row's call-to-action (same tier as the detail PLAY).
                Position2D = new Position2D(searchX + Theme.SearchKeyWidth / 2, y)
            };
            search.Selected += OnSearchSelected;

            Add(del);
            Add(space);
            Add(search);
            _specials.Add(del);
            _specials.Add(space);
            _specials.Add(search);
        }

        /// <summary>Wires nearest-center Up/Down links between vertically
        /// adjacent rows (both directions).</summary>
        private void WireRowLinks()
        {
            WireVerticalNeighbors(_row0, _row1);
            WireVerticalNeighbors(_row1, _row2);
            WireVerticalNeighbors(_row2, _specials);
        }

        private static void WireVerticalNeighbors(IReadOnlyList<FocusButton> top,
            IReadOnlyList<FocusButton> bottom)
        {
            foreach (FocusButton topKey in top)
            {
                topKey.DownFocusableView = FocusLink.Nearest(bottom, topKey.Position2D.X);
            }

            foreach (FocusButton bottomKey in bottom)
            {
                bottomKey.UpFocusableView = FocusLink.Nearest(top, bottomKey.Position2D.X);
            }
        }

        // ---- key actions ---------------------------------------------------

        private void AppendLetter(char letter)
        {
            if (_query.Length >= Theme.SearchQueryMaxChars)
            {
                // The server rejects longer queries (INVALID_QUERY, HTTP
                // 400) — cap locally so the request is never sent.
                return;
            }

            _query = _query + letter;
            QueryChanged?.Invoke(_query);
        }

        private void OnSpaceSelected()
        {
            if (_query.Length == 0 || _query.Length >= Theme.SearchQueryMaxChars)
            {
                return; // no leading spaces — the server trims them away anyway
            }

            _query = _query + " ";
            QueryChanged?.Invoke(_query);
        }

        private void OnDeleteSelected()
        {
            if (_query.Length == 0)
            {
                return;
            }

            _query = _query.Substring(0, _query.Length - 1);
            QueryChanged?.Invoke(_query);
        }

        private void OnSearchSelected()
        {
            SearchRequested?.Invoke((_query ?? string.Empty).Trim());
        }
    }
}
