// ============================================================
// Mavero TV — a single poster card on a home rail.
//
// Visual layers (z bottom → top):
//   1. rounded #161616 card surface (card-bg.png 9-patch) — also
//      the loading/failed-poster fallback surface;
//   2. full-bleed 2:3 poster (ImageView, remote URL, rounded via
//      AlphaMaskURL so corners match the web app cards);
//   3. dark scrim over the poster bottom (scrim.png 9-patch) so
//      the title stays readable over any artwork;
//   4. title TextLabel over the scrim (ellipsis);
//   5. cyan focus ring (card-focus.png 9-patch), hidden until the
//      card gains DALi focus.
//
// Focus engine integration (verified against the TizenFX 6.0.0.14995
// reference assemblies):
//   - Focusable = true; FocusManager moves D-pad focus between cards
//     (Left/Right/Up/Down) and honours the Left/RightFocusableView
//     links HomePage wires along each rail;
//   - FocusGained/FocusLost drive the scale-up (1.05, EaseOut) and
//     the cyan ring;
//   - KeyEvent is subscribed ONLY for Enter/OK: returning true
//     consumes it. Arrow keys are left unconsumed on purpose so the
//     FocusManager's built-in keyboard navigation handles them (and
//     only them) — consuming them here risks double-moves.
// ============================================================
using System;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>One media title as a focusable poster card.</summary>
    public class MediaCard : View
    {
        /// <summary>Enter key names the OK button reports as on Tizen remotes.</summary>
        private static readonly string[] EnterKeyNames = { "Return", "Enter", "Select" };

        private readonly MediaItem _item;
        private readonly View _focusFrame;
        private Animation _focusAnim;

        /// <summary>Raised when the user presses Enter/OK while the card is focused.</summary>
        public event Action<MediaItem> Selected;

        /// <summary>The bound API item.</summary>
        public MediaItem Item
        {
            get { return _item; }
        }

        public MediaCard(MediaItem item)
        {
            _item = item;

            Size2D = new Size2D(Theme.CardWidth, Theme.CardHeight);
            PivotPoint = Theme.CenterPivot;
            PositionUsesPivotPoint = true;
            Focusable = true;
            Background = RoundedCardSurface();

            Add(CreatePoster());
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

        /// <summary>Rounded card surface; visible while the poster loads (or fails).</summary>
        private static PropertyMap RoundedCardSurface()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.AssetUrl(Theme.CardBgAsset)));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder, Theme.CardPatchBorder)));
            return map;
        }

        private View CreatePoster()
        {
            if (string.IsNullOrEmpty(_item.Poster))
            {
                // Honest placeholder for items without artwork.
                return new View
                {
                    Position2D = new Position2D(0, 0),
                    Size2D = new Size2D(Theme.CardWidth, Theme.CardHeight),
                    BackgroundColor = Theme.SurfaceFocused,
                    PivotPoint = Theme.TopLeftPivot,
                    PositionUsesPivotPoint = true
                };
            }

            // Full-bleed 2:3 poster (220x330 card). ScaleToFill crops the
            // rare off-ratio source; AlphaMaskURL rounds the corners to the
            // same 12px radius as the web app cards.
            return new ImageView
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.CardWidth, Theme.CardHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true,
                ResourceUrl = _item.Poster,
                AlphaMaskURL = Theme.AssetUrl(Theme.PosterMaskAsset),
                FittingMode = FittingModeType.ScaleToFill,
                DesiredWidth = Theme.CardWidth * 2,   // decode at 2x for crisp downscale
                DesiredHeight = Theme.CardHeight * 2
            };
        }

        /// <summary>Dark bottom scrim so the title stays readable over artwork.</summary>
        private View CreateScrim()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.AssetUrl(Theme.ScrimAsset)));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.ScrimPatchBorderX, 0f, Theme.ScrimPatchBorderX, 0f)));

            return new View
            {
                Position2D = new Position2D(0, Theme.CardHeight - Theme.CardScrimHeight),
                Size2D = new Size2D(Theme.CardWidth, Theme.CardScrimHeight),
                Background = map,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateTitle()
        {
            return new TextLabel
            {
                Text = _item.Title ?? string.Empty,
                TextColor = Theme.TextPrimary,
                PointSize = Theme.CardTitlePointSize,
                Ellipsis = true,
                VerticalLineAlignment = VerticalLineAlignment.Center,
                Position2D = new Position2D(Theme.CardTitleInset, Theme.CardHeight - 56),
                Size2D = new Size2D(Theme.CardWidth - Theme.CardTitleInset * 2, 36),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        /// <summary>Cyan focus ring (9-patch, corners preserved), hidden until focused.</summary>
        private static View CreateFocusFrame()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.AssetUrl(Theme.CardFocusAsset)));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder)));

            return new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.CardWidth, Theme.CardHeight),
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
        /// FocusManager's built-in D-pad navigation. The selection chain is
        /// guarded: any handler exception surfaces on the diagnostics panel
        /// instead of killing the process on real TV hardware.</summary>
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
                    try
                    {
                        Selected?.Invoke(_item);
                    }
                    catch (Exception ex)
                    {
                        Log.Error(MaveroApp.LogTag, "Card select failed: " + ex.Message);
                        Diagnostics.ReportNonFatal(ex, "open: " + (_item.Title ?? _item.Id));
                    }
                    return true;
                }
            }

            return false;
        }
    }
}
