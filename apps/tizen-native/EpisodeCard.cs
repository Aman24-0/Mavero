// ============================================================
// Mavero TV — a single episode card on the detail page's episode
// rail (Tizen.NUI, API 6).
//
// Visual layers (z bottom → top), mirroring MediaCard's language
// in 16:9 (the episode stills are TMDB w500 "still" art):
//   1. rounded #161616 card surface (card-bg.png 9-patch) — also
//      the loading/failed-still fallback surface;
//   2. full-bleed 356x200 still (ImageView, remote URL, corners
//      rounded via AlphaMaskURL = episode-mask.png, the 16:9 twin
//      of poster-mask.png with the same 12px radius);
//   3. episode number badge ("E1") top-left — cyan on a dark
//      translucent chip, readable over any artwork;
//   4. dark scrim over the still bottom (scrim.png 9-patch) so
//      the title stays readable;
//   5. title TextLabel over the scrim (ellipsis);
//   6. cyan focus ring (card-focus.png 9-patch), hidden until the
//      card gains DALi focus.
//
// Focus engine integration (same contract as MediaCard):
//   - Focusable = true; DetailPage wires Left/Right links along
//     the rail and the Up link back to the season row;
//   - FocusGained/FocusLost drive the scale-up (1.05, EaseOut)
//     and the cyan ring;
//   - KeyEvent is subscribed ONLY for Enter/OK: returning true
//     consumes it. Arrow keys fall through to the FocusManager's
//     built-in navigation — consuming them here risks double-moves.
// ============================================================
using System;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>One episode as a focusable 16:9 still card.</summary>
    public class EpisodeCard : View
    {
        /// <summary>Enter key names the OK button reports as on Tizen remotes.</summary>
        private static readonly string[] EnterKeyNames = { "Return", "Enter", "Select" };

        private readonly Episode _episode;
        private readonly View _focusFrame;
        private Animation _focusAnim;

        /// <summary>Raised when the user presses Enter/OK while the card is focused.</summary>
        public event Action<Episode> Selected;

        /// <summary>The bound episode record.</summary>
        public Episode Episode
        {
            get { return _episode; }
        }

        public EpisodeCard(Episode episode)
        {
            _episode = episode;

            Size2D = new Size2D(Theme.EpisodeCardWidth, Theme.EpisodeCardHeight);
            PivotPoint = Theme.CenterPivot;
            PositionUsesPivotPoint = true;
            Focusable = true;
            Background = RoundedCardSurface();

            Add(CreateStill());
            Add(CreateNumberBadge());
            Add(CreateScrim());
            Add(CreateTitle());

            _focusFrame = CreateFocusFrame();
            _focusFrame.Hide();
            Add(_focusFrame);

            FocusGained += OnFocusGained;
            FocusLost += OnFocusLost;
            KeyEvent += OnCardKeyEvent;
        }

        // ---- layers -------------------------------------------------------

        /// <summary>Rounded card surface; visible while the still loads (or fails).</summary>
        private static PropertyMap RoundedCardSurface()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.CardBgAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder)));
            return map;
        }

        private View CreateStill()
        {
            if (string.IsNullOrEmpty(_episode.Still))
            {
                // Honest placeholder for episodes without a still (unaired).
                return new View
                {
                    Position2D = new Position2D(0, 0),
                    Size2D = new Size2D(Theme.EpisodeCardWidth, Theme.EpisodeCardHeight),
                    BackgroundColor = Theme.SurfaceFocused,
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
            }

            // Full-bleed 16:9 still, corners rounded to the same 12px
            // radius as the poster cards via the 16:9 mask twin.
            return new ImageView
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.EpisodeCardWidth, Theme.EpisodeCardHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ResourceUrl = _episode.Still,
                AlphaMaskURL = Theme.EpisodeMaskAsset,
                FittingMode = FittingModeType.ScaleToFill,
                DesiredWidth = Theme.EpisodeCardWidth * 2,   // decode at 2x for crisp downscale
                DesiredHeight = Theme.EpisodeCardHeight * 2
            };
        }

        /// <summary>"E{n}" number chip top-left (dark translucent, cyan text).
        /// Width adapts to the digit count — long-running shows number
        /// episodes into the thousands (soap operas exceed E3000).</summary>
        private View CreateNumberBadge()
        {
            int digits = Math.Max(1, _episode.Number.ToString().Length);
            int badgeWidth = Math.Max(Theme.EpisodeBadgeWidth, 26 + (1 + digits) * 11);

            View badge = new View
            {
                Position2D = new Position2D(Theme.EpisodeBadgeInset, Theme.EpisodeBadgeInset),
                Size2D = new Size2D(badgeWidth, Theme.EpisodeBadgeHeight),
                BackgroundColor = new Color(0f, 0f, 0f, 0.72f),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            badge.Add(new TextLabel
            {
                Text = "E" + _episode.Number,
                TextColor = Theme.Accent,
                PointSize = 13,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalLineAlignment = VerticalLineAlignment.Center,
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(badgeWidth, Theme.EpisodeBadgeHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            });

            return badge;
        }

        /// <summary>Dark bottom scrim so the title stays readable over artwork.</summary>
        private View CreateScrim()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.ScrimAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.ScrimPatchBorderX, 0f, Theme.ScrimPatchBorderX, 0f)));

            return new View
            {
                Position2D = new Position2D(0, Theme.EpisodeCardHeight - Theme.EpisodeScrimHeight),
                Size2D = new Size2D(Theme.EpisodeCardWidth, Theme.EpisodeScrimHeight),
                Background = map,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateTitle()
        {
            return new TextLabel
            {
                Text = string.IsNullOrEmpty(_episode.Title)
                    ? "Episode " + _episode.Number
                    : _episode.Title,
                TextColor = Theme.TextPrimary,
                PointSize = 14,
                Ellipsis = true,
                VerticalLineAlignment = VerticalLineAlignment.Center,
                Position2D = new Position2D(14, Theme.EpisodeCardHeight - 52),
                Size2D = new Size2D(Theme.EpisodeCardWidth - 28, 40),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Cyan focus ring (9-patch, corners preserved), hidden until focused.</summary>
        private static View CreateFocusFrame()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.CardFocusAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder)));

            return new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.EpisodeCardWidth, Theme.EpisodeCardHeight),
                Background = map,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        // ---- focus behaviour ----------------------------------------------

        private void OnFocusGained(object source, EventArgs e)
        {
            RaiseToTop();
            _focusFrame.Show();
            PlayScaleAnimation(Theme.FocusScale);
        }

        private void OnFocusLost(object source, EventArgs e)
        {
            _focusFrame.Hide();
            PlayScaleAnimation(1f);
        }

        /// <summary>Smooth scale transition; the previous run is stopped first so
        /// rapid D-pad sweeps never stack conflicting animations.</summary>
        private void PlayScaleAnimation(float targetScale)
        {
            if (_focusAnim != null)
            {
                _focusAnim.Stop();
                _focusAnim.Dispose();
                _focusAnim = null;
            }

            _focusAnim = new Animation
            {
                Duration = Theme.FocusAnimMs
            };
            _focusAnim.AnimateTo(this, "Scale", new Vector3(targetScale, targetScale, 1f),
                new AlphaFunction(AlphaFunction.BuiltinFunctions.EaseOut));
            _focusAnim.Play();
        }

        /// <summary>Enter/OK select only — arrows intentionally fall through to the
        /// FocusManager's built-in D-pad navigation.</summary>
        private bool OnCardKeyEvent(object source, View.KeyEventArgs e)
        {
            if (e.Key.State != Key.StateType.Up)
            {
                return false;
            }

            foreach (string name in EnterKeyNames)
            {
                if (e.Key.KeyPressedName == name)
                {
                    Selected?.Invoke(_episode);
                    return true;
                }
            }

            return false;
        }
    }
}
