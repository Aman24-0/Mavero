// ============================================================
// Mavero TV — home screen UI (Tizen.NUI, API 6).
//
// Data-driven phase: the header stays fixed and ALL rails returned
// by GET /api/tv/home render below it as (title + horizontal rail)
// sections inside a vertically scrollable host. Every card is a
// MediaCard bound to a real MediaItem — full-bleed 2:3 poster with
// rounded corners, bottom scrim, title, cyan focus ring.
//
// D-pad focus engine:
//   - cards are Focusable and linked Left/Right along each rail;
//   - FocusManager (built-in keyboard navigation) moves focus on
//     arrow keys, honouring those links inside a rail and its
//     spatial algorithm across rails;
//   - the header's MY LIST + SEARCH pills (top-right) are focusable
//     too: MY LIST --Left--> SEARCH, both pills --Down--> the first
//     card of the first rail, and Up from that card lands on SEARCH
//     (MY LIST stays one Left press away) — Enter on MY LIST raises
//     MyListRequested (App.cs routes to My List or the LoginPage by
//     AuthSession), Enter on SEARCH raises SearchRequested and App.cs
//     swaps in the SearchPage;
//   - FocusGained triggers the card visuals (MediaCard) and the
//     keep-in-view scrolling (vertical host + horizontal rail), and
//     records the focused card so App can restore focus after a
//     Detail round-trip (RestoreFocus);
//   - initial focus lands on the first card of the first rail once
//     the API data is bound.
//
// Navigation: Enter/OK on a card raises ItemSelected; App.cs swaps
// in the DetailPage and this page is hidden (kept alive so the
// rails and scroll positions survive the round-trip).
//
// Threading: the API fetch completes on the thread pool; rail
// binding is marshaled back through UiDispatcher (DALi objects are
// only touched on the UI thread).
//
// API 6 notes (verified against the TizenFX 6.0.0.14995 refs):
//   - Positioning uses the modern pivot pattern (API5+):
//     PositionUsesPivotPoint + PivotPoint.TopLeft so Position2D measures
//     from the parent's top-left to the view's own pivot point.
//   - The scrollable container is Tizen.NUI.ScrollView (the only API6
//     scrollable) with scroll bounds via Scrollable.ScrollPositionMin/Max
//     and animated moves via ScrollView.ScrollTo(Vector2, duration, alpha).
//   - Rounded corners come from 9-patch image visuals
//     (ImageVisualProperty.Border) because API6 color visuals
//     have no corner-radius support.
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
// container in the target API profile.
#pragma warning disable CS0618

namespace MaveroTv
{
    /// <summary>TV home screen: fixed header + vertically scrolled rails of poster cards.</summary>
    public class HomePage : View
    {
        // Honest status states (no fake content on outages).
        private const string StatusLoading = "Loading...";
        private const string StatusUnavailable = "Content unavailable - check the network connection";
        private const string StatusEmpty = "No content available right now";

        private readonly ApiService _api = new ApiService();
        private readonly List<RailSection> _sections = new List<RailSection>();

        private ScrollView _pageScroll;
        private View _railsContent;
        private TextLabel _status;
        private int _contentHeight;

        /// <summary>Most recently focused card — restored after Detail round-trips.</summary>
        private MediaCard _focusedCard;

        /// <summary>Raised when the user presses Enter/OK on a focused card.</summary>
        public event Action<MediaItem> ItemSelected;

        /// <summary>Raised when the user presses Enter/OK on the header's SEARCH
        /// pill — App.cs swaps in the SearchPage.</summary>
        public event Action SearchRequested;

        /// <summary>Raised when the user presses Enter/OK on the header's MY LIST
        /// pill — App.cs routes to MyListPage (signed in) or LoginPage (guest).</summary>
        public event Action MyListRequested;

        /// <summary>One bound rail: its scroll container, cards, and page offset.</summary>
        private class RailSection
        {
            public ScrollView Rail;
            public List<MediaCard> Cards = new List<MediaCard>();
            public int Top; // y within the page content
        }

        /// <summary>Header SEARCH pill — the entry point to the SearchPage.</summary>
        private FocusButton _searchButton;

        /// <summary>Header MY LIST pill — the entry point to My List / Login.</summary>
        private FocusButton _listButton;

        public HomePage()
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            Add(CreateHeader());
            CreateRailsHost();

            _status = CreateStatus();
            Add(_status);

            // The pump must be created on the UI thread, before any
            // background continuation can Post rail binding to it.
            UiDispatcher.Start();
            _ = LoadRailsAsync();
        }

        // ---- chrome -------------------------------------------------------

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

