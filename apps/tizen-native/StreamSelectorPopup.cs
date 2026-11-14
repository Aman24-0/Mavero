// ============================================================
// Mavero TV — D-pad navigable modal list popup (Tizen.NUI, API 6).
//
// Used by PlayerPage for the Server and Source selectors: a full
// screen scrim + a centered rounded panel carrying a vertical list
// of FocusButton rows.
//
// Focus engine integration:
//   - rows are Focusable and explicitly linked Up/Down, so
//     navigation is deterministic and stays INSIDE the popup (the
//     overlay buttons underneath are hidden while the popup is
//     open, so the built-in spatial algorithm can never jump out);
//   - Enter/OK on a row raises Selected(index) — the popup closes
//     itself is NOT its job; PlayerPage closes it and applies the
//     choice;
//   - the remote Back key is not consumed here: it falls through to
//     the window handler, where PlayerPage.HandleBack closes the
//     popup.
//
// Visual language matches the rest of the app: card-bg.png 9-patch
// panel, FocusButton secondary rows (cyan focus ring + scale), dark
// scrim. The current selection is marked with a middle-dot prefix.
//
// API 6 note: rows are laid out unscrolled; the caller caps options
// at Theme.PopupMaxRows so the panel always fits 1080p.
// ============================================================
using System;
using System.Collections.Generic;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>Modal list popup with D-pad navigation.</summary>
    public class StreamSelectorPopup : View
    {
        private readonly List<FocusButton> _rows = new List<FocusButton>();

        /// <summary>Raised when the user presses Enter/OK on a row (0-based index).</summary>
        public event Action<int> Selected;

        /// <param name="title">Popup title (rendered uppercase in the panel).</param>
        /// <param name="options">Row labels; the current selection should be marked by the caller.</param>
        public StreamSelectorPopup(string title, IReadOnlyList<string> options)
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = new Color(0f, 0f, 0f, Theme.PopupScrimAlpha);
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;
            Focusable = false; // the scrim never takes focus; only rows do

            int rowCount = Math.Min(options.Count, Theme.PopupMaxRows);
            int rowsHeight = rowCount * Theme.PopupRowHeight
                + Math.Max(0, rowCount - 1) * Theme.PopupRowGap;
            int panelHeight = Theme.PopupPadding * 2 + Theme.PopupTitleHeight
                + Theme.PopupTitleGap + rowsHeight;
            int panelY = (Theme.ScreenHeight - panelHeight) / 2;
            int panelX = (Theme.ScreenWidth - Theme.PopupWidth) / 2;

            Add(CreatePanel(panelX, panelY, panelHeight, title));

            int rowTop = panelY + Theme.PopupPadding + Theme.PopupTitleHeight + Theme.PopupTitleGap;
            int rowCenterX = panelX + Theme.PopupPadding + Theme.PopupRowWidth / 2;

            FocusButton previous = null;
            for (int i = 0; i < rowCount; i++)
            {
                int index = i; // capture for the row lambda
                FocusButton row = new FocusButton(options[i], Theme.PopupRowWidth, Theme.PopupRowHeight, false)
                {
                    // Center pivot: Position2D measures to the row's own center.
                    Position2D = new Position2D(
                        rowCenterX, rowTop + i * (Theme.PopupRowHeight + Theme.PopupRowGap) + Theme.PopupRowHeight / 2)
                };
                row.Selected += () => Selected?.Invoke(index);

                if (previous != null)
                {
                    previous.DownFocusableView = row;
                    row.UpFocusableView = previous;
                }

                Add(row);
                _rows.Add(row);
                previous = row;
            }
        }

        private static View CreatePanel(int x, int y, int height, string title)
        {
            PropertyMap surface = new PropertyMap();
            surface.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            surface.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.AssetUrl(Theme.CardBgAsset)));
            surface.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder)));

            View panel = new View
            {
                Position2D = new Position2D(x, y),
                Size2D = new Size2D(Theme.PopupWidth, height),
                Background = surface,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            TextLabel label = new TextLabel
            {
                Text = (title ?? string.Empty).ToUpperInvariant(),
                TextColor = Theme.TextPrimary,
                PointSize = Theme.PopupTitlePointSize,
                Ellipsis = true,
                VerticalLineAlignment = VerticalLineAlignment.Center,
                Position2D = new Position2D(Theme.PopupPadding, Theme.PopupPadding),
                Size2D = new Size2D(Theme.PopupWidth - Theme.PopupPadding * 2, Theme.PopupTitleHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            panel.Add(label);

            return panel;
        }

        /// <summary>Lands focus on the first row once the popup is on the window.</summary>
        public void FocusFirstRow()
        {
            if (_rows.Count > 0)
            {
                FocusManager.Instance.SetCurrentFocusView(_rows[0]);
            }
        }
    }
}
