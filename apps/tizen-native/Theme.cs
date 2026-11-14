// ============================================================
// Mavero TV — design tokens.
//
// Single source of truth for the native TV look. Values mirror
// the web app (apps/web) dark palette so the TV experience looks
// exactly like maveroweb.space:
//   page background #0a0a0a, white text, cyan #00d9ff accent,
//   near-black rounded cards (#161616), 64px TV-safe page margin.
//
// Colors are stored as Tizen.NUI.Color (floats 0-1) converted from
// the same hex values the web app uses in its global styles.
//
// The layout block also pins the D-pad focus engine metrics: focus
// scale, focus/scroll animation durations, and the rail/section
// geometry that the keep-in-view scrolling math in HomePage uses.
// ============================================================
using Tizen.NUI;

namespace MaveroTv
{
    /// <summary>Design tokens mirroring the Mavero web app dark theme.</summary>
    public static class Theme
    {
        // ---- Colors (from the web app's global dark palette) ----

        /// <summary>#0a0a0a — page background.</summary>
        public static readonly Color Background = Hex(0x0A0A0A);

        /// <summary>#161616 — card / rail surface.</summary>
        public static readonly Color Surface = Hex(0x161616);

        /// <summary>#1f1f1f — focused / hovered card surface.</summary>
        public static readonly Color SurfaceFocused = Hex(0x1F1F1F);

        /// <summary>#ffffff — headings and card titles.</summary>
        public static readonly Color TextPrimary = Hex(0xFFFFFF);

        /// <summary>#9ca3af — secondary metadata text.</summary>
        public static readonly Color TextSecondary = Hex(0x9CA3AF);

        /// <summary>#00d9ff — cyan accent (brand highlights, focus ring).</summary>
        public static readonly Color Accent = Hex(0x00D9FF);

        // ---- Layout (TV windows run at a fixed 1920x1080) ----

        public const int ScreenWidth = 1920;
        public const int ScreenHeight = 1080;

        /// <summary>Horizontal safe margin — matches the web app's page gutter.</summary>
        public const int PageMargin = 64;

        /// <summary>y offset where the vertically scrollable rails host starts (below the fixed header).</summary>
        public const int PageScrollY = 160;

        /// <summary>Viewport height of the vertical rails host.</summary>
        public const int PageViewportHeight = ScreenHeight - PageScrollY;

        // ---- Rails (one section = title + horizontal card rail) ----

        /// <summary>Rail viewport width: screen minus both page margins.</summary>
        public const int RailViewportWidth = ScreenWidth - PageMargin * 2;

        /// <summary>Section title top offset inside its section.</summary>
        public const int RailTitleOffset = 16;

        /// <summary>Section title height.</summary>
        public const int RailTitleHeight = 44;

        /// <summary>Rail y offset inside its section (below the title).</summary>
        public const int RailOffset = RailTitleOffset + RailTitleHeight + 12;

        /// <summary>Total section height: title block + card rail + bottom gap.</summary>
        public const int SectionHeight = RailOffset + CardHeight + 56;

        // ---- Cards (2:3 poster ratio, rounded like the web app) ----

        public const int CardWidth = 220;
        public const int CardHeight = 330;
        public const int CardGap = 24;
        public const float CardCornerRadius = 12f;

        /// <summary>Height of the dark scrim laid over the poster bottom (title strip).</summary>
        public const int CardScrimHeight = 120;

        /// <summary>Card title font size (PointSize).</summary>
        public const int CardTitlePointSize = 16;

        /// <summary>Horizontal inset of the card title.</summary>
        public const int CardTitleInset = 14;

        // ---- D-pad focus engine ----

        /// <summary>Focused card scale-up (web-app hover feel).</summary>
        public const float FocusScale = 1.05f;

        /// <summary>Focus scale animation duration (ms).</summary>
        public const int FocusAnimMs = 120;

        /// <summary>Keep-in-view scroll animation duration (ms).</summary>
        public const int ScrollAnimMs = 240;

        /// <summary>9-patch border inset of card-focus.png (corner-safe stretch margin).</summary>
        public const float FocusPatchBorder = 26f;

        /// <summary>9-patch border inset of card-bg.png (corner-safe stretch margin).</summary>
        public const float CardPatchBorder = 18f;

