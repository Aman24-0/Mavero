// ============================================================
// Mavero TV — detail screen UI (Tizen.NUI, API 6).
//
// Opened when the user presses Enter on a home-rail card; App.cs
// swaps this page onto the window and handles the hardware Back
// key to pop back to the HomePage.
//
// Layout (1920x1080, mirroring the web app's detail page):
//   [0..620]   backdrop hero (full-bleed w1280 art, ScaleToFill;
//              poster crop when no backdrop exists) + bottom fade
//              (hero-scrim.png) blending into #0a0a0a;
//   [56]       BACK pill, top-left over the hero;
//   [650]      title (large, ellipsis);
//   [750]      meta line — year · maturity · runtime · rating · genres;
//   [816]      PLAY button — primary CTA, focused by default;
//   [928]      synopsis (3-line clamp, MultiLine).
//
// Progressive binding: the constructor renders whatever the home
// rail already carries (backdrop/poster art, title, year, rating,
// genres, description) so the page paints instantly, then the
// detail fetch enriches the meta line and synopsis on arrival.
// On a failed fetch the rail-level data stays (honest degradation,
// never fake data) and the miss is logged.
//
// D-pad focus engine:
//   - PLAY and BACK are FocusButtons (Focusable = true);
//   - explicit Up/Down focus links (PLAY <-> BACK) make vertical
//     navigation deterministic; edges stay null so navigation
//     clamps;
//   - Enter/OK on PLAY raises PlayRequested (the native video
//     player consumes it in the next iteration), Enter on BACK
//     raises CloseRequested (same path as the hardware Back key);
//   - SetInitialFocus() lands focus on PLAY once App adds the page
//     to the window.
//
// Threading: the detail fetch completes on the thread pool; binding
// is marshaled through UiDispatcher (DALi objects are only touched
// on the UI thread). MarkClosing() fences the queued bind against a
// page the user already backed out of.
//
// API 6 notes (verified against the TizenFX 6.0.0.14995 refs):
//   - Positioning uses the modern pivot pattern (API5+):
//     PositionUsesPivotPoint + PivotPoint.TopLeft; buttons use a
//     center pivot so the focus scale grows in place.
//   - TextLabel has MultiLine but no max-line property, so the
//     synopsis is clamped to Theme.SynopsisMaxChars (~3 lines).
// ============================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>Detail screen for one media title.</summary>
    public class DetailPage : View
    {
        private readonly MediaItem _item;
        private readonly ApiService _api = new ApiService();
        private bool _closed;

        private ImageView _backdrop;
        private string _backdropUrl;
        private TextLabel _title;
        private TextLabel _meta;
        private TextLabel _synopsis;
        private FocusButton _playButton;
        private FocusButton _backButton;

        /// <summary>Raised when the user presses Enter/OK on the Play button.</summary>
        public event Action PlayRequested;

        /// <summary>Raised when the user presses Enter/OK on the Back button.</summary>
        public event Action CloseRequested;

        public DetailPage(MediaItem item)
        {
            _item = item;

            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            _backdrop = CreateBackdrop();
            Add(_backdrop);
            Add(CreateHeroScrim());
            _backButton = CreateBackButton();
            Add(_backButton);
            _title = CreateTitle();
            Add(_title);
            _meta = CreateMeta();
            Add(_meta);
            _playButton = CreatePlayButton();
            Add(_playButton);
            _synopsis = CreateSynopsis();
            Add(_synopsis);

            // Explicit focus links: the only two focusable views on this
            // page, navigated deterministically Up/Down.
            _playButton.UpFocusableView = _backButton;
            _backButton.DownFocusableView = _playButton;

            _playButton.Selected += OnPlaySelected;
            _backButton.Selected += OnBackSelected;

            BindRailData();

            UiDispatcher.Start(); // idempotent; pumps DetailPage binds too
            _ = LoadDetailAsync();
        }

        /// <summary>Lands focus on the Play CTA once the page is on the window.</summary>
        public void SetInitialFocus()
        {
            FocusManager.Instance.SetCurrentFocusView(_playButton);
        }

        /// <summary>Fences in-flight fetch binding before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        // ---- chrome -------------------------------------------------------

        /// <summary>Full-bleed hero art: rail backdrop, poster crop fallback;
        /// refreshed with the detail backdrop when one arrives.</summary>
        private ImageView CreateBackdrop()
        {
            _backdropUrl = !string.IsNullOrEmpty(_item.Backdrop) ? _item.Backdrop : _item.Poster;

            return new ImageView
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.BackdropHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ResourceUrl = _backdropUrl,
                FittingMode = FittingModeType.ScaleToFill,
                DesiredWidth = Theme.BackdropDecodeWidth,
                DesiredHeight = Theme.BackdropDecodeHeight
            };
        }

        /// <summary>Bottom fade over the hero so it blends into the page background.</summary>
        private static View CreateHeroScrim()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.HeroScrimAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.HeroPatchBorderX, 0f, Theme.HeroPatchBorderX, 0f)));

            return new View
            {
                Position2D = new Position2D(0, Theme.BackdropHeight - Theme.HeroScrimHeight),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.HeroScrimHeight),
                Background = map,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private FocusButton CreateBackButton()
        {
            return new FocusButton("BACK", Theme.BackButtonWidth, Theme.BackButtonHeight, false)
            {
                // Center pivot: Position2D measures to the button's own center.
                Position2D = new Position2D(
                    Theme.BackButtonX + Theme.BackButtonWidth / 2,
                    Theme.BackButtonY + Theme.BackButtonHeight / 2)
            };
        }

        private TextLabel CreateTitle()
        {
            return new TextLabel
            {
                Text = _item.Title ?? string.Empty,
                TextColor = Theme.TextPrimary,
                PointSize = Theme.DetailTitlePointSize,
                Ellipsis = true,
                Position2D = new Position2D(Theme.PageMargin, Theme.DetailTitleY),
                Size2D = new Size2D(Theme.ScreenWidth - Theme.PageMargin * 2, Theme.DetailTitleHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateMeta()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.DetailMetaPointSize,
                Ellipsis = true,
                Position2D = new Position2D(Theme.PageMargin, Theme.DetailMetaY),
                Size2D = new Size2D(Theme.ScreenWidth - Theme.PageMargin * 2, Theme.DetailMetaHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private FocusButton CreatePlayButton()
        {
            return new FocusButton("PLAY", Theme.PlayButtonWidth, Theme.PlayButtonHeight, true)
            {
                Position2D = new Position2D(
                    Theme.PageMargin + Theme.PlayButtonWidth / 2,
                    Theme.PlayButtonY + Theme.PlayButtonHeight / 2)
            };
        }

        private TextLabel CreateSynopsis()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.DetailSynopsisPointSize,
                MultiLine = true,
                Position2D = new Position2D(Theme.PageMargin, Theme.SynopsisY),
                Size2D = new Size2D(Theme.SynopsisWidth, Theme.SynopsisHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        // ---- data → UI binding -------------------------------------------

        /// <summary>Renders what the home rail already knows (instant paint).</summary>
        private void BindRailData()
        {
            _meta.Text = BuildMetaLine(_item.Year, null, null, _item.Rating, _item.Genres);
            _synopsis.Text = ClampSynopsis(_item.Description);
        }

        private async Task LoadDetailAsync()
        {
            try
            {
                Log.Info(MaveroApp.LogTag,
                    $"Detail fetch: {_item.Type}/{_item.Id} ('{_item.Title}')");
                MediaDetail detail = await _api.FetchDetailAsync(_item);
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    BindDetail(detail);
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag,
                    $"Detail fetch failed for {_item.Id}: {ex.Message} — keeping rail-level data");
            }
        }

        /// <summary>Enriches the page with the fetched record (maturity, runtime,
        /// genres, full synopsis, fresh hero art when the rail had none).</summary>
        private void BindDetail(MediaDetail detail)
        {
            if (detail == null)
            {
                Log.Info(MaveroApp.LogTag,
                    $"Detail unavailable for {_item.Id} — keeping rail-level data");
                return;
            }

            if (!string.IsNullOrEmpty(detail.Backdrop) && detail.Backdrop != _backdropUrl)
            {
                _backdropUrl = detail.Backdrop;
                _backdrop.ResourceUrl = detail.Backdrop;
            }

            _meta.Text = BuildMetaLine(
                detail.Year > 0 ? detail.Year : _item.Year,
                detail.Maturity,
                detail.Runtime,
                detail.Rating > 0 ? detail.Rating : _item.Rating,
                detail.Genres != null && detail.Genres.Count > 0 ? detail.Genres : _item.Genres);

            if (!string.IsNullOrEmpty(detail.Description))
            {
                _synopsis.Text = ClampSynopsis(detail.Description);
            }

            Log.Info(MaveroApp.LogTag,
                $"Detail bound: '{detail.Title}' ({detail.Year}) maturity={detail.Maturity} " +
                $"runtime={detail.Runtime} rating={detail.Rating} cast={detail.Cast?.Count ?? 0}");
        }

        /// <summary>Year · maturity · runtime · rating · genres — missing pieces drop out.</summary>
        private static string BuildMetaLine(int year, string maturity, string runtime, double rating, List<string> genres)
        {
            List<string> parts = new List<string>();
            if (year > 0)
            {
                parts.Add(year.ToString());
            }
            if (!string.IsNullOrEmpty(maturity))
            {
                parts.Add(maturity);
            }
            if (!string.IsNullOrEmpty(runtime))
            {
                parts.Add(runtime);
            }
            if (rating > 0)
            {
                parts.Add(rating.ToString("0.0") + "/10");
            }
            if (genres != null && genres.Count > 0)
            {
                parts.Add(string.Join(", ", genres.GetRange(0, Math.Min(3, genres.Count))));
            }
            return string.Join("  ·  ", parts);
        }

        /// <summary>Clamps the synopsis to a few lines (API6 TextLabel has no
        /// max-line property, so length is the only honest lever).</summary>
        private static string ClampSynopsis(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            string trimmed = text.Trim();
            if (trimmed.Length <= Theme.SynopsisMaxChars)
            {
                return trimmed;
            }

            return trimmed.Substring(0, Theme.SynopsisMaxChars).TrimEnd() + "…";
        }

        // ---- selection (Enter/OK) -----------------------------------------

        private void OnPlaySelected()
        {
            Log.Info(MaveroApp.LogTag,
                $"Play requested: '{_item.Title}' (id={_item.Id}) — video player lands next iteration");
            PlayRequested?.Invoke();
        }

        private void OnBackSelected()
        {
            Log.Info(MaveroApp.LogTag, $"Back button pressed on detail '{_item.Title}'");
            CloseRequested?.Invoke();
        }
    }
}
