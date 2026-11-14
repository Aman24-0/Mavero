// ============================================================
// Mavero TV — detail screen UI (Tizen.NUI, API 6).
//
// Opened when the user presses Enter on a home-rail card; App.cs
// swaps this page onto the window and handles the hardware Back
// key to pop back to the HomePage.
//
// TWO layout variants share this class:
//
// MOVIE (unchanged):
//   [0..620]   backdrop hero (full-bleed w1280 art, ScaleToFill;
//              poster crop when no backdrop exists) + bottom fade
//              (hero-scrim.png) blending into #0a0a0a;
//   [56]       BACK pill, top-left over the hero;
//   [650]      title (large, ellipsis);
//   [750]      meta line — year · maturity · runtime · rating · genres;
//   [816]      PLAY button — primary CTA, focused by default;
//   [928]      synopsis (3-line clamp, MultiLine).
//
// SERIES / ANIME (compressed hero; the space movies give to the
// tall backdrop + bottom synopsis hosts the season selector and
// the episode rail instead; synopsis moves to a right column):
//   [0..420]   backdrop hero + bottom fade;
//   [56]       BACK pill;
//   [436]      title;
//   [520]      meta line;
//   [576..644] PLAY button (plays Season 1 Episode 1 by default);
//   [668..724] season selector — horizontal FocusButtons built from
//              the detail record's seasonsData[] ("Season 1", ...,
//              active season marked with a middle-dot prefix);
//   [748]      EPISODES label;
//   [788..988] episode rail — horizontal EpisodeCards (16:9 still,
//              E-number badge, title), one season's episodes at a
//              time, refetched when the season changes;
//   right of the left column [1128..1856 x 440..740]: synopsis.
//
// Progressive binding: the constructor renders whatever the home
// rail already carries (backdrop/poster art, title, year, rating,
// genres, description) so the page paints instantly, then the
// detail fetch enriches the meta line and synopsis and, for series,
// builds the season selector. The first season's episodes load
// immediately; changing season refetches and rebuilds the rail.
// On a failed fetch the rail-level data stays (honest degradation,
// never fake data) and the miss is logged.
//
// D-pad focus engine (movie mode: PLAY <-> BACK, edges clamp —
// unchanged; series mode adds two rows):
//   PLAY --Down--> season buttons (Left/Right along the row)
//        --Down--> episode cards (Left/Right along the rail, Up
//                  back to the season row); BACK stays above PLAY.
//   Every link is explicit so navigation is deterministic and
//   never escapes into the chrome.
//
// Auto-hide safety: the auto-hide overlay lives on the PLAYER page;
// this page is hidden while the player is up and focus is restored
// to PLAY when the user returns, so the hide timer can never steal
// focus during season/episode browsing.
//
// My List: when the user is signed in (AuthSession), an ADD TO LIST
// pill sits right of PLAY. It checks the cloud list on open ("IN LIST"
// marker) and toggles on Enter: PUT /api/account/sync upserts the
// favorite (server-validated record via ApiService.BuildFavoriteRecord),
// DELETE /api/account/favorites removes it. Guests get no pill — the
// honest state for a signed-out TV.
//
// Threading: the detail + season fetches complete on the thread
// pool; binding is marshaled through UiDispatcher (DALi objects are
// only touched on the UI thread). MarkClosing() fences the queued
// binds against a page the user already backed out of; an episode
// fetch generation counter fences stale SEASON responses against a
// season the user already switched away from.
//
// API 6 notes (verified against the TizenFX 6.0.0.14995 refs):
//   - Positioning uses the modern pivot pattern (API5+):
//     PositionUsesPivotPoint + PivotPoint.TopLeft; buttons/cards use
//     a center pivot so the focus scale grows in place;
//   - TextLabel has MultiLine but no max-line property, so the
//     synopsis is clamped by length;
//   - FocusManager exposes GetCurrentFocusView() (no property).
// ============================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

// CS0618: every Tizen.NUI.ScrollView member used here (ctor, ScrollPositionMin/Max,
// ScrollPosition, ScrollTo) is marked "use Tizen.NUI.Components", but API6
// Components ships no scrollable replacement — this is the only scrollable
// container in the target API profile (same suppression as HomePage.cs).
#pragma warning disable CS0618