        /// <summary>9-patch border (left, top, right, bottom) of scrim.png: the 2px
        /// side margins stretch horizontally; the full 120px height maps 1:1.</summary>
        public const int ScrimPatchBorderX = 3;

        // ---- Detail page (hero + metadata + actions) ----

        /// <summary>Backdrop hero height — top ~57% of the screen.</summary>
        public const int BackdropHeight = 620;

        /// <summary>Height of the bottom fade that blends the backdrop into the page.</summary>
        public const int HeroScrimHeight = 300;

        /// <summary>9-patch border (left, right) of hero-scrim.png (same shape as scrim.png).</summary>
        public const int HeroPatchBorderX = 3;

        public const int DetailTitlePointSize = 40;
        public const int DetailMetaPointSize = 17;
        public const int DetailSynopsisPointSize = 16;

        /// <summary>y of the detail title block (just below the backdrop).</summary>
        public const int DetailTitleY = 650;
        public const int DetailTitleHeight = 92;

        public const int DetailMetaY = 750;
        public const int DetailMetaHeight = 40;

        public const int PlayButtonY = 816;
        public const int PlayButtonWidth = 260;
        public const int PlayButtonHeight = 76;

        public const int BackButtonX = 64;
        public const int BackButtonY = 56;
        public const int BackButtonWidth = 150;
        public const int BackButtonHeight = 56;

        /// <summary>x of the search page's BACK pill (top-right corner; width/height
        /// shared with the detail page's pill).</summary>
        public const int SearchBackButtonX = ScreenWidth - PageMargin - BackButtonWidth;

        public const int SynopsisY = 928;
        public const int SynopsisWidth = 1200;
        public const int SynopsisHeight = 116;

        /// <summary>Synopsis is clamped to this many chars (~3 wrapped lines at
        /// 1200px / 16pt) — API6 TextLabel has no max-line property.</summary>
        public const int SynopsisMaxChars = 240;

        /// <summary>9-patch border inset of button-idle.png / button-active.png.</summary>
        public const int ButtonPatchBorder = 22;

        /// <summary>Detail-page backdrop decode size (TMDB w1280 is 1280x720).</summary>
        public const int BackdropDecodeWidth = 1280;
        public const int BackdropDecodeHeight = 720;

        // ---- Detail page, series/anime variant ----
        //
        // Same page, compressed hero: the vertical space movies spend on a
        // tall backdrop + bottom synopsis is given to the season selector
        // and the episode rail instead. The synopsis moves to a right-hand
        // column beside the actions.
        //
        //   [0..420]    backdrop hero (full-bleed, bottom fade);
        //   [436]       title (left column);
        //   [520]       meta line;
        //   [576..644]  PLAY button;
        //   [668..724]  season selector (horizontal FocusButtons);
        //   [748]       EPISODES label;
        //   [788..988]  episode rail (16:9 still cards);
        //   right of the left column: synopsis (y 440..740).

        /// <summary>Series hero height — compressed so the episode rail fits.</summary>
        public const int SeriesBackdropHeight = 420;

        /// <summary>Bottom fade height over the series hero (same asset as movies).</summary>
        public const int SeriesHeroScrimHeight = 220;

        public const int SeriesTitleY = 436;
        public const int SeriesTitleHeight = 76;
        public const int SeriesTitlePointSize = 38;

        public const int SeriesMetaY = 520;
        public const int SeriesMetaHeight = 34;

        public const int SeriesPlayButtonY = 576;
        public const int SeriesPlayButtonWidth = 260;
        public const int SeriesPlayButtonHeight = 68;

        /// <summary>Left column width: title, meta, PLAY and the season viewport.</summary>
        public const int SeriesColumnWidth = 1020;

        public const int SeriesSynopsisX = 1128;
        public const int SeriesSynopsisY = 440;
        public const int SeriesSynopsisWidth = 728;
        public const int SeriesSynopsisHeight = 300;

        /// <summary>Synopsis clamp for the narrower right column (~6 wrapped lines).</summary>
        public const int SeriesSynopsisMaxChars = 280;

