// ============================================================
// Mavero TV — a focusable pill button for the detail page.
//
// Two visual tiers share one control (single focus language with
// MediaCard: EaseOut scale-up on gain, restore on loss):
//   - primary CTA (Play): idle = dark 9-patch surface + white text;
//     focused = cyan 9-patch surface + dark text (the cyan fill IS
//     the focus feedback);
//   - secondary (Back): idle = same dark surface; focused = cyan
//     ring 9-patch overlay + scale (matches the MediaCard ring).
//
// Focus engine integration (verified against the TizenFX 6.0.0.14995
// reference assemblies):
//   - Focusable = true; DetailPage wires Up/DownFocusableView links
//     between the page's buttons, FocusManager does the rest;
//   - KeyEvent is subscribed ONLY for Enter/OK: returning true
//     consumes it. Arrow keys fall through to FocusManager's
//     built-in navigation (same contract as MediaCard).
// ============================================================
using System;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>One selectable button (Play, Back, ...) on the detail page.</summary>
    public class FocusButton : View
    {
        /// <summary>Enter key names the OK button reports as on Tizen remotes.</summary>
        private static readonly string[] EnterKeyNames = { "Return", "Enter", "Select" };

        private readonly bool _primaryCta;
        private readonly TextLabel _label;
        private readonly View _focusRing;
        private readonly int _width;
        private readonly int _height;
        private Animation _focusAnim;

        /// <summary>Raised when the user presses Enter/OK while the button is focused.</summary>
        public event Action Selected;

        public FocusButton(string label, int width, int height, bool primaryCta)
        {
            _primaryCta = primaryCta;
            _width = width;
            _height = height;

            // Center pivot: Position2D measures to the button's own center,
            // so the focus scale grows symmetrically in place.
            Size2D = new Size2D(width, height);
            PivotPoint = Theme.CenterPivot;
            PositionUsesPivotPoint = true;
            Focusable = true;
            Background = IdleSurface();

            _label = new TextLabel
            {
                Text = label,
                TextColor = Theme.TextPrimary,
                PointSize = Theme.CardTitlePointSize + 4,
                Ellipsis = true,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalLineAlignment = VerticalLineAlignment.Center,
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(width, height),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
            Add(_label);

            if (!_primaryCta)
            {
                // Secondary tier: cyan ring overlay (hidden until focused).
                _focusRing = CreateRing();
                _focusRing.Hide();
                Add(_focusRing);
            }

            FocusGained += OnFocusGained;
            FocusLost += OnFocusLost;
            KeyEvent += OnButtonKeyEvent;
        }

        // ---- label updates --------------------------------------------------

        /// <summary>Re-labels the button (Play/Pause toggle, current server/source).</summary>
        public void SetLabel(string text)
        {
            _label.Text = text ?? string.Empty;
        }

        // ---- surfaces -------------------------------------------------------

        /// <summary>Dark rounded 9-patch surface (idle for both tiers).</summary>
        private static PropertyMap IdleSurface()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.ButtonIdleAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.ButtonPatchBorder, Theme.ButtonPatchBorder, Theme.ButtonPatchBorder, Theme.ButtonPatchBorder)));
            return map;
        }

        /// <summary>Cyan rounded 9-patch surface (focused primary CTA).</summary>
        private static PropertyMap ActiveSurface()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.ButtonActiveAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.ButtonPatchBorder, Theme.ButtonPatchBorder, Theme.ButtonPatchBorder, Theme.ButtonPatchBorder)));
            return map;
        }

        /// <summary>Cyan focus ring, same asset as MediaCard (9-patch corners).</summary>
        private static View CreateRing()
        {
            PropertyMap map = new PropertyMap();
            map.Insert(Visual.Property.Type, new PropertyValue((int)Visual.Type.Image));
            map.Insert(ImageVisualProperty.URL, new PropertyValue(Theme.CardFocusAsset));
            map.Insert(ImageVisualProperty.Border, new PropertyValue(new Vector4(
                Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder, Theme.FocusPatchBorder)));

            return new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(0, 0), // matched to the button on focus
                Background = map,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        // ---- focus behaviour ------------------------------------------------

        private void OnFocusGained(object source, EventArgs e)
        {
            RaiseToTop();

            if (_primaryCta)
            {
                Background = ActiveSurface();
                _label.TextColor = Theme.Background; // dark text on cyan
            }
            else
            {
                _focusRing.Size2D = new Size2D(_width, _height);
                _focusRing.Show();
            }

            PlayScaleAnimation(Theme.FocusScale);
        }

        private void OnFocusLost(object source, EventArgs e)
        {
            if (_primaryCta)
            {
                Background = IdleSurface();
                _label.TextColor = Theme.TextPrimary;
            }
            else
            {
                _focusRing.Hide();
            }

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
        private bool OnButtonKeyEvent(object source, View.KeyEventArgs e)
        {
            if (e.Key.State != Key.StateType.Up)
            {
                return false;
            }

            foreach (string name in EnterKeyNames)
            {
                if (e.Key.KeyPressedName == name)
                {
                    Selected?.Invoke();
                    return true;
                }
            }

            return false;
        }
    }
}