            // Cyan underline bar — the brand mark from the web header.
            View accentBar = new View
            {
                Position2D = new Position2D(Theme.PageMargin, 128),
                Size2D = new Size2D(96, 6),
                BackgroundColor = Theme.Accent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            // SEARCH pill, top-right — the header's focusable entry point to
            // the SearchPage (TV remotes have no text input; the SearchPage
            // brings its own D-pad virtual keyboard).
            _searchButton = new FocusButton("SEARCH", Theme.HeaderSearchButtonWidth,
                Theme.HeaderSearchButtonHeight, false)
            {
                // Center pivot: Position2D measures to the button's own center.
                Position2D = new Position2D(
                    Theme.HeaderSearchButtonX + Theme.HeaderSearchButtonWidth / 2,
                    Theme.HeaderSearchButtonY + Theme.HeaderSearchButtonHeight / 2)
            };
            _searchButton.Selected += OnSearchSelected;

            // MY LIST pill, left of SEARCH — the entry point to the saved
            // list (signed in) or the sign-in flow (guest); App.cs routes.
            _listButton = new FocusButton("MY LIST", Theme.HeaderListButtonWidth,
                Theme.HeaderListButtonHeight, false)
            {
                Position2D = new Position2D(
                    Theme.HeaderListButtonX + Theme.HeaderListButtonWidth / 2,
                    Theme.HeaderListButtonY + Theme.HeaderListButtonHeight / 2)
            };
            _listButton.Selected += OnListSelected;

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
            header.Add(_listButton);
            header.Add(_searchButton);
            return header;
        }

        /// <summary>Vertical host that scrolls the rails below the fixed header.</summary>
        private void CreateRailsHost()
        {
            _railsContent = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, 0), // height set once rails bind
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _pageScroll = new ScrollView
            {
                Position2D = new Position2D(0, Theme.PageScrollY),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.PageViewportHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
            };