        public const int SeriesSeasonRowY = 668;
        public const int SeriesSeasonButtonWidth = 210;
        public const int SeriesSeasonButtonHeight = 56;
        public const int SeasonGap = 16;

        public const int SeriesEpisodesLabelY = 748;
        public const int SeriesEpisodesLabelHeight = 30;

        /// <summary>Top of the episode rail (label sits directly above).</summary>
        public const int SeriesEpisodeRailY = 788;

        /// <summary>16:9 episode still card (rounded via episode-mask.png).</summary>
        public const int EpisodeCardWidth = 356;
        public const int EpisodeCardHeight = 200;
        public const int EpisodeCardGap = 24;

        /// <summary>Episode number badge ("E1") inset inside the card.</summary>
        public const int EpisodeBadgeInset = 12;
        public const int EpisodeBadgeWidth = 64;
        public const int EpisodeBadgeHeight = 36;

        /// <summary>Bottom scrim strip over the episode still (title strip).</summary>
        public const int EpisodeScrimHeight = 72;

        /// <summary>9-patch border inset of episode-mask.png (matches poster-mask radius).</summary>
        public const float EpisodeCornerRadius = 12f;

        // ---- Player page (video + overlay + popups) ----

        /// <summary>Overlay control row: y and height (top edge of the screen).</summary>
        public const int OverlayY = 56;
        public const int OverlayHeight = 56;
        public const int OverlayGap = 20;

        public const int PlayerBackButtonWidth = 140;
        public const int PlayerPlayButtonWidth = 160;
        public const int PlayerServerButtonWidth = 240;
        public const int PlayerSourceButtonWidth = 200;

        /// <summary>Overlay auto-hide delay (ms) — TV-standard 3s of inactivity.</summary>
        public const int OverlayHideMs = 3000;

        /// <summary>Status line (buffering/errors) pinned to the bottom of the screen;
        /// it stays visible even while the overlay is hidden.</summary>
        public const int PlayerStatusY = 980;
        public const int PlayerStatusHeight = 48;
        public const int PlayerStatusPointSize = 16;

        // ---- Search page (virtual keyboard + results grid) ----
        //
        // Vertical budget on the fixed 1080 screen:
        //   [0..160]    header — brand + accent bar, BACK pill top-right;
        //   [160..244]  search field (query display, Focusable);
        //   [268..560]  keyboard — 4 rows: three staggered QWERTY letter
        //               rows + a special row (DEL / SPACE / SEARCH);
        //   [588..622]  status line (hint / searching / count / empty);
        //   [636..1080] results grid viewport — vertical ScrollView, 6
        //               poster cards per row, focus-driven keep-in-view
        //               scrolling.

        /// <summary>Search field (query display) width — full rail width.</summary>
        public const int SearchFieldWidth = RailViewportWidth;

        public const int SearchFieldY = 160;
        public const int SearchFieldHeight = 84;

        /// <summary>Placeholder shown while the query is empty.</summary>
        public const string SearchFieldPlaceholder = "Search movies, series and anime...";

        /// <summary>Search query cap — mirrors the server's INVALID_QUERY limit (120 chars).</summary>
        public const int SearchQueryMaxChars = 120;

        /// <summary>Top y of the keyboard block (first letter row).</summary>
        public const int KeyboardTopY = 268;

        // Keyboard grid: uniform letter keys on staggered QWERTY rows.
        public const int KeyWidth = 112;
        public const int KeyHeight = 64;
        public const int KeyGap = 12;

        /// <summary>Vertical pitch of the keyboard rows (key height + gap).</summary>
        public const int KeyRowPitch = KeyHeight + KeyGap;

        /// <summary>x of row 0 (QWERTYUIOP, 10 keys) — the row is centered.</summary>
        public const int KeyRow0X = (ScreenWidth - (10 * KeyWidth + 9 * KeyGap)) / 2;

        /// <summary>x of row 1 (ASDFGHJKL, 9 keys) — staggered half a key.</summary>
        public const int KeyRow1X = KeyRow0X + (KeyWidth + KeyGap) / 2;

        /// <summary>x of row 2 (ZXCVBNM, 7 keys) — staggered a full key.</summary>
        public const int KeyRow2X = KeyRow0X + (KeyWidth + KeyGap);

