// ============================================================
// Mavero TV — sign-in screen via device pairing (Tizen.NUI, API 6).
//
// TV remotes have no keyboard and nobody wants to type an email +
// password with a D-pad, so the sign-in flow uses the backend's
// DEVICE PAIRING mechanism (the exact flow the web app's own TV
// login uses, apps/web/src/routes/tv-login):
//
//   1. TV  POST /api/auth/device-pairing/create
//          -> { secret, shortCode (8 chars), expiresAt (5 min TTL) }
//   2. TV shows the code big on screen + where to enter it
//          (maveroweb.space/settings/scan-tv — the phone page that
//          also scans the QR variant of this flow);
//   3. TV polls POST .../status { secret } every 3s (the
//          pairingPoll rate limit allows 60/min) with a generation
//          counter fencing stale loops against newer attempts;
//   4. the phone approves (the phone must be signed in — it resolves
//          the code into a one-time handle and approves there);
//   5. status flips to "approved" -> TV calls POST .../exchange
//          { secret }; the response establishes the session as
//          Supabase auth COOKIES (captured into AuthSession and
//          persisted — never a bearer token in any body);
//   6. transient exchange failures (retryable:true) are retried with
//          the SAME secret up to 3 times (the backend releases the
//          pairing back to "approved" on a failed claim);
//   7. success -> SignedInCompleted fires; App.cs closes this page
//          and lands on My List.
//
// Page states (Focusable set is rewired per state):
//   Intro     — guest landing: PAIR DEVICE (primary CTA) +
//               CONTINUE AS GUEST; Up from PAIR reaches BACK.
//   Creating  — "Creating a pairing code..." (BACK only).
//   Pairing   — instructions + the URL + the giant code + live
//               status/countdown; focus rests on BACK so the page
//               is always escapable.
//   Exchanging— "Signing you in..." (BACK only).
//   Failed / Expired — honest message + TRY AGAIN (regenerates the
//               pairing) + CONTINUE AS GUEST.
//   SignedIn  — "Signed in as {email}": OPEN MY LIST (primary) +
//               SIGN OUT (secondary; POST /auth/sign-out revokes the
//               server session and resets the local jar).
//
// Threading: every fetch completes on the thread pool; state changes
// are marshaled through UiDispatcher (DALi views are only touched on
// the UI thread). MarkClosing() fences all pending continuations
// against a page the user already backed out of. The countdown loop
// (1s) and the poll loop (3s) share one generation counter.
// ============================================================
using System;
using System.Globalization;
using System.Threading.Tasks;
using Tizen;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>Sign-in screen: device-pairing login + guest escape hatch.</summary>
    public class LoginPage : View
    {
        /// <summary>Page states — the focusable set is rewired on every change.</summary>
        private enum LoginState
        {
            Intro,
            SignedIn,
            Creating,
            Pairing,
            Exchanging,
            Failed,
            Expired
        }

        private const string AuthorizePath = "maveroweb.space/settings/scan-tv";

        private readonly ApiService _api = new ApiService();

        private LoginState _state = LoginState.Intro;
        private bool _closed;

        /// <summary>Fences stale poll/countdown/exchange continuations against
        /// a newer pairing attempt (or a closed page).</summary>
        private int _generation;

        private PairingInfo _pairing;
        private DateTime _expiresAtUtc = DateTime.MinValue;

        // ---- chrome --------------------------------------------------------

        private FocusButton _backButton;
        private TextLabel _title;
        private TextLabel _captionLine1;
        private TextLabel _captionLine2;
        private TextLabel _urlLine;
        private TextLabel _codeLabel;
        private TextLabel _code;
        private TextLabel _status;

        private FocusButton _pairButton;      // primary (PAIR DEVICE / TRY AGAIN)
        private FocusButton _secondaryButton; // secondary (CONTINUE AS GUEST / SIGN OUT)

        /// <summary>Raised when the user leaves the page (BACK pill, guest
        /// continue, or the hardware Back key).</summary>
        public event Action CloseRequested;

        /// <summary>Raised once the pairing exchange established the session —
        /// App.cs closes this page and lands on My List.</summary>
        public event Action SignedInCompleted;

        /// <summary>Raised when the user asks for My List from the
        /// already-signed-in state (OPEN MY LIST).</summary>
        public event Action OpenMyListRequested;

        public LoginPage()
        {
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Theme.Background;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            Add(CreateHeader());
            CreateCenterChrome();
            CreateButtons();

            UiDispatcher.Start(); // idempotent; pumps the auth state binds
            ShowIntroOrSignedIn();
        }

        /// <summary>Lands focus on the state's primary action (PAIR DEVICE /
        /// TRY AGAIN / OPEN MY LIST), or BACK while a pairing is in flight.</summary>
        public void SetInitialFocus()
        {
            FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
        }

        /// <summary>Fences in-flight continuations before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        // ---- chrome construction ---------------------------------------------

        /// <summary>Home-style header: brand + accent bar, BACK pill top-right.</summary>
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

            View accentBar = new View
            {
                Position2D = new Position2D(Theme.PageMargin, 128),
                Size2D = new Size2D(96, 6),
                BackgroundColor = Theme.Accent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _backButton = new FocusButton("BACK", Theme.BackButtonWidth, Theme.BackButtonHeight, false)
            {
                Position2D = new Position2D(
                    Theme.SearchBackButtonX + Theme.BackButtonWidth / 2,
                    Theme.BackButtonY + Theme.BackButtonHeight / 2)
            };
            _backButton.Selected += OnBackSelected;

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
            header.Add(_backButton);
            return header;
        }

        /// <summary>The center chrome: title, caption lines, pairing URL +
        /// code blocks, live status. All full-width center-aligned.</summary>
        private void CreateCenterChrome()
        {
            _title = new TextLabel
            {
                Text = "SIGN IN",
                TextColor = Theme.TextPrimary,
                PointSize = Theme.LoginTitlePointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginTitleY),
                Size2D = new Size2D(Theme.ScreenWidth, 80),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _captionLine1 = new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.LoginCaptionPointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginCaptionY),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.LoginCaptionLineHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _captionLine2 = new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.LoginCaptionPointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginCaptionY + Theme.LoginCaptionLineHeight),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.LoginCaptionLineHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _urlLine = new TextLabel
            {
                Text = AuthorizePath,
                TextColor = Theme.Accent,
                PointSize = Theme.LoginUrlPointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginUrlY),
                Size2D = new Size2D(Theme.ScreenWidth, 72),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _codeLabel = new TextLabel
            {
                Text = "Then enter this code",
                TextColor = Theme.TextSecondary,
                PointSize = Theme.LoginCaptionPointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginCodeLabelY),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.LoginCaptionLineHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _code = new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextPrimary,
                PointSize = Theme.LoginCodePointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginCodeY),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.LoginCodeHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            _status = new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.LoginStatusPointSize,
                HorizontalAlignment = HorizontalAlignment.Center,
                Position2D = new Position2D(0, Theme.LoginStatusY),
                Size2D = new Size2D(Theme.ScreenWidth, 44),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            Add(_title);
            Add(_captionLine1);
            Add(_captionLine2);
            Add(_urlLine);
            Add(_codeLabel);
            Add(_code);
            Add(_status);
        }

        /// <summary>The two action buttons (labels change per state).</summary>
        private void CreateButtons()
        {
            _pairButton = new FocusButton("PAIR DEVICE", Theme.LoginPairButtonWidth,
                Theme.LoginPairButtonHeight, true)
            {
                // Center pivot: Position2D measures to the button's own center.
                Position2D = new Position2D(
                    Theme.ScreenWidth / 2,
                    Theme.LoginPairButtonY + Theme.LoginPairButtonHeight / 2)
            };
            _pairButton.Selected += OnPrimarySelected;

            _secondaryButton = new FocusButton("CONTINUE AS GUEST", Theme.LoginGuestButtonWidth,
                Theme.LoginGuestButtonHeight, false)
            {
                Position2D = new Position2D(
                    Theme.ScreenWidth / 2,
                    Theme.LoginGuestButtonY + Theme.LoginGuestButtonHeight / 2)
            };
            _secondaryButton.Selected += OnSecondarySelected;

            Add(_pairButton);
            Add(_secondaryButton);
        }

        // ---- state machine -----------------------------------------------------

        /// <summary>Landing state: signed-in users get the account actions,
        /// guests get the pairing pitch.</summary>
        private void ShowIntroOrSignedIn()
        {
            if (AuthSession.IsSignedIn)
            {
                SetState(LoginState.SignedIn);
            }
            else
            {
                SetState(LoginState.Intro);
            }
        }

        private void SetState(LoginState state)
        {
            _state = state;
            ApplyState();
            WireFocus();
        }

        /// <summary>Per-state chrome: which blocks are visible and what they say.</summary>
        private void ApplyState()
        {
            switch (_state)
            {
                case LoginState.Intro:
                    _title.Text = "SIGN IN";
                    _captionLine1.Text = "Pair this TV with your Mavero account";
                    _captionLine2.Text = "to sync My List across your devices";
                    _pairButton.SetLabel("PAIR DEVICE");
                    _secondaryButton.SetLabel("CONTINUE AS GUEST");
                    _status.Text = "No account? Press CONTINUE AS GUEST - the catalog works without one";
                    ShowCenterBlocks(captions: true, buttons: true);
                    break;

                case LoginState.SignedIn:
                    _title.Text = "MY ACCOUNT";
                    _captionLine1.Text = "Signed in as " +
                        (string.IsNullOrEmpty(AuthSession.UserEmail) ? "your account" : AuthSession.UserEmail);
                    _captionLine2.Text = "My List syncs with every device on this account";
                    _pairButton.SetLabel("OPEN MY LIST");
                    _secondaryButton.SetLabel("SIGN OUT");
                    _status.Text = string.Empty;
                    ShowCenterBlocks(captions: true, buttons: true);
                    break;

                case LoginState.Creating:
                    _title.Text = "SIGN IN";
                    _captionLine1.Text = string.Empty;
                    _captionLine2.Text = string.Empty;
                    _status.Text = "Creating a pairing code...";
                    ShowCenterBlocks(captions: false, buttons: false);
                    break;

                case LoginState.Pairing:
                    _title.Text = "PAIR YOUR DEVICE";
                    _captionLine1.Text = "On your phone or computer, open";
                    _captionLine2.Text = string.Empty;
                    _codeLabel.Text = "Sign in, then enter this code";
                    _pairButton.SetLabel("TRY AGAIN");
                    _secondaryButton.SetLabel("CONTINUE AS GUEST");
                    _status.Text = "Waiting for approval...";
                    ShowCenterBlocks(captions: true, buttons: false, pairingBlocks: true);
                    break;

                case LoginState.Exchanging:
                    _title.Text = "PAIR YOUR DEVICE";
                    _captionLine1.Text = "On your phone or computer, open";
                    _captionLine2.Text = string.Empty;
                    _codeLabel.Text = "Sign in, then enter this code";
                    _status.Text = "Approved - signing you in...";
                    ShowCenterBlocks(captions: true, buttons: false, pairingBlocks: true);
                    break;

                case LoginState.Failed:
                    _title.Text = "PAIRING FAILED";
                    _captionLine1.Text = string.Empty;
                    _captionLine2.Text = string.Empty;
                    _pairButton.SetLabel("TRY AGAIN");
                    _secondaryButton.SetLabel("CONTINUE AS GUEST");
                    ShowCenterBlocks(captions: false, buttons: true);
                    break;

                case LoginState.Expired:
                    _title.Text = "CODE EXPIRED";
                    _captionLine1.Text = "Pairing codes stay valid for 5 minutes";
                    _captionLine2.Text = string.Empty;
                    _pairButton.SetLabel("TRY AGAIN");
                    _secondaryButton.SetLabel("CONTINUE AS GUEST");
                    ShowCenterBlocks(captions: true, buttons: true);
                    break;
            }
        }

        /// <summary>Shows/hides the center chrome blocks per state.</summary>
        private void ShowCenterBlocks(bool captions, bool buttons, bool pairingBlocks = false)
        {
            ShowOrHide(_captionLine1, captions && !string.IsNullOrEmpty(_captionLine1.Text));
            ShowOrHide(_captionLine2, captions && !string.IsNullOrEmpty(_captionLine2.Text));
            ShowOrHide(_urlLine, pairingBlocks);
            ShowOrHide(_codeLabel, pairingBlocks);
            ShowOrHide(_code, pairingBlocks && !string.IsNullOrEmpty(_code.Text));
            ShowOrHide(_pairButton, buttons);
            ShowOrHide(_secondaryButton, buttons);
        }

        private static void ShowOrHide(View view, bool visible)
        {
            if (view == null)
            {
                return;
            }

            if (visible)
            {
                view.Show();
            }
            else
            {
                view.Hide();
            }
        }

        /// <summary>Per-state focus wiring — vertical chains: BACK above,
        /// primary CTA, secondary underneath. Every link is explicit.</summary>
        private void WireFocus()
        {
            // Clear stale links first — hidden buttons must never receive focus.
            _backButton.DownFocusableView = null;
            _pairButton.UpFocusableView = null;
            _pairButton.DownFocusableView = null;
            _secondaryButton.UpFocusableView = null;
            _secondaryButton.DownFocusableView = null;

            if (_state == LoginState.Pairing || _state == LoginState.Exchanging
                || _state == LoginState.Creating)
            {
                // Only BACK is focusable while a pairing is in flight.
                _backButton.DownFocusableView = null;
                return;
            }

            _backButton.DownFocusableView = _pairButton;
            _pairButton.UpFocusableView = _backButton;
            _pairButton.DownFocusableView = _secondaryButton;
            _secondaryButton.UpFocusableView = _pairButton;
        }

        /// <summary>The state's deterministic landing spot.</summary>
        private View FocusTargetFor(LoginState state)
        {
            switch (state)
            {
                case LoginState.Pairing:
                case LoginState.Exchanging:
                case LoginState.Creating:
                    return _backButton;
                case LoginState.SignedIn:
                case LoginState.Intro:
                case LoginState.Failed:
                case LoginState.Expired:
                default:
                    return _pairButton;
            }
        }

        // ---- actions -----------------------------------------------------------

        private void OnBackSelected()
        {
            Log.Info(MaveroApp.LogTag, "Back button pressed on login — returning home");
            CloseRequested?.Invoke();
        }

        private void OnPrimarySelected()
        {
            switch (_state)
            {
                case LoginState.Intro:
                    StartPairing();
                    break;
                case LoginState.SignedIn:
                    Log.Info(MaveroApp.LogTag, "OPEN MY LIST pressed on login — handing off");
                    OpenMyListRequested?.Invoke();
                    break;
                case LoginState.Failed:
                case LoginState.Expired:
                    StartPairing();
                    break;
            }
        }

        private void OnSecondarySelected()
        {
            if (_state == LoginState.SignedIn)
            {
                _ = SignOutAsync();
                return;
            }

            // Intro / Failed / Expired: leave as a guest.
            Log.Info(MaveroApp.LogTag, "Guest continue pressed on login — returning home");
            CloseRequested?.Invoke();
        }

        /// <summary>Generates a fresh pairing challenge and starts polling.</summary>
        private void StartPairing()
        {
            int generation = ++_generation;
            SetState(LoginState.Creating);
            FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
            Log.Info(MaveroApp.LogTag, "Pairing requested (generation " + generation + ")");
            _ = CreatePairingAsync(generation);
        }

        private async Task CreatePairingAsync(int generation)
        {
            try
            {
                PairingInfo pairing = await _api.CreatePairingAsync();
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _generation)
                    {
                        return;
                    }

                    if (pairing == null)
                    {
                        _status.Text = "Pairing service unavailable - please try again";
                        SetState(LoginState.Failed);
                        FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
                        return;
                    }

                    _pairing = pairing;
                    _expiresAtUtc = ParseExpiresAt(pairing.ExpiresAt);
                    _code.Text = FormatShortCode(pairing.ShortCode);
                    SetState(LoginState.Pairing);
                    FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));

                    _ = CountdownLoopAsync(generation);
                    _ = PollLoopAsync(generation);
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, "Pairing create failed: " + ex.Message);
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _generation)
                    {
                        return;
                    }
                    _status.Text = "Pairing service unavailable - please try again";
                    SetState(LoginState.Failed);
                    FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
                });
            }
        }

        /// <summary>3-second status poll — pending keeps waiting, approved
        /// starts the exchange, terminal statuses end the pairing. The loop
        /// itself runs on the thread pool; every decision is applied on the
        /// UI thread through UiDispatcher.</summary>
        private async Task PollLoopAsync(int generation)
        {
            int consecutiveErrors = 0;
            while (true)
            {
                await Task.Delay(Theme.PairingPollIntervalMs);
                if (_closed || generation != _generation || _state != LoginState.Pairing)
                {
                    return;
                }

                string status = await _api.PollPairingStatusAsync(_pairing.Secret);
                if (_closed || generation != _generation || _state != LoginState.Pairing)
                {
                    return;
                }

                if (status == null)
                {
                    consecutiveErrors++;
                    Log.Warn(MaveroApp.LogTag, "Pairing poll error streak: " + consecutiveErrors);
                    if (consecutiveErrors > 5)
                    {
                        Fail("Connection lost - please try again");
                        return;
                    }
                    continue;
                }

                consecutiveErrors = 0;

                switch (status)
                {
                    case "approved":
                        // Hand the state flip to the UI thread; the exchange
                        // loop starts from there too.
                        UiDispatcher.Post(() =>
                        {
                            if (_closed || generation != _generation || _state != LoginState.Pairing)
                            {
                                return;
                            }
                            StartExchange(generation);
                        });
                        return;
                    case "expired":
                        UiDispatcher.Post(() =>
                        {
                            if (_closed || generation != _generation || _state != LoginState.Pairing)
                            {
                                return;
                            }
                            SetState(LoginState.Expired);
                            _status.Text = "The code expired - generate a new one";
                            FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
                        });
                        return;
                    case "cancelled":
                        Fail("The authorization was cancelled on your phone");
                        return;
                    case "failed":
                        Fail("Pairing failed - please try again");
                        return;
                    case "consumed":
                        Fail("This code was already used - please try again");
                        return;
                    default:
                        break; // pending — keep waiting
                }
            }
        }

        /// <summary>1-second countdown tick while the pairing waits (status
        /// line updates are marshaled to the UI thread).</summary>
        private async Task CountdownLoopAsync(int generation)
        {
            while (true)
            {
                await Task.Delay(1000);
                if (_closed || generation != _generation || _state != LoginState.Pairing)
                {
                    return;
                }

                int remainingSeconds = (int)(_expiresAtUtc - DateTime.UtcNow).TotalSeconds;
                if (remainingSeconds <= 0)
                {
                    UiDispatcher.Post(() =>
                    {
                        if (_closed || generation != _generation || _state != LoginState.Pairing)
                        {
                            return;
                        }
                        SetState(LoginState.Expired);
                        _status.Text = "The code expired - generate a new one";
                        FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
                    });
                    return;
                }

                string countdownLine = "Waiting for approval - expires in " + FormatCountdown(remainingSeconds);
                UiDispatcher.Post(() =>
                {
                    if (_closed || generation != _generation || _state != LoginState.Pairing)
                    {
                        return;
                    }
                    _status.Text = countdownLine;
                });
            }
        }

        /// <summary>UI-thread entry into the exchange phase (the poll loop
        /// hands off here once the phone approves).</summary>
        private void StartExchange(int generation)
        {
            SetState(LoginState.Exchanging);
            _status.Text = "Approved - signing you in...";
            Log.Info(MaveroApp.LogTag, "Pairing approved — exchanging (generation " + generation + ")");
            _ = ExchangeLoopAsync(generation);
        }

        /// <summary>Approved -> exchange, retrying transient failures with the
        /// same secret (the backend releases the pairing back to "approved").
        /// Runs on the thread pool; every UI mutation is marshaled.</summary>
        private async Task ExchangeLoopAsync(int generation)
        {
            for (int attempt = 1; attempt <= Theme.ExchangeMaxRetries; attempt++)
            {
                if (_closed || generation != _generation)
                {
                    return;
                }

                if (attempt > 1)
                {
                    string retryLine = "Signing in (attempt " + attempt + " of " +
                        Theme.ExchangeMaxRetries + ")...";
                    UiDispatcher.Post(() =>
                    {
                        if (_closed || generation != _generation)
                        {
                            return;
                        }
                        _status.Text = retryLine;
                    });
                    await Task.Delay(Theme.ExchangeRetryDelayMs);
                    if (_closed || generation != _generation)
                    {
                        return;
                    }
                }

                ExchangeOutcome outcome = await _api.ExchangePairingAsync(_pairing.Secret);
                if (_closed || generation != _generation)
                {
                    return;
                }

                if (outcome != null && outcome.Ok)
                {
                    // Hand off on the UI thread — the handler closes this page
                    // (DALi teardown) and opens My List.
                    UiDispatcher.Post(() =>
                    {
                        if (_closed || generation != _generation)
                        {
                            return;
                        }
                        Log.Info(MaveroApp.LogTag, "Pairing complete — signed in as " +
                            (AuthSession.UserEmail ?? "unknown") + " — handing off to My List");
                        SignedInCompleted?.Invoke();
                    });
                    return;
                }

                if (outcome != null && outcome.Retryable && attempt < Theme.ExchangeMaxRetries)
                {
                    continue;
                }

                Fail(outcome != null && !string.IsNullOrEmpty(outcome.Message)
                    ? outcome.Message
                    : "Could not establish the session - please try again");
                return;
            }

            Fail("Could not sign in after several attempts - please try again");
        }

        private async Task SignOutAsync()
        {
            Log.Info(MaveroApp.LogTag, "Sign out requested on login page");
            _status.Text = "Signing out...";
            _secondaryButton.Focusable = false;

            try
            {
                await _api.SignOutAsync();
            }
            catch (Exception ex)
            {
                // SignOutAsync clears the jar regardless; never strand the UI.
                Log.Warn(MaveroApp.LogTag, "Sign out failed: " + ex.Message);
            }

            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                _secondaryButton.Focusable = true;
                ShowIntroOrSignedIn();
                FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
            });
        }

        /// <summary>Terminal pairing failure — the state flip lands on the UI
        /// thread (callers may run on the poll/exchange thread pool).</summary>
        private void Fail(string message)
        {
            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                SetState(LoginState.Failed);
                _status.Text = message;
                FocusManager.Instance.SetCurrentFocusView(FocusTargetFor(_state));
            });
        }

        // ---- helpers -----------------------------------------------------------

        /// <summary>Parses the ISO expiresAt into UTC; a parse failure yields
        /// MinValue, and the countdown loop then expires immediately.</summary>
        private static DateTime ParseExpiresAt(string iso)
        {
            DateTime parsed;
            if (!string.IsNullOrEmpty(iso) && DateTime.TryParse(iso, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed))
            {
                return parsed.ToUniversalTime();
            }
            return DateTime.MinValue;
        }

        /// <summary>"DH84EXKP" -> "DH84 EXKP" (the phone side strips whitespace,
        /// so the display gap is safe); shorter codes pass through untouched.</summary>
        private static string FormatShortCode(string code)
        {
            if (string.IsNullOrEmpty(code))
            {
                return string.Empty;
            }
            return code.Length == 8
                ? code.Substring(0, 4) + " " + code.Substring(4)
                : code;
        }

        /// <summary>Seconds -> "m:ss".</summary>
        private static string FormatCountdown(int totalSeconds)
        {
            int minutes = totalSeconds / 60;
            int seconds = totalSeconds % 60;
            return minutes + ":" + seconds.ToString("00", CultureInfo.InvariantCulture);
        }
    }
}
