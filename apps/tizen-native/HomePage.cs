// ============================================================
// Mavero TV — home screen UI (Tizen.NUI, API 6).
//
// Phase 1 scaffold: brand header + horizontally scrollable
// "Trending movies" rail of rounded cards, positioned on the
// fixed 1920x1080 TV surface with the web app's exact palette
// (see Theme.cs). Cards are placeholders here; the next
// iteration binds ApiService.FetchHomeRailsAsync() output to
// real poster cards.
//
// API 6 notes (verified against the TizenFX 6.0.0.14995 refs):
//   - Positioning uses the modern pivot pattern (API5+):
//     PositionUsesPivotPoint + PivotPoint.TopLeft so Position2D measures
//     from the parent's top-left to the view's own top-left.
//   - The scrollable container is Tizen.NUI.ScrollView (the only API6
//     scrollable) with scroll bounds via Scrollable.ScrollPositionMin/Max.
//   - Rounded card corners come from a 9-patch image visual
//     (ImageVisualProperty.Border) because API6 color visuals
//     have no corner-radius support.
// ============================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>TV home screen: header + scrollable rail of rounded cards.</summary>
    public class HomePage : View
    {
        // Modern NUI positioning (API5+): pivot-based. PositionUsesPivotPoint
        // makes Position2D measure from the parent's top-left to the view's
        // own top-left. Tizen.NUI.PivotPoint is a static class shadowed by
        // the same-named View property, so the value is cached once here.
        private static readonly Position TopLeftPivot = Tizen.NUI.PivotPoint.TopLeft;

        // Rail metrics (8 scaffold cards at the real Theme card metrics).
        private const int CardCount = 8;
        private static readonly int RailContentWidth = CardCount * Theme.CardWidth + (CardCount - 1) * Theme.CardGap;

        /// <summary>9-patch border inset of card-bg.png (corner-safe stretch margin).</summary>
        private const float CardPatchBorder = 18f;

        private readonly ApiService _api = new ApiService();

        public HomePage()
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = TopLeftPivot;
            PositionUsesPivotPoint = true;

            Add(CreateHeader());
            Add(CreateTrendingRail());

            // Prove the data path inside the native runtime: fetch the
            // production rails and print every title via Tizen.Log.
            // (Continuations leave the UI thread, so this phase only logs;
            // main-thread UI binding arrives with the data-driven cards.)
            _ = FetchHomeDataAsync();
        }

        // ---- UI construction ---------------------------------------------

        private static View CreateHeader()
        {
            TextLabel brand = new TextLabel
            {
                Text = "MAVERO",
                TextColor = Theme.TextPrimary,
                PointSize = 36,
                Position2D = new Position2D(Theme.PageMargin, 48),
                Size2D = new Size2D(600, 72),
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            // Cyan underline bar — the brand mark from the web header.
            View accentBar = new View
            {
                Position2D = new Position2D(Theme.PageMargin, 128),
                Size2D = new Size2D(96, 6),
                BackgroundColor = Theme.Accent,
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            View header = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, 160),
                BackgroundColor = Color.Transparent,
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            header.Add(brand);
            header.Add(accentBar);
            return header;
        }

        private static View CreateTrendingRail()
        {
            TextLabel sectionTitle = new TextLabel
            {
                Text = "Trending movies",
                TextColor = Theme.TextSecondary,
                PointSize = 24,
                Position2D = new Position2D(Theme.PageMargin, 196),
                Size2D = new Size2D(600, 44),
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            // Horizontal rail: 8 cards (1928px content) inside a 1792px
            // viewport -> 136px of horizontal scroll range.
            // CS0618: the API6 ScrollView ctor is marked "use Tizen.NUI.Components",
            // but API6 Components ships no scrollable replacement — this is the
            // only scrollable container in the target API profile.
#pragma warning disable CS0618
            ScrollView rail = new ScrollView
            {
                Position2D = new Position2D(Theme.PageMargin, 264),
                Size2D = new Size2D(Theme.ScreenWidth - Theme.PageMargin * 2, Theme.CardHeight),
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true,
                ScrollPositionMin = new Vector2(0f, 0f),
                ScrollPositionMax = new Vector2(RailContentWidth - (Theme.ScreenWidth - Theme.PageMargin * 2), 0f)
            };
#pragma warning restore CS0618

            for (int i = 0; i < CardCount; i++)
            {
                rail.Add(CreatePlaceholderCard(i));
            }

            View section = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, 264 + Theme.CardHeight),
                BackgroundColor = Color.Transparent,
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            section.Add(sectionTitle);
            section.Add(rail);
            return section;
        }

        private static View CreatePlaceholderCard(int index)
        {
            int x = index * (Theme.CardWidth + Theme.CardGap);
            View card = new View
            {
                Position2D = new Position2D(x, 0),
                Size2D = new Size2D(Theme.CardWidth, Theme.CardHeight),
                Background = RoundedCardSurface(),
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            // Dim poster placeholder block inside the card.
            View posterBlock = new View
            {
                Position2D = new Position2D(12, 12),
                Size2D = new Size2D(Theme.CardWidth - 24, Theme.CardHeight - 76),
                BackgroundColor = Theme.SurfaceFocused,
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            card.Add(posterBlock);

            TextLabel placeholderTitle = new TextLabel
            {
                Text = "Coming soon",
                TextColor = Theme.TextSecondary,
                PointSize = 14,
                Position2D = new Position2D(12, Theme.CardHeight - 56),
                Size2D = new Size2D(Theme.CardWidth - 24, 36),
                PivotPoint = TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            card.Add(placeholderTitle);
            return card;
        }

        /// <summary>
        /// Rounded card background matching the web app's 12px card radius.
        /// card-bg.png is a #161616 rounded rectangle with transparent
        /// corners; the 18px 9-patch border keeps the corners intact while
        /// the middle stretches to any card size.
        /// </summary>
        private static PropertyMap RoundedCardSurface()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue("card-bg.png"));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(CardPatchBorder, CardPatchBorder, CardPatchBorder, CardPatchBorder)));
            return map;
        }

        // ---- Data proof (this phase) ------------------------------------

        private async Task FetchHomeDataAsync()
        {
            try
            {
                List<TvRail> rails = await _api.FetchHomeRailsAsync();
                Log.Info(ApiService.LogTag, $"TV home fetch OK — {rails.Count} rail(s)");

                foreach (TvRail rail in rails)
                {
                    Log.Info(ApiService.LogTag, $"Rail '{rail.Title}' [{rail.Key}] — {rail.Items.Count} item(s)");
                    foreach (MediaItem item in rail.Items)
                    {
                        Log.Info(ApiService.LogTag, $"  [{rail.Title}] {item.Title} ({item.Year}) — id={item.Id}, type={item.Type}");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error(ApiService.LogTag, $"TV home fetch failed: {ex.Message}");
            }
        }
    }
}