        // Special row (DEL / SPACE / SEARCH), wider keys, 16px gaps, centered.
        public const int KeySpecialGap = 16;
        public const int DelKeyWidth = 240;
        public const int SpaceKeyWidth = 460;
        public const int SearchKeyWidth = 320;

        /// <summary>x of the special row — centered on the screen.</summary>
        public const int KeySpecialRowX = (ScreenWidth -
            (DelKeyWidth + SpaceKeyWidth + SearchKeyWidth + 2 * KeySpecialGap)) / 2;

        public const int KeyboardLetterPointSize = 24;
        public const int KeyboardSpecialPointSize = 17;

        public const int SearchStatusY = 588;
        public const int SearchStatusHeight = 34;

        /// <summary>Top of the results grid viewport (status line sits above).</summary>
        public const int ResultsViewportY = 636;

        /// <summary>Height of the results grid viewport (runs to the screen bottom).</summary>
        public const int ResultsViewportHeight = ScreenHeight - ResultsViewportY;

        // Results grid: poster cards in a 6-column layout, one vertical
        // scroller hosting every row (rows are aligned, no horizontal scroll).
        public const int GridColumns = 6;

        /// <summary>Horizontal pitch of grid columns (card width + gap).</summary>
        public const int GridCellWidth = CardWidth + CardGap;

        /// <summary>Vertical pitch of grid rows (card height + breathing room
        /// for the 1.05 focus scale).</summary>
        public const int GridRowPitch = CardHeight + 40;

        /// <summary>Width the grid rows occupy (6 cards, 5 gaps).</summary>
        public const int GridViewportWidth = GridColumns * GridCellWidth - CardGap;

        /// <summary>x of the grid viewport — centered on the screen.</summary>
        public const int GridX = (ScreenWidth - GridViewportWidth) / 2;

        // ---- Home header search entry ----

        public const int HeaderSearchButtonWidth = 150;
        public const int HeaderSearchButtonHeight = 56;

        /// <summary>x of the header SEARCH pill (top-right corner).</summary>
        public const int HeaderSearchButtonX = ScreenWidth - PageMargin - HeaderSearchButtonWidth;

        /// <summary>y of the header SEARCH pill (center-aligned with the brand).</summary>
        public const int HeaderSearchButtonY = 56;

        // ---- Player popups (server / source selectors) ----

        public const int PopupWidth = 640;
        public const int PopupPadding = 24;
        public const int PopupTitleHeight = 48;
        public const int PopupTitleGap = 20;
        public const int PopupTitlePointSize = 20;
        public const int PopupRowWidth = 592;
        public const int PopupRowHeight = 72;
        public const int PopupRowGap = 12;

        /// <summary>Rows are laid out unscrolled — hard cap keeps the panel on screen.</summary>
        public const int PopupMaxRows = 10;

        /// <summary>Alpha of the full-screen scrim behind a popup.</summary>
        public const float PopupScrimAlpha = 0.72f;

        // ---- Packed assets (Content items in MaveroTv.csproj) ----

        public const string CardBgAsset = "card-bg.png";
        public const string CardFocusAsset = "card-focus.png";
        public const string PosterMaskAsset = "poster-mask.png";
        public const string EpisodeMaskAsset = "episode-mask.png";
        public const string ScrimAsset = "scrim.png";
        public const string HeroScrimAsset = "hero-scrim.png";
        public const string ButtonIdleAsset = "button-idle.png";
        public const string ButtonActiveAsset = "button-active.png";

        // ---- Pivots ----

        /// <summary>Pivot at the view's own top-left (standard HomePage positioning).</summary>
        public static readonly Position TopLeftPivot = Tizen.NUI.PivotPoint.TopLeft;

        /// <summary>Pivot at the view's center (cards scale around their center on focus).</summary>
        public static readonly Position CenterPivot = Tizen.NUI.PivotPoint.Center;

        /// <summary>Converts a 0xRRGGBB web-app hex value into a NUI color.</summary>
        public static Color Hex(int value)
        {
            float r = ((value >> 16) & 0xFF) / 255f;
            float g = ((value >> 8) & 0xFF) / 255f;
            float b = (value & 0xFF) / 255f;
            return new Color(r, g, b, 1f);
        }
    }
}