namespace MaveroTv
{
    /// <summary>Detail screen for one media title (movie or series/anime).</summary>
    public class DetailPage : View
    {
        private readonly MediaItem _item;
        private readonly ApiService _api = new ApiService();
        private readonly bool _seriesMode;
        private bool _closed;

        /// <summary>Guards against a stale season fetch binding over a newer one.</summary>
        private int _episodeFetchGeneration;

        /// <summary>Generation counter fencing My List membership checks and
        /// toggle results against newer user actions (or a closed page).</summary>
        private int _listCheckGeneration;

        private ImageView _backdrop;
        private string _backdropUrl;
        private TextLabel _title;
        private TextLabel _meta;
        private TextLabel _synopsis;
        private FocusButton _playButton;
        private FocusButton _backButton;

        // My List pill (signed-in users only; built in the constructor).
        private FocusButton _addListButton;
        private bool _inList;
        private bool _listBusy;

        /// <summary>Canonical content type of this title ("movie"|"series"|"anime"
        /// — an anime-flagged series canonicalizes to "anime"), shared by the
        /// favorite key check and the DELETE remove call.</summary>
        private string _canonicalType;

        // Series-only chrome (built in the constructor, bound on detail arrival).
        private ScrollView _seasonScroll;
        private ScrollView _episodeScroll;
        private TextLabel _episodesLabel;
        private TextLabel _episodesStatus;
        private readonly List<FocusButton> _seasonButtons = new List<FocusButton>();
        private readonly List<EpisodeCard> _episodeCards = new List<EpisodeCard>();
        private readonly List<string> _seasonBaseLabels = new List<string>();
        private List<Season> _seasons;
        private Season _selectedSeason;
        private int _selectedSeasonIndex = -1;

        /// <summary>The episode the user last picked with Enter (PLAY replays it).</summary>
        private PlaybackTarget _pendingEpisode;

        /// <summary>Raised when the user presses Enter/OK on the Play button or an
        /// episode card. Movies pass null; series pass Season+Episode.</summary>
        public event Action<PlaybackTarget> PlayRequested;

        /// <summary>Raised when the user presses Enter/OK on the Back button.</summary>
        public event Action CloseRequested;

        public DetailPage(MediaItem item)
        {
            _item = item;
            _seriesMode = IsSeriesContent(item);

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
            CreateMyListButton();

            if (_seriesMode)
            {
                _synopsis = CreateSideSynopsis();
                Add(_synopsis);

                _episodesLabel = CreateEpisodesLabel();
                Add(_episodesLabel);
                _episodesStatus = CreateEpisodesStatus();
                Add(_episodesStatus);
                _episodesStatus.Text = "Loading seasons...";
                _episodesStatus.Show();

                _seasonScroll = CreateSeasonScroll();
                Add(_seasonScroll);
                _episodeScroll = CreateEpisodeScroll();
                Add(_episodeScroll);
            }
            else
            {
                _synopsis = CreateSynopsis();
                Add(_synopsis);
            }

            // Explicit focus links: BACK above PLAY, edges clamp.
            _playButton.UpFocusableView = _backButton;
            _backButton.DownFocusableView = _playButton;
            if (_addListButton != null)
            {
                _playButton.RightFocusableView = _addListButton;
                _addListButton.LeftFocusableView = _playButton;
                _addListButton.UpFocusableView = _backButton;
            }

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

        // ---- My List (Add / Remove) ----------------------------------------

        /// <summary>
        /// The ADD TO LIST pill — built ONLY for signed-in users (guests see
        /// no dead button; the honest My List surface is the LOGIN flow from
        /// the home header). Starts as "ADD TO LIST"; the async cloud check
        /// flips it to "IN LIST" when this title is already saved.
        /// </summary>
        private void CreateMyListButton()
        {
            if (!AuthSession.IsSignedIn)
            {
                return;
            }

            _canonicalType = CanonicalFavoriteType();

            int y = _seriesMode ? Theme.SeriesPlayButtonY : Theme.PlayButtonY;
            int height = _seriesMode ? Theme.SeriesPlayButtonHeight : Theme.PlayButtonHeight;
            int x = Theme.PageMargin + Theme.PlayButtonWidth + 24;

            _addListButton = new FocusButton("ADD TO LIST", Theme.PlayButtonWidth, height, false)
            {
                // Center pivot: Position2D measures to the button's own center.
                Position2D = new Position2D(x + Theme.PlayButtonWidth / 2, y + height / 2)
            };
            _addListButton.Selected += OnAddListSelected;
            Add(_addListButton);

            // Membership check in the background — the page paints instantly
            // with "ADD TO LIST" and the marker arrives with the fetch.
            int generation = ++_listCheckGeneration;
            _ = CheckListMembershipAsync(generation);
        }

        /// <summary>Canonical favorite type: an anime-flagged series is stored
        /// as "anime" (the web app's canonicalFavoriteType rule).</summary>
        private string CanonicalFavoriteType()
        {
            string type = (_item.Type ?? "movie").Trim().ToLowerInvariant();
            if (type != "series" && type != "anime" && type != "movie")
            {
                type = "movie";
            }
            if (type == "series" && _item.IsAnime)
            {
                type = "anime";
            }
            return type;
        }

        private async Task CheckListMembershipAsync(int generation)
        {
            try
            {
                List<FavoriteRecord> favorites = await _api.FetchFavoritesAsync();
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _listCheckGeneration || _addListButton == null)
                    {
                        return;
                    }

                    _inList = ContainsFavorite(favorites, _canonicalType, _item.Id);
                    _addListButton.SetLabel(_inList ? "IN LIST" : "ADD TO LIST");
                    Log.Info(MaveroApp.LogTag, "My List check for " + _item.Id + ": " +
                        (_inList ? "already saved" : "not saved"));
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "My List check failed for " + _item.Id + ": " + ex.Message);
                // The pill keeps its ADD TO LIST default — pressing it will
                // simply upsert (idempotent server-side).
            }
        }

