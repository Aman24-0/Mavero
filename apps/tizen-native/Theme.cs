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

        // ---- Packed assets (Content items in MaveroTv.csproj) ----

        public const string CardBgAsset = "card-bg.png";
        public const string CardFocusAsset = "card-focus.png";
        public const string PosterMaskAsset = "poster-mask.png";
        public const string ScrimAsset = "scrim.png";

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