            _pageScroll.Add(_railsContent);
            Add(_pageScroll);
        }

        private static TextLabel CreateStatus()
        {
            return new TextLabel
            {
                Text = StatusLoading,
                TextColor = Theme.TextSecondary,
                PointSize = 20,
                Position2D = new Position2D(Theme.PageMargin, Theme.PageScrollY + 64),
                Size2D = new Size2D(Theme.RailViewportWidth, 40),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        // ---- data → UI binding -------------------------------------------

        private async Task LoadRailsAsync()
        {
            try
            {
                List<TvRail> rails = await _api.FetchHomeRailsAsync();
                Log.Info(ApiService.LogTag, $"TV home fetched — {rails.Count} rail(s); binding on UI thread");
                UiDispatcher.Post(() => BindRails(rails));
            }
            catch (Exception ex)
            {
                Log.Error(ApiService.LogTag, $"TV home fetch failed: {ex.Message}");
                UiDispatcher.Post(() => ShowStatus(StatusUnavailable));
            }
        }

        private void BindRails(List<TvRail> rails)
        {
            if (rails == null || rails.Count == 0)
            {
                ShowStatus(StatusEmpty);
                return;
            }

            _status.Hide();

            MediaCard firstCard = null;
            foreach (TvRail rail in rails)
            {
                if (rail == null || rail.Items == null || rail.Items.Count == 0)
                {
                    continue;
                }

                RailSection section = BuildSection(rail, _sections.Count);
                _sections.Add(section);
                if (firstCard == null && section.Cards.Count > 0)
                {
                    firstCard = section.Cards[0];
                }
            }

            _contentHeight = _sections.Count * Theme.SectionHeight;
            _railsContent.Size2D = new Size2D(Theme.ScreenWidth, _contentHeight);
            _pageScroll.ScrollPositionMax = new Vector2(
                0f, Math.Max(0f, _contentHeight - Theme.PageViewportHeight));

            Log.Info(ApiService.LogTag,
                "Bound " + _sections.Count + " rail(s), " + _contentHeight +
                "px of content, focus lands on first card");

            if (firstCard != null)
            {
                // Link the header pills into the focus flow now that the
                // first card exists: Down from either pill returns here, Up
                // from the first card jumps to SEARCH (MY LIST is one Left
                // press away from it). SEARCH --Left--> MY LIST completes
                // the header cluster.
                if (_searchButton != null)
                {
                    _searchButton.DownFocusableView = firstCard;
                    firstCard.UpFocusableView = _searchButton;
                }
                if (_listButton != null)
                {
                    _listButton.DownFocusableView = firstCard;
                    _listButton.RightFocusableView = _searchButton;
                    if (_searchButton != null)
                    {
                        _searchButton.LeftFocusableView = _listButton;
                    }
                }

                FocusManager.Instance.SetCurrentFocusView(firstCard);
            }
        }

        /// <summary>Builds one (title + horizontal card rail) section and wires the
        /// focus links along the rail.</summary>
        private RailSection BuildSection(TvRail rail, int sectionIndex)
        {
            int top = sectionIndex * Theme.SectionHeight;

            TextLabel sectionTitle = new TextLabel
            {
                Text = rail.Title,
                TextColor = Theme.TextSecondary,
                PointSize = 24,
                Position2D = new Position2D(Theme.PageMargin, Theme.RailTitleOffset),
                Size2D = new Size2D(600, Theme.RailTitleHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            ScrollView railScroll = new ScrollView
            {
                Position2D = new Position2D(Theme.PageMargin, Theme.RailOffset),
                Size2D = new Size2D(Theme.RailViewportWidth, Theme.CardHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(0f, 0f)
            };

            RailSection section = new RailSection { Rail = railScroll, Top = top };

            MediaCard previous = null;
            for (int i = 0; i < rail.Items.Count; i++)
            {
                MediaItem item = rail.Items[i];
                if (item == null)
                {
                    continue;
                }

                MediaCard card = new MediaCard(item)
                {
                    // Center pivot: Position2D measures to the card's own center,
                    // so the 1.05 focus scale grows symmetrically in place.
                    Position2D = new Position2D(
                        i * (Theme.CardWidth + Theme.CardGap) + Theme.CardWidth / 2,
                        Theme.CardHeight / 2)
                };

                card.FocusGained += OnCardFocusGained;
                card.Selected += OnCardSelected;

                // Explicit focus links along the rail; edges stay null so the
                // built-in navigation clamps at rail boundaries.
                if (previous != null)
                {
                    previous.RightFocusableView = card;
                    card.LeftFocusableView = previous;
                }

                railScroll.Add(card);
                section.Cards.Add(card);
                previous = card;
            }

            int railContentWidth = section.Cards.Count * (Theme.CardWidth + Theme.CardGap) - Theme.CardGap;
            railScroll.ScrollPositionMax = new Vector2(
                Math.Max(0f, railContentWidth - Theme.RailViewportWidth), 0f);

            Log.Info(ApiService.LogTag,
                $"Rail '{rail.Title}' [{rail.Key}] — {section.Cards.Count} card(s) bound");

            View sectionView = new View
            {
                Position2D = new Position2D(0, top),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.SectionHeight),
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            sectionView.Add(sectionTitle);
            sectionView.Add(railScroll);
            _railsContent.Add(sectionView);

            return section;
        }

        // ---- focus-driven scrolling ---------------------------------------

        private void OnCardFocusGained(object source, EventArgs e)
        {
            MediaCard card = source as MediaCard;
            if (card == null)
            {
                return;
            }

            _focusedCard = card;

            RailSection section = _sections.Find(s => s.Cards.Contains(card));
            if (section == null)
            {
                return;
            }

            // Vertical: keep the focused card's rail inside the page viewport.
            int railTop = section.Top + Theme.RailOffset;
            float scrollY = _pageScroll.ScrollPosition.Y;
            float targetY = scrollY;
            if (railTop < scrollY)
            {
                targetY = railTop;
            }
            else if (railTop + Theme.CardHeight > scrollY + Theme.PageViewportHeight)
            {
                targetY = railTop + Theme.CardHeight - Theme.PageViewportHeight;
            }

            if (Math.Abs(targetY - scrollY) > 0.5f)
            {
                _pageScroll.ScrollTo(new Vector2(0f, targetY), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }

            // Horizontal: keep the focused card inside its rail viewport with
            // a one-card peek of the next/previous card.
            int index = section.Cards.IndexOf(card);
            int cardLeft = index * (Theme.CardWidth + Theme.CardGap);
            float scrollX = section.Rail.ScrollPosition.X;
            float targetX = scrollX;
            if (cardLeft - Theme.CardGap < scrollX)
            {
                targetX = Math.Max(0f, cardLeft - Theme.CardGap);
            }
            else if (cardLeft + Theme.CardWidth + Theme.CardGap > scrollX + Theme.RailViewportWidth)
            {
                targetX = cardLeft + Theme.CardWidth + Theme.CardGap - Theme.RailViewportWidth;
            }

            if (Math.Abs(targetX - scrollX) > 0.5f)
            {
                section.Rail.ScrollTo(new Vector2(targetX, 0f), Theme.ScrollAnimMs,
                    new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            }
        }

        // ---- selection (Enter/OK) -----------------------------------------

        private void OnCardSelected(MediaItem item)
        {
            Log.Info(MaveroApp.LogTag,
                $"Selected: '{item.Title}' (id={item.Id}, year={item.Year}) — opening detail");
            ItemSelected?.Invoke(item);
        }

        private void OnSearchSelected()
        {
            Log.Info(MaveroApp.LogTag, "Search button pressed — opening search");
            SearchRequested?.Invoke();
        }

        private void OnListSelected()
        {
            Log.Info(MaveroApp.LogTag, "My List button pressed — signedIn=" + AuthSession.IsSignedIn);
            MyListRequested?.Invoke();
        }

        /// <summary>Re-arms focus after the page returns from the Detail screen.</summary>
        public void RestoreFocus()
        {
            MediaCard target = _focusedCard;
            if (target == null)
            {
                RailSection first = _sections.Find(s => s.Cards.Count > 0);
                target = first?.Cards[0];
            }

            if (target != null)
            {
                FocusManager.Instance.SetCurrentFocusView(target);
            }
        }

        private void ShowStatus(string message)
        {
            _status.Text = message;
            _status.Show();
        }
    }
}
#pragma warning restore CS0618