        /// <summary>Exact key membership ("{type}:{id}" — the server validator's
        /// key rule) against the fetched favorites.</summary>
        private static bool ContainsFavorite(List<FavoriteRecord> favorites, string contentType, string contentId)
        {
            if (favorites == null || string.IsNullOrEmpty(contentId))
            {
                return false;
            }

            string key = contentType + ":" + contentId;
            foreach (FavoriteRecord record in favorites)
            {
                if (record != null && record.Key == key)
                {
                    return true;
                }
            }
            return false;
        }

        private void OnAddListSelected()
        {
            if (_listBusy || _addListButton == null)
            {
                return;
            }

            _listBusy = true;
            int generation = ++_listCheckGeneration;
            _ = ToggleListAsync(generation);
        }

        private async Task ToggleListAsync(int generation)
        {
            bool success;
            if (_inList)
            {
                Log.Info(MaveroApp.LogTag, "Removing from My List: " + _canonicalType + ":" + _item.Id);
                success = await _api.RemoveFavoriteAsync(_canonicalType, _item.Id);
            }
            else
            {
                FavoriteRecord record = ApiService.BuildFavoriteRecord(_item,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (record == null)
                {
                    success = false;
                }
                else
                {
                    Log.Info(MaveroApp.LogTag, "Adding to My List: " + record.Key);
                    success = await _api.AddFavoriteAsync(record);
                }
            }

            UiDispatcher.Post(() =>
            {
                if (_closed || generation != _listCheckGeneration || _addListButton == null)
                {
                    return;
                }

                if (success)
                {
                    _inList = !_inList;
                    _addListButton.SetLabel(_inList ? "IN LIST" : "ADD TO LIST");
                }
                else
                {
                    // Honest failure state; reverts to the actionable label.
                    _addListButton.SetLabel("RETRY");
                }
                _listBusy = false;
            });
        }

        /// <summary>Fences in-flight fetch binding before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        /// <summary>Re-arms focus when the page returns from the Player screen. The
        /// player's auto-hide overlay only manipulates its own row while it is
        /// up, so PLAY is always a clean, deterministic landing spot.</summary>
        public void RestoreFocus()
        {
            if (_playButton != null)
            {
                FocusManager.Instance.SetCurrentFocusView(_playButton);
            }
        }

        // ---- mode ---------------------------------------------------------

        /// <summary>Series/anime content: TV shows and anime movies-as-series both
        /// play through the season/episode pipeline. Anime detail records report
        /// type "series" + isAnime (TMDB TV on the backend), so BOTH signals count.</summary>
        private static bool IsSeriesContent(MediaItem item)
        {
            if (item == null)
            {
                return false;
            }

            string type = (item.Type ?? string.Empty).Trim().ToLowerInvariant();
            return type == "series" || type == "anime" || item.IsAnime;
        }

        // ---- chrome -------------------------------------------------------

        /// <summary>Full-bleed hero art: rail backdrop, poster crop fallback;
        /// refreshed with the detail backdrop when one arrives. Series pages
        /// use the compressed hero to make room for the episode rail.</summary>
        private ImageView CreateBackdrop()
        {
            _backdropUrl = !string.IsNullOrEmpty(_item.Backdrop) ? _item.Backdrop : _item.Poster;
            int height = _seriesMode ? Theme.SeriesBackdropHeight : Theme.BackdropHeight;

            return new ImageView
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, height),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ResourceUrl = _backdropUrl,
                FittingMode = FittingModeType.ScaleToFill,
                DesiredWidth = Theme.BackdropDecodeWidth,
                DesiredHeight = Theme.BackdropDecodeHeight
            };
        }

        /// <summary>Bottom fade over the hero so it blends into the page background.</summary>
        private View CreateHeroScrim()
        {
            int heroHeight = _seriesMode ? Theme.SeriesBackdropHeight : Theme.BackdropHeight;
            int scrimHeight = _seriesMode ? Theme.SeriesHeroScrimHeight : Theme.HeroScrimHeight;

            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.AssetUrl(Theme.HeroScrimAsset)));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.HeroPatchBorderX, 0f, Theme.HeroPatchBorderX, 0f)));

            return new View
            {
                Position2D = new Position2D(0, heroHeight - scrimHeight),
                Size2D = new Size2D(Theme.ScreenWidth, scrimHeight),
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
            int y = _seriesMode ? Theme.SeriesTitleY : Theme.DetailTitleY;
            int height = _seriesMode ? Theme.SeriesTitleHeight : Theme.DetailTitleHeight;
            int pointSize = _seriesMode ? Theme.SeriesTitlePointSize : Theme.DetailTitlePointSize;
            int width = _seriesMode ? Theme.SeriesColumnWidth : Theme.ScreenWidth - Theme.PageMargin * 2;

            return new TextLabel
            {
                Text = _item.Title ?? string.Empty,
                TextColor = Theme.TextPrimary,
                PointSize = pointSize,
                Ellipsis = true,
                Position2D = new Position2D(Theme.PageMargin, y),
                Size2D = new Size2D(width, height),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateMeta()
        {
            int y = _seriesMode ? Theme.SeriesMetaY : Theme.DetailMetaY;
            int height = _seriesMode ? Theme.SeriesMetaHeight : Theme.DetailMetaHeight;
            int width = _seriesMode ? Theme.SeriesColumnWidth : Theme.ScreenWidth - Theme.PageMargin * 2;

            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.DetailMetaPointSize,
                Ellipsis = true,
                Position2D = new Position2D(Theme.PageMargin, y),
                Size2D = new Size2D(width, height),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private FocusButton CreatePlayButton()
        {
            int y = _seriesMode ? Theme.SeriesPlayButtonY : Theme.PlayButtonY;
            int width = _seriesMode ? Theme.SeriesPlayButtonWidth : Theme.PlayButtonWidth;
            int height = _seriesMode ? Theme.SeriesPlayButtonHeight : Theme.PlayButtonHeight;

            return new FocusButton("PLAY", width, height, true)
            {
                Position2D = new Position2D(
                    Theme.PageMargin + width / 2,
                    y + height / 2)
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

        /// <summary>Series variant: synopsis in the right column, beside the
        /// actions and season selector.</summary>
        private TextLabel CreateSideSynopsis()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.DetailSynopsisPointSize,
                MultiLine = true,
                Position2D = new Position2D(Theme.SeriesSynopsisX, Theme.SeriesSynopsisY),
                Size2D = new Size2D(Theme.SeriesSynopsisWidth, Theme.SeriesSynopsisHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateEpisodesLabel()
        {
            return new TextLabel
            {
                Text = "EPISODES",
                TextColor = Theme.TextSecondary,
                PointSize = 15,
                Position2D = new Position2D(Theme.PageMargin, Theme.SeriesEpisodesLabelY),
                Size2D = new Size2D(600, Theme.SeriesEpisodesLabelHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Honest state line for the episode area (loading / unavailable).</summary>
        private TextLabel CreateEpisodesStatus()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = 16,
                Position2D = new Position2D(Theme.PageMargin, Theme.SeriesEpisodeRailY + 60),
                Size2D = new Size2D(Theme.RailViewportWidth, 44),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Horizontal viewport hosting the season buttons (left column).</summary>
        private ScrollView CreateSeasonScroll()
        {
            return new ScrollView
            {
                Position2D = new Position2D(Theme.PageMargin, Theme.SeriesSeasonRowY),
                Size2D = new Size2D(Theme.SeriesColumnWidth, Theme.SeriesSeasonButtonHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
            };
        }

        /// <summary>Horizontal viewport hosting the episode cards (full width).</summary>
        private ScrollView CreateEpisodeScroll()
        {
            return new ScrollView
            {
                Position2D = new Position2D(Theme.PageMargin, Theme.SeriesEpisodeRailY),
                Size2D = new Size2D(Theme.RailViewportWidth, Theme.EpisodeCardHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
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
                    $"Detail fetch: {_item.Type}/{_item.Id} ('{_item.Title}') seriesMode={_seriesMode}");
                MediaDetail detail = await _api.FetchDetailAsync(_item);
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    try
                    {
                        BindDetail(detail);
                    }
                    catch (Exception ex)
                    {
                        // Visible failure with a working RETRY — never a silent exit.
                        Log.Error(MaveroApp.LogTag, "Detail bind failed: " + ex.Message);
                        Diagnostics.Report(ex, "detail bind", ReloadDetail);
                    }
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag,
                    $"Detail fetch failed for {_item.Id}: {ex.Message} — keeping rail-level data");
                if (_seriesMode)
                {
                    UiDispatcher.Post(() =>
                    {
                        if (_closed)
                        {
                            return;
                        }
                        // Honest empty state: no fabricated seasons.
                        SetEpisodesAreaHidden();
                    });
                }
            }
        }

        /// <summary>Reload entry for the diagnostics RETRY button (re-fetches
        /// the detail record and rebinds this page).</summary>
        public void ReloadDetail()
        {
            _ = LoadDetailAsync();
        }

        /// <summary>Enriches the page with the fetched record (maturity, runtime,
        /// genres, full synopsis, fresh hero art, season selector for series).</summary>
        private void BindDetail(MediaDetail detail)
        {
            if (detail == null)
            {
                Log.Info(MaveroApp.LogTag,
                    $"Detail unavailable for {_item.Id} — keeping rail-level data");
                if (_seriesMode)
                {
                    SetEpisodesAreaHidden();
                }
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
                $"runtime={detail.Runtime} rating={detail.Rating} cast={detail.Cast?.Count ?? 0} " +
                $"seasons={detail.SeasonsData?.Count ?? 0}");

            if (_seriesMode && detail.SeasonsData != null && detail.SeasonsData.Count > 0)
            {
                BindSeasons(detail.SeasonsData);
            }
            else if (_seriesMode)
            {
                // A series without a season index: honest empty state —
                // PLAY still resolves Season 1 Episode 1 server-side.
                SetEpisodesAreaHidden();
            }
        }

        // ---- seasons -------------------------------------------------------

        /// <summary>Builds the season selector from the detail record's season index
        /// and loads the first season's episodes.</summary>
        private void BindSeasons(List<Season> seasons)
        {
            // Keep only the usable rows so button indexes and season indexes
            // stay 1:1 (OnSeasonSelected passes the button index).
            _seasons = new List<Season>();
            if (seasons != null)
            {
                foreach (Season season in seasons)
                {
                    if (season != null && season.Number >= 0)
                    {
                        _seasons.Add(season);
                    }
                }
            }

            if (_seasons.Count == 0)
            {
                // A season index with no usable rows: honest empty state —
                // PLAY still resolves Season 1 Episode 1 server-side.
                SetEpisodesAreaHidden();
                return;
            }

            // Detach focus before tearing down any focused season button
            // (defensive: the initial bind runs while PLAY holds focus).
            View focused = FocusManager.Instance.GetCurrentFocusView();
            foreach (FocusButton button in _seasonButtons)
            {
                if (focused == button)
                {
                    FocusManager.Instance.SetCurrentFocusView(null);
                    break;
                }
            }

            foreach (FocusButton button in _seasonButtons)
            {
                _seasonScroll.Remove(button);
                button.Dispose();
            }
            _seasonButtons.Clear();
            _seasonBaseLabels.Clear();

            FocusButton previous = null;
            for (int i = 0; i < _seasons.Count; i++)
            {
                Season season = _seasons[i];

                int index = i; // button index == season index within the kept list
                string baseLabel = string.IsNullOrEmpty(season.Title)
                    ? "Season " + season.Number
                    : season.Title;
                _seasonBaseLabels.Add(baseLabel);

                FocusButton button = new FocusButton(baseLabel, Theme.SeriesSeasonButtonWidth,
                    Theme.SeriesSeasonButtonHeight, false)
                {
                    // Center pivot: Position2D measures to the button's own center.
                    Position2D = new Position2D(
                        index * (Theme.SeriesSeasonButtonWidth + Theme.SeasonGap)
                            + Theme.SeriesSeasonButtonWidth / 2,
                        Theme.SeriesSeasonButtonHeight / 2)
                };
                button.Selected += () => OnSeasonSelected(index);

                if (previous != null)
                {
                    previous.RightFocusableView = button;
                    button.LeftFocusableView = previous;
                }

                _seasonScroll.Add(button);
                _seasonButtons.Add(button);
                previous = button;
            }

            _seasonScroll.ScrollPositionMax = new Vector2(Math.Max(0f,
                _seasonButtons.Count * (Theme.SeriesSeasonButtonWidth + Theme.SeasonGap)
                - Theme.SeasonGap - Theme.SeriesColumnWidth), 0f);

            Log.Info(MaveroApp.LogTag,
                $"Season selector bound: {_seasonButtons.Count} season(s) for '{_item.Title}'");

            // The first season loads immediately; PLAY defaults to its Episode 1.
            SelectSeason(0);
        }

        /// <summary>Marks one season active (middle-dot prefix, the app-wide
        /// active-marker convention) and (re)loads its episodes.</summary>
        private void SelectSeason(int index)
        {
            if (_seasons == null || index < 0 || index >= _seasons.Count
                || index >= _seasonButtons.Count)
            {
                return;
            }

            _selectedSeasonIndex = index;
            _selectedSeason = _seasons[index];

            for (int i = 0; i < _seasonButtons.Count; i++)
            {
                string label = i == index
                    ? "\u00b7 " + _seasonBaseLabels[i]
                    : _seasonBaseLabels[i];
                _seasonButtons[i].SetLabel(label);
            }

            _pendingEpisode = null; // switching seasons resets the episode pick
            _ = LoadEpisodesAsync(_selectedSeason);
        }

        private void OnSeasonSelected(int index)
        {
            Log.Info(MaveroApp.LogTag,
                $"Season selected: index={index} for '{_item.Title}' — reloading episodes");
            SelectSeason(index);
            ArmSeasonKeepInView(index);
        }

        /// <summary>Keeps the freshly selected season button inside the row viewport.</summary>
        private void ArmSeasonKeepInView(int index)
        {
            if (index < 0)
            {
                return;
            }

            int buttonLeft = index * (Theme.SeriesSeasonButtonWidth + Theme.SeasonGap);
            float scrollX = _seasonScroll.ScrollPosition.X;
            float targetX = scrollX;
            if (buttonLeft - Theme.SeasonGap < scrollX)
            {
                targetX = Math.Max(0f, buttonLeft - Theme.SeasonGap);
            }
            else if (buttonLeft + Theme.SeriesSeasonButtonWidth + Theme.SeasonGap
                > scrollX + Theme.SeriesColumnWidth)
            {
                targetX = buttonLeft + Theme.SeriesSeasonButtonWidth + Theme.SeasonGap
                    - Theme.SeriesColumnWidth;
            }

            if (Math.Abs(targetX - scrollX) > 0.5f)
            {
                _seasonScroll.ScrollTo(new Vector2(targetX, 0f), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }
        }

        // ---- episodes ------------------------------------------------------

        private async Task LoadEpisodesAsync(Season season)
        {
            int generation = ++_episodeFetchGeneration;
            SetEpisodesStatus("Loading episodes...");

            try
            {
                Log.Info(MaveroApp.LogTag,
                    $"Episode fetch: {_item.Id} season={season.Number}");
                SeasonDetail detail = await _api.FetchSeasonAsync(_item.Id, season.Number);
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _episodeFetchGeneration)
                    {
                        return; // page gone or a newer season fetch superseded this one
                    }
                    try
                    {
                        BindEpisodes(detail);
                    }
                    catch (Exception ex)
                    {
                        // Visible failure with a working RETRY — never a silent exit.
                        Log.Error(MaveroApp.LogTag, "Episode bind failed: " + ex.Message);
                        Diagnostics.Report(ex, "episode bind", () => ReloadSeason(season));
                    }
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag,
                    $"Episode fetch failed for {_item.Id} S{season.Number}: {ex.Message}");
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _episodeFetchGeneration)
                    {
                        return;
                    }
                    ClearEpisodeRail();
                    SetEpisodesStatus("Episodes unavailable");
                });
            }
        }

        /// <summary>Reload entry for the diagnostics RETRY button (re-fetches
        /// one season's episodes).</summary>
        private void ReloadSeason(Season season)
        {
            if (season != null)
            {
                _ = LoadEpisodesAsync(season);
            }
        }

        /// <summary>Rebuilds the episode rail for the fetched season and wires the
        /// focus links between the season row, the rail and PLAY.</summary>
        private void BindEpisodes(SeasonDetail detail)
        {
            ClearEpisodeRail();

            List<Episode> episodes = detail?.Episodes;
            if (episodes == null || episodes.Count == 0)
            {
                SetEpisodesStatus(detail == null
                    ? "Episodes unavailable"
                    : "No episodes listed for this season");
                return;
            }

            SetEpisodesStatus(null);

            FocusButton firstSeasonButton = _seasonButtons.Count > 0 ? _seasonButtons[0] : null;

            EpisodeCard previous = null;
            for (int i = 0; i < episodes.Count; i++)
            {
                Episode episode = episodes[i];
                if (episode == null || episode.Number <= 0)
                {
                    continue;
                }

                EpisodeCard card = new EpisodeCard(episode)
                {
                    // Center pivot: Position2D measures to the card's own center,
                    // so the 1.05 focus scale grows symmetrically in place.
                    Position2D = new Position2D(
                        i * (Theme.EpisodeCardWidth + Theme.EpisodeCardGap)
                            + Theme.EpisodeCardWidth / 2,
                        Theme.EpisodeCardHeight / 2)
                };

                card.FocusGained += OnEpisodeFocusGained;
                card.Selected += OnEpisodeSelected;

                if (previous != null)
                {
                    previous.RightFocusableView = card;
                    card.LeftFocusableView = previous;
                }
                else
                {
                    // Row boundary links: episodes UP -> season row; every
                    // season button DOWN -> the first episode card.
                    card.UpFocusableView = firstSeasonButton;
                }

                _episodeScroll.Add(card);
                _episodeCards.Add(card);
                previous = card;
            }

            if (firstSeasonButton != null && _episodeCards.Count > 0)
            {
                foreach (FocusButton button in _seasonButtons)
                {
                    button.DownFocusableView = _episodeCards[0];
                }
            }

            _episodeScroll.ScrollPositionMax = new Vector2(Math.Max(0f,
                _episodeCards.Count * (Theme.EpisodeCardWidth + Theme.EpisodeCardGap)
                - Theme.EpisodeCardGap - Theme.RailViewportWidth), 0f);

            Log.Info(MaveroApp.LogTag,
                $"Episode rail bound: {_episodeCards.Count} episode(s) of season " +
                $"{(_selectedSeason != null ? _selectedSeason.Number.ToString() : "?")} for '{_item.Title}'");

            // If the rebuild detached focus (stale-season fence), put it back
            // on the season the user activated so D-pad navigation continues.
            if (FocusManager.Instance.GetCurrentFocusView() == null && _selectedSeasonIndex >= 0)
            {
                FocusManager.Instance.SetCurrentFocusView(_seasonButtons[_selectedSeasonIndex]);
            }
        }

        /// <summary>Removes and disposes every episode card (focus-safe).</summary>
        private void ClearEpisodeRail()
        {
            if (_episodeCards.Count == 0)
            {
                return;
            }

            View focused = FocusManager.Instance.GetCurrentFocusView();
            foreach (EpisodeCard card in _episodeCards)
            {
                if (focused == card)
                {
                    FocusManager.Instance.SetCurrentFocusView(null);
                    break;
                }
            }

            foreach (EpisodeCard card in _episodeCards)
            {
                _episodeScroll.Remove(card);
                card.Dispose();
            }
            _episodeCards.Clear();
        }

        /// <summary>Horizontal keep-in-view scrolling for the episode rail
        /// (same one-card peek the home rails use).</summary>
        private void OnEpisodeFocusGained(object source, EventArgs e)
        {
            EpisodeCard card = source as EpisodeCard;
            if (card == null)
            {
                return;
            }

            int index = _episodeCards.IndexOf(card);
            if (index < 0)
            {
                return;
            }

            int cardLeft = index * (Theme.EpisodeCardWidth + Theme.EpisodeCardGap);
            float scrollX = _episodeScroll.ScrollPosition.X;
            float targetX = scrollX;
            if (cardLeft - Theme.EpisodeCardGap < scrollX)
            {
                targetX = Math.Max(0f, cardLeft - Theme.EpisodeCardGap);
            }
            else if (cardLeft + Theme.EpisodeCardWidth + Theme.EpisodeCardGap
                > scrollX + Theme.RailViewportWidth)
            {
                targetX = cardLeft + Theme.EpisodeCardWidth + Theme.EpisodeCardGap
                    - Theme.RailViewportWidth;
            }

            if (Math.Abs(targetX - scrollX) > 0.5f)
            {
                _episodeScroll.ScrollTo(new Vector2(targetX, 0f), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }
        }

        /// <summary>Hides the episode label + status (series pages without a
        /// usable season index — no fabricated rows).</summary>
        private void SetEpisodesAreaHidden()
        {
            _episodesLabel.Hide();
            _episodesStatus.Hide();
        }

        private void SetEpisodesStatus(string message)
        {
            if (string.IsNullOrEmpty(message))
            {
                _episodesStatus.Hide();
                return;
            }

            _episodesStatus.Text = message;
            _episodesStatus.Show();
        }

        // ---- text helpers --------------------------------------------------

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
        /// max-line property, so length is the only honest lever). Series pages
        /// use the narrower right-column clamp.</summary>
        private string ClampSynopsis(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            int maxChars = _seriesMode ? Theme.SeriesSynopsisMaxChars : Theme.SynopsisMaxChars;
            string trimmed = text.Trim();
            if (trimmed.Length <= maxChars)
            {
                return trimmed;
            }

            return trimmed.Substring(0, maxChars).TrimEnd() + "…";
        }

        // ---- selection (Enter/OK) -----------------------------------------

        /// <summary>PLAY: movies resolve without season/episode; series resolve the
        /// user's picked episode, else Episode 1 of the selected (default first)
        /// season.</summary>
        private void OnPlaySelected()
        {
            PlaybackTarget target = null;
            if (_seriesMode)
            {
                int seasonNumber = _selectedSeason != null ? _selectedSeason.Number : 1;
                int episodeNumber = _pendingEpisode != null
                    && _pendingEpisode.Season.HasValue
                    && _pendingEpisode.Season.Value == seasonNumber
                    && _pendingEpisode.Episode.HasValue
                    ? _pendingEpisode.Episode.Value
                    : 1;
                target = new PlaybackTarget { Season = seasonNumber, Episode = episodeNumber };
            }

            Log.Info(MaveroApp.LogTag,
                $"Play requested: '{_item.Title}' (id={_item.Id})" +
                (target != null ? $" target={target.Label}" : string.Empty) +
                " — video player lands next iteration");
            PlayRequested?.Invoke(target);
        }

        private void OnEpisodeSelected(Episode episode)
        {
            if (episode == null || episode.Number <= 0)
            {
                return;
            }

            int seasonNumber = episode.Season > 0
                ? episode.Season
                : (_selectedSeason != null ? _selectedSeason.Number : 1);
            _pendingEpisode = new PlaybackTarget { Season = seasonNumber, Episode = episode.Number };

            Log.Info(MaveroApp.LogTag,
                $"Episode selected: '{episode.Title}' ({_pendingEpisode.Label}) of '{_item.Title}'" +
                " — video player lands next iteration");
            PlayRequested?.Invoke(_pendingEpisode);
        }

        private void OnBackSelected()
        {
            Log.Info(MaveroApp.LogTag, $"Back button pressed on detail '{_item.Title}'");
            CloseRequested?.Invoke();
        }
    }
}
