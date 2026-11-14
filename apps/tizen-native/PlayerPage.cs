// ============================================================
// Mavero TV — native full-screen video player (Tizen.NUI + API 6).
//
// Video: Tizen.Multimedia.Player — the framework player that maps
// to hardware-accelerated AVPlay on TV. The display binds to the
// NUI window via Tizen.Multimedia.Display(Tizen.NUI.Window) (the
// API6-sanctioned bridge), which composites the video on the video
// layer BELOW the DALi surface. Consequences handled here:
//   - the page root is TRANSPARENT so the video shows through;
//   - App switches the window background to transparent while the
//     player page is up;
//   - an opaque black "curtain" view covers the page from open
//     until Start() — the screen looks black while resolving/
//     preparing, then the video appears.
//
// Streams (ApiService): GET /api/downloader/mavero resolves the
// Stremio addon groups for the title; GET /api/streaming/config
// lists the public servers, POST /api/playback/resolve resolves
// one. Priority order:
//   0. PRIORITY 1 — Stremio addon streams: direct MKV/HEVC files and
//      HLS manifests AVPlay plays NATIVELY (no embed guessing). The
//      best-quality stream starts immediately; the Source popup
//      lists the other addon streams ("Addon 4K HEVC", ...).
//      Fallback to the server pipeline happens when no addon stream
//      is playable AND when the chosen addon stream itself fails to
//      prepare — one graceful degradation, never a loop.
//   1. admin default source with allowFallback (server-side walk);
//   2. explicit walk over direct-capable servers;
//   3. first resolved embed url attempted (AVPlay rejects HTML
//      pages -> honest error status).
// Series/anime playback passes the picked Season/Episode numbers in
// every resolve body (PlaybackTarget from the detail page) so the
// backend resolves the exact episode; the addon endpoint derives
// the IMDb/TMDB ids server-side from the same catalog id.
//
// Overlay (D-pad):
//   - one top row: BACK / PAUSE / SERVER / SOURCE, FocusButtons
//     linked Left/Right (Up/Down clamp on the single row);
//   - BACK is focused whenever the overlay appears, so the user can
//     always exit;
//   - auto-hides after 3s of inactivity (NUI Timer), reappears on
//     any remote key: keys hit the window when nothing is focused
//     (overlay hidden) -> App forwards -> NotifyRemoteActivity;
//     arrows that move focus while visible are caught through the
//     FocusManager.FocusChanged signal (the built-in navigation
//     consumes arrows, so the window never sees them);
//   - SERVER/SOURCE open a StreamSelectorPopup; its rows are the
//     only focusable views while open (overlay is hidden), so
//     navigation cannot escape the popup.
//
// Status line: honest states only (Resolving / Buffering n% /
// Playback failed / finished / interrupted / no streams). It stays
// visible while the overlay is hidden.
//
// Threading: Player + DALi objects are touched on the UI thread;
// PrepareAsync continues on the thread pool and posts back through
// UiDispatcher; player events fire on native threads and are
// marshaled the same way. MarkClosing()/ShutdownPlayer() fence the
// queued work against a page the user already left.
//
// API 6 notes (verified against the TizenFX 6.0.0.14995 refs):
//   - Player is constructed parameterless; the display is assigned
//     via the Display property; there is NO Resume() — Start() from
//     Paused resumes;
//   - there is NO StateChanged event in API6 — state is read from
//     Player.State on demand; playback progress signals are
//     BufferingProgressChanged/PlaybackCompleted/
//     PlaybackInterrupted/ErrorOccurred.
// ============================================================
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Tizen;
using Tizen.Multimedia;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace MaveroTv
{
    /// <summary>Full-screen native video player with D-pad overlay.</summary>
    public class PlayerPage : View
    {
        /// <summary>Upper bound on resolve attempts during the direct-priority walk.</summary>
        private const int MaxResolveWalkAttempts = 3;

        private readonly MediaItem _item;
        private readonly ApiService _api = new ApiService();
        private readonly Window _window;
        private readonly int? _season;
        private readonly int? _episode;
        private readonly string _targetLabel;
        private bool _closed;

        private Player _player;
        private StreamingSourceList _serverList = new StreamingSourceList { Entries = new List<ServerEntry>() };
        private ResolvedSource _resolved;
        private string _activeUrl;
        private List<SourceOption> _sourceOptions;

        // ---- addon streams (PRIORITY 1 playback source) --------------------
        private List<AddonStream> _addonStreams;
        private AddonStream _activeAddonStream;

        private View _curtain;
        private View _overlay;
        private TextLabel _status;
        private FocusButton _backButton;
        private FocusButton _playPauseButton;
        private FocusButton _serverButton;
        private FocusButton _sourceButton;
        private StreamSelectorPopup _activePopup;
        private PopupKind _activePopupKind;
        private bool _overlayVisible = true;
        private Timer _hideTimer;

        /// <summary>Raised when the user wants to leave the player (Back key/button).</summary>
        public event Action CloseRequested;

        /// <summary>Which selector popup is currently open.</summary>
        private enum PopupKind
        {
            None,
            Server,
            Source
        }

        /// <summary>One selectable rendition of the active stream (Source popup row).</summary>
        private class SourceOption
        {
            public string Label;
            public string Url;

            /// <summary>Set when the row is an addon stream (the Source popup
            /// mixes nothing else in — but the select handler distinguishes
            /// addon rows from server renditions to keep the labels honest).</summary>
            public AddonStream AddonStream;
        }

        /// <param name="item">The title being played (carries id/type for resolution).</param>
        /// <param name="window">The NUI window — Player.Display binds to it.</param>
        /// <param name="target">Which episode to play for series/anime (null = movie).</param>
        public PlayerPage(MediaItem item, Window window, PlaybackTarget target = null)
        {
            _item = item;
            _window = window;
            _season = target?.Season;
            _episode = target?.Episode;
            _targetLabel = target?.Label;

            // Transparent root: the video layer below the DALi surface shows
            // through wherever nothing opaque is drawn (see header).
            Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight);
            BackgroundColor = Color.Transparent;
            PivotPoint = Theme.TopLeftPivot;
            PositionUsesPivotPoint = true;

            _curtain = CreateCurtain();
            Add(_curtain);
            _status = CreateStatus();
            Add(_status);
            _overlay = CreateOverlay();
            Add(_overlay);

            UiDispatcher.Start(); // idempotent; pumps player binds too

            _hideTimer = new Timer(Theme.OverlayHideMs);
            _hideTimer.Tick += OnHideTimerTick;

            FocusManager.Instance.FocusChanged += OnGlobalFocusChanged;

            SetStatus(_targetLabel != null ? $"Resolving {_targetLabel}..." : "Resolving addon streams...");
            Log.Info(MaveroApp.LogTag,
                "Player opened" +
                (_targetLabel != null ? $" for {_targetLabel}" : string.Empty) +
                $": '{_item.Title}' (id={_item.Id}, type={_item.Type})");
            _ = ResolveAndPlayAsync();
        }

        /// <summary>Lands focus on BACK once the page is on the window (always exitable).</summary>
        public void SetInitialFocus()
        {
            FocusManager.Instance.SetCurrentFocusView(_backButton);
        }

        /// <summary>Fences queued work before the page leaves the window.</summary>
        public void MarkClosing()
        {
            _closed = true;
        }

        /// <summary>Stops and releases the player + page-level timers/signals. Called by App.</summary>
        public void ShutdownPlayer()
        {
            DestroyPlayer();

            if (_hideTimer != null)
            {
                _hideTimer.Stop();
                _hideTimer.Dispose();
                _hideTimer = null;
            }

            FocusManager.Instance.FocusChanged -= OnGlobalFocusChanged;
            _overlayVisible = false;
        }

        /// <summary>Remote activity while the overlay is hidden (any non-Back key).</summary>
        public void NotifyRemoteActivity()
        {
            if (_closed || _activePopup != null)
            {
                return;
            }

            if (!_overlayVisible)
            {
                ShowOverlay();
            }
            else
            {
                ArmHideTimer();
            }
        }

        /// <summary>Back key routing: a popup is closed first; otherwise the player exits.</summary>
        public bool HandleBack()
        {
            if (_closed)
            {
                return false;
            }

            if (_activePopup != null)
            {
                ClosePopup();
                return true;
            }

            return false;
        }

        // ---- chrome -------------------------------------------------------

        /// <summary>Opaque black cover shown until playback starts (honest black boot).</summary>
        private static View CreateCurtain()
        {
            return new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight),
                BackgroundColor = Theme.Background,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private TextLabel CreateStatus()
        {
            return new TextLabel
            {
                Text = string.Empty,
                TextColor = Theme.TextSecondary,
                PointSize = Theme.PlayerStatusPointSize,
                Ellipsis = true,
                Position2D = new Position2D(Theme.PageMargin, Theme.PlayerStatusY),
                Size2D = new Size2D(Theme.ScreenWidth - Theme.PageMargin * 2, Theme.PlayerStatusHeight),
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };
        }

        private View CreateOverlay()
        {
            View overlay = new View
            {
                Position2D = new Position2D(0, 0),
                Size2D = new Size2D(Theme.ScreenWidth, Theme.ScreenHeight),
                BackgroundColor = Color.Transparent,
                PivotPoint = Theme.TopLeftPivot,
                PositionUsesPivotPoint = true
            };

            int x = Theme.PageMargin;
            _backButton = CreateOverlayButton("BACK", x, Theme.PlayerBackButtonWidth);
            x += Theme.PlayerBackButtonWidth + Theme.OverlayGap;
            _playPauseButton = CreateOverlayButton("PAUSE", x, Theme.PlayerPlayButtonWidth);
            x += Theme.PlayerPlayButtonWidth + Theme.OverlayGap;
            _serverButton = CreateOverlayButton("SERVER", x, Theme.PlayerServerButtonWidth);
            x += Theme.PlayerServerButtonWidth + Theme.OverlayGap;
            _sourceButton = CreateOverlayButton("AUTO", x, Theme.PlayerSourceButtonWidth);

            // Left/Right chain along the single row; Up/Down stay null so
            // navigation clamps at the row edges.
            _backButton.RightFocusableView = _playPauseButton;
            _playPauseButton.LeftFocusableView = _backButton;
            _playPauseButton.RightFocusableView = _serverButton;
            _serverButton.LeftFocusableView = _playPauseButton;
            _serverButton.RightFocusableView = _sourceButton;
            _sourceButton.LeftFocusableView = _serverButton;

            _backButton.Selected += OnBackButtonSelected;
            _playPauseButton.Selected += OnPlayPauseSelected;
            _serverButton.Selected += OnServerButtonSelected;
            _sourceButton.Selected += OnSourceButtonSelected;

            overlay.Add(_backButton);
            overlay.Add(_playPauseButton);
            overlay.Add(_serverButton);
            overlay.Add(_sourceButton);
            return overlay;
        }

        private static FocusButton CreateOverlayButton(string label, int x, int width)
        {
            return new FocusButton(label, width, Theme.OverlayHeight, false)
            {
                // Center pivot: Position2D measures to the button's own center.
                Position2D = new Position2D(x + width / 2, Theme.OverlayY + Theme.OverlayHeight / 2)
            };
        }

        // ---- resolution pipeline -------------------------------------------

        /// <summary>
        /// Play priority: Stremio addon streams FIRST (direct MKV/HEVC + HLS
        /// that AVPlay handles natively), the classic server pipeline only
        /// when the addons yield nothing playable. Every addon failure
        /// (fetch error, empty result, unparsable payload) lands in exactly
        /// one place — the server pipeline below — so the user always gets
        /// the previous behavior as the floor.
        /// </summary>
        private async Task ResolveAndPlayAsync()
        {
            try
            {
                SetStatusOnUi(ResolveStatusText("Resolving addon streams..."));
                List<AddonStream> addonStreams = await _api.FetchAddonStreamsAsync(
                    _item.Id, _item.Type, _season, _episode);
                if (_closed)
                {
                    return;
                }

                if (addonStreams != null && addonStreams.Count > 0)
                {
                    _addonStreams = addonStreams;
                    UiDispatcher.Post(() =>
                    {
                        if (_closed)
                        {
                            return;
                        }
                        ApplyAddonStream(addonStreams[0]);
                    });

                    // Keep the SERVER popup functional while the addon plays:
                    // bind the server catalog in the background (cheap config
                    // GET, never blocks or delays the addon stream).
                    _ = BindServersInBackgroundAsync();
                    return;
                }
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, $"Addon resolution failed — falling back to servers: {ex.Message}");
                if (_closed)
                {
                    return;
                }
            }

            // FALLBACK — embeds/default sources, exactly the pre-addon flow.
            await ResolveAndPlayFromServersAsync();
        }

        /// <summary>
        /// The server pipeline (the former sole resolution path): admin
        /// default with fallback walk, then the direct-capable walk, then
        /// the first embed as the last resort. Also the graceful landing
        /// when an addon stream fails to prepare.
        /// </summary>
        private async Task ResolveAndPlayFromServersAsync()
        {
            try
            {
                SetStatusOnUi(ResolveStatusText("Resolving servers..."));
                StreamingSourceList serverList = await _api.FetchStreamingSourcesAsync(_item.Type);
                if (_closed)
                {
                    return;
                }
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    BindServers(serverList);
                });

                HashSet<string> tried = new HashSet<string>();
                ResolvedSource resolved = null;

                // 1. Fast path: admin default + server-side fallback walk.
                string defaultSourceId = serverList?.DefaultSourceId;
                if (!string.IsNullOrEmpty(defaultSourceId))
                {
                    tried.Add(defaultSourceId);
                    SetStatusOnUi(ResolveStatusText("Resolving servers..."));
                    resolved = await _api.ResolveStreamAsync(defaultSourceId, _item.Id, _item.Type, true,
                        _season, _episode);
                    if (_closed)
                    {
                        return;
                    }
                }

                // 2. Direct-priority walk: the resolver ranks candidates by
                //    health, not type, so a healthy embed can beat a direct
                //    source. When the walk did not yield a direct url,
                //    explicitly pin-resolve direct-capable servers.
                if ((resolved == null || !IsDirect(resolved)) && serverList != null)
                {
                    int attempts = 0;
                    foreach (ServerEntry server in serverList.Entries)
                    {
                        if (attempts >= MaxResolveWalkAttempts || tried.Contains(server.SourceId))
                        {
                            continue;
                        }

                        if (!server.IsDirect)
                        {
                            continue;
                        }

                        attempts++;
                        tried.Add(server.SourceId);
                        SetStatusOnUi(ResolveStatusText($"Trying server {server.Name}..."));
                        ResolvedSource candidate = await _api.ResolveStreamAsync(
                            server.SourceId, _item.Id, _item.Type, false, _season, _episode);
                        if (_closed)
                        {
                            return;
                        }

                        if (candidate != null && IsDirect(candidate))
                        {
                            resolved = candidate;
                            break;
                        }
                    }
                }

                if (resolved == null || string.IsNullOrEmpty(resolved.Url))
                {
                    UiDispatcher.Post(() =>
                    {
                        if (_closed)
                        {
                            return;
                        }
                        SetStatus("No playable stream found for this title");
                        ShowOverlay();
                    });
                    return;
                }

                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    if (!IsDirect(resolved))
                    {
                        // Spec fallback: nothing direct resolved anywhere —
                        // attempt the embed url and let AVPlay judge it.
                        SetStatus("No direct stream available - attempting embed source...");
                    }
                    ApplyResolution(resolved);
                });
            }
            catch (Exception ex)
            {
                Log.Error(MaveroApp.LogTag, $"Stream resolution failed: {ex.Message}");
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    SetStatus("Could not resolve a playable stream");
                    ShowOverlay();
                });
            }
        }

        /// <summary>
        /// Binds the server catalog while an addon stream plays so the
        /// SERVER popup stays truthful. Best-effort: a failure just leaves
        /// the popup empty-handed ("No servers available"), never breaks
        /// addon playback.
        /// </summary>
        private async Task BindServersInBackgroundAsync()
        {
            try
            {
                StreamingSourceList serverList = await _api.FetchStreamingSourcesAsync(_item.Type);
                if (_closed)
                {
                    return;
                }
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    BindServers(serverList);
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, $"Background server bind failed: {ex.Message}");
            }
        }

        private async Task ResolveAndPlaySpecificAsync(ServerEntry entry)
        {
            try
            {
                SetStatusOnUi(ResolveStatusText($"Resolving {entry.Name}..."));
                ResolvedSource resolved = await _api.ResolveStreamAsync(entry.SourceId, _item.Id, _item.Type, false,
                    _season, _episode);
                if (_closed)
                {
                    return;
                }

                if (resolved == null || string.IsNullOrEmpty(resolved.Url))
                {
                    UiDispatcher.Post(() =>
                    {
                        if (_closed)
                        {
                            return;
                        }
                        SetStatus($"Could not resolve {entry.Name}");
                    });
                    return;
                }

                if (!IsDirect(resolved))
                {
                    UiDispatcher.Post(() =>
                    {
                        if (_closed)
                        {
                            return;
                        }
                        SetStatus($"{entry.Name} is an embed source - the native player needs a direct stream");
                    });
                    return;
                }

                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    ApplyResolution(resolved);
                });
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, $"Resolve of {entry.Name} failed: {ex.Message}");
                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }
                    SetStatus($"Could not resolve {entry.Name}");
                });
            }
        }

        private static bool IsDirect(ResolvedSource resolved)
        {
            return resolved != null
                && string.Equals(resolved.Type, "direct", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrEmpty(resolved.Url);
        }

        /// <summary>Resolve-phase status line, prefixed with the episode target
        /// when one is set ("S1E2 — Trying server X...").</summary>
        private string ResolveStatusText(string message)
        {
            return _targetLabel != null ? $"{_targetLabel} — {message}" : message;
        }

        private void BindServers(StreamingSourceList serverList)
        {
            _serverList = serverList ?? new StreamingSourceList { Entries = new List<ServerEntry>() };
            UpdateServerButtonLabel();
        }

        private void ApplyResolution(ResolvedSource resolved)
        {
            _resolved = resolved;
            _activeAddonStream = null; // a server choice always outranks a stale addon pick
            UpdateServerButtonLabel();
            UpdateSourceButtonLabel();

            Log.Info(MaveroApp.LogTag,
                $"Player: applying {resolved.Type} source " +
                $"'{(resolved.Metadata?.SourceName ?? resolved.SourceId)}' " +
                $"protocol={resolved.Metadata?.Protocol ?? "unknown"}");

            _ = PlayStreamAsync(resolved.Url);
        }

        /// <summary>
        /// Applies one Stremio addon stream (PRIORITY 1 path). No ResolvedSource
        /// is involved — the addon url IS the playback url; AVPlay reads the
        /// HLS manifest or the MKV/MP4 container directly.
        /// </summary>
        private void ApplyAddonStream(AddonStream stream)
        {
            _activeAddonStream = stream;
            _resolved = null;
            UpdateServerButtonLabel();
            UpdateSourceButtonLabel();

            Log.Info(MaveroApp.LogTag,
                $"Player: applying addon stream '{stream.AddonName}' " +
                $"quality={stream.Quality ?? "auto"} codec={stream.Codec ?? "unknown"} " +
                $"kind={stream.Kind ?? "?"}");

            _ = PlayStreamAsync(stream.Url);
        }

        /// <summary>
        /// Selector label for one addon stream, mirroring the user-facing
        /// "Addon 1080p" / "Addon 4K HEVC" shape: addon name + quality,
        /// with the codec called out only when it is the reason this stream
        /// is special on a TV (HEVC/AV1 — H.264 needs no billing).
        /// </summary>
        private static string BuildAddonStreamLabel(AddonStream stream)
        {
            if (stream == null)
            {
                return "Addon stream";
            }

            string name = string.IsNullOrWhiteSpace(stream.AddonName)
                ? (string.IsNullOrWhiteSpace(stream.Host) ? "Stremio" : stream.Host)
                : stream.AddonName.Trim();
            string quality = string.IsNullOrWhiteSpace(stream.Quality) ? "Auto" : stream.Quality.Trim();

            string label = $"{name} {quality}";
            string codec = (stream.Codec ?? string.Empty).Trim();
            if (string.Equals(codec, "HEVC", StringComparison.OrdinalIgnoreCase)
                || string.Equals(codec, "AV1", StringComparison.OrdinalIgnoreCase))
            {
                label += " " + codec.ToUpperInvariant();
            }

            return label;
        }

        // ---- playback -------------------------------------------------------

        private async Task PlayStreamAsync(string url)
        {
            if (string.IsNullOrEmpty(url))
            {
                SetStatusOnUi("This source has no stream url");
                return;
            }

            _activeUrl = url;
            _curtain.Show();
            SetStatusOnUi("Loading stream...");
            DestroyPlayer();

            _player = new Player();
            try
            {
                _player.Display = new Display(_window);
                _player.DisplaySettings.Mode = PlayerDisplayMode.LetterBox;
                _player.DisplaySettings.IsVisible = true;
                _player.BufferingTime = new PlayerBufferingTime
                {
                    PreBufferMillisecond = 4000,
                    ReBufferMillisecond = 2000
                };
                _player.SetSource(new MediaUriSource(url));
                WirePlayerEvents();

                Log.Info(MaveroApp.LogTag,
                    $"Player: preparing stream ({_item.Id}" +
                    (_targetLabel != null ? " " + _targetLabel : string.Empty) + ")");

                await _player.PrepareAsync();
                if (_closed)
                {
                    DestroyPlayer();
                    return;
                }

                UiDispatcher.Post(() =>
                {
                    if (_closed || _player == null)
                    {
                        return;
                    }
                    _player.Start();
                    // Video now renders on the layer below the DALi surface;
                    // drop the black cover so it shows through.
                    _curtain.Hide();
                    SetStatus(string.Empty);
                    Log.Info(MaveroApp.LogTag, "Player: playback started");
                });
            }
            catch (Exception ex)
            {
                Log.Error(MaveroApp.LogTag, $"Player prepare failed: {ex.Message}");
                DestroyPlayer();

                bool addonStreamFailed = _activeAddonStream != null
                    && string.Equals(_activeUrl, _activeAddonStream.Url, StringComparison.Ordinal);

                UiDispatcher.Post(() =>
                {
                    if (_closed)
                    {
                        return;
                    }

                    if (addonStreamFailed)
                    {
                        // The chosen addon stream could not prepare — degrade
                        // gracefully to the server pipeline instead of a dead
                        // end (one fallback, the server path cannot loop back
                        // into the addon path).
                        Log.Warn(MaveroApp.LogTag, "Addon stream unplayable — falling back to servers");
                        SetStatus("Addon stream unplayable - trying servers...");
                        _ = ResolveAndPlayFromServersAsync();
                        return;
                    }

                    SetStatus("Playback failed - this source cannot be played natively");
                    ShowOverlay();
                });
            }
        }

        private void WirePlayerEvents()
        {
            _player.ErrorOccurred += OnPlayerErrorOccurred;
            _player.BufferingProgressChanged += OnPlayerBufferingProgress;
            _player.PlaybackCompleted += OnPlayerPlaybackCompleted;
            _player.PlaybackInterrupted += OnPlayerPlaybackInterrupted;
        }

        private void DestroyPlayer()
        {
            if (_player == null)
            {
                return;
            }

            Player player = _player;
            _player = null;

            player.ErrorOccurred -= OnPlayerErrorOccurred;
            player.BufferingProgressChanged -= OnPlayerBufferingProgress;
            player.PlaybackCompleted -= OnPlayerPlaybackCompleted;
            player.PlaybackInterrupted -= OnPlayerPlaybackInterrupted;

            try
            {
                PlayerState state = player.State;
                if (state == PlayerState.Playing || state == PlayerState.Paused)
                {
                    player.Stop();
                }
            }
            catch (Exception ex)
            {
                Log.Warn(MaveroApp.LogTag, $"Player stop failed during teardown: {ex.Message}");
            }

            player.Dispose();
        }

        // Player events fire on native threads — every UI touch is posted.

        private void OnPlayerErrorOccurred(object sender, PlayerErrorOccurredEventArgs e)
        {
            Log.Warn(MaveroApp.LogTag, $"Player error: {e.Error}");
            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                SetStatus($"Playback failed ({e.Error})");
                ShowOverlay();
            });
        }

        private void OnPlayerBufferingProgress(object sender, BufferingProgressChangedEventArgs e)
        {
            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                SetStatus(e.Percent < 100 ? $"Buffering {e.Percent}%" : string.Empty);
            });
        }

        private void OnPlayerPlaybackCompleted(object sender, EventArgs e)
        {
            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                SetStatus("Playback finished");
                ShowOverlay();
            });
        }

        private void OnPlayerPlaybackInterrupted(object sender, PlaybackInterruptedEventArgs e)
        {
            Log.Warn(MaveroApp.LogTag, $"Player interrupted: {e.Reason}");
            UiDispatcher.Post(() =>
            {
                if (_closed)
                {
                    return;
                }
                SetStatus($"Playback interrupted ({e.Reason})");
                ShowOverlay();
            });
        }

        // ---- overlay visibility --------------------------------------------

        private void ShowOverlay()
        {
            _overlayVisible = true;
            _overlay.Show();
            FocusManager.Instance.SetCurrentFocusView(_backButton);
            ArmHideTimer();
        }

        private void HideOverlay()
        {
            _overlayVisible = false;
            FocusManager.Instance.SetCurrentFocusView(null);
            _overlay.Hide();
        }

        /// <summary>Restart the inactivity countdown (Stop+Start resets the interval).</summary>
        private void ArmHideTimer()
        {
            if (_hideTimer == null)
            {
                return;
            }

            _hideTimer.Stop();
            _hideTimer.Start();
        }

        private bool OnHideTimerTick(object source, Timer.TickEventArgs args)
        {
            if (_closed)
            {
                return false;
            }

            if (_activePopup != null)
            {
                return true; // user is browsing a popup — keep waiting
            }

            HideOverlay();
            return false; // one-shot: stopped until the next activity re-arms it
        }

        private void OnGlobalFocusChanged(object source, FocusManager.FocusChangedEventArgs e)
        {
            // The built-in navigation consumes arrow keys, so the window
            // never sees them; focus movement IS the D-pad activity signal.
            if (_closed || !_overlayVisible || _activePopup != null)
            {
                return;
            }

            ArmHideTimer();
        }

        // ---- overlay actions ------------------------------------------------

        private void OnBackButtonSelected()
        {
            ArmHideTimer();
            CloseRequested?.Invoke();
        }

        private void OnPlayPauseSelected()
        {
            ArmHideTimer();

            if (_player == null)
            {
                SetStatus("No stream loaded yet");
                return;
            }

            PlayerState state = _player.State;
            if (state == PlayerState.Playing)
            {
                _player.Pause();
                _playPauseButton.SetLabel("PLAY");
                Log.Info(MaveroApp.LogTag, "Player: paused");
            }
            else if (state == PlayerState.Paused || state == PlayerState.Ready)
            {
                // API6 has no Resume() — Start() from Paused/Ready resumes.
                _player.Start();
                _playPauseButton.SetLabel("PAUSE");
                Log.Info(MaveroApp.LogTag, "Player: resumed");
            }
            else
            {
                SetStatus("Stream is not ready yet");
            }
        }

        private void OnServerButtonSelected()
        {
            ArmHideTimer();

            if (_activePopup != null)
            {
                return;
            }

            List<ServerEntry> entries = _serverList?.Entries;
            if (entries == null || entries.Count == 0)
            {
                SetStatus("No servers available");
                return;
            }

            List<string> options = new List<string>();
            foreach (ServerEntry entry in entries)
            {
                string label = string.IsNullOrEmpty(entry.Name) ? "Server" : entry.Name;
                if (!entry.IsDirect)
                {
                    label += " (embed)";
                }
                if (string.Equals(entry.SourceId, _resolved?.SourceId, StringComparison.Ordinal))
                {
                    label = "\u00b7 " + label; // middle dot marks the active server
                }
                options.Add(label);
            }

            OpenPopup(new StreamSelectorPopup("Select server", options), PopupKind.Server);
        }

        private void OnSourceButtonSelected()
        {
            ArmHideTimer();

            if (_activePopup != null)
            {
                return;
            }

            bool addonMode = _activeAddonStream != null;
            List<SourceOption> options = addonMode ? BuildAddonSourceOptions() : BuildSourceOptions();
            if (options.Count <= 1)
            {
                SetStatus("Single source available");
                return;
            }

            List<string> labels = new List<string>();
            foreach (SourceOption option in options)
            {
                string label = option.Label ?? "Source";
                if (string.Equals(option.Url, _activeUrl, StringComparison.Ordinal))
                {
                    label = "\u00b7 " + label; // middle dot marks the active rendition
                }
                labels.Add(label);
            }

            _sourceOptions = options;
            OpenPopup(new StreamSelectorPopup(addonMode ? "Select addon stream" : "Select source", labels), PopupKind.Source);
        }

        /// <summary>The playable addon streams, already ordered best-first by the
        /// ApiService — the Source popup rows while addon playback is active.</summary>
        private List<SourceOption> BuildAddonSourceOptions()
        {
            List<SourceOption> options = new List<SourceOption>();

            if (_addonStreams != null)
            {
                foreach (AddonStream stream in _addonStreams)
                {
                    if (stream == null || string.IsNullOrEmpty(stream.Url))
                    {
                        continue;
                    }

                    options.Add(new SourceOption
                    {
                        Label = BuildAddonStreamLabel(stream),
                        Url = stream.Url,
                        AddonStream = stream
                    });
                }
            }

            return options;
        }

        /// <summary>Qualities of the active resolution, falling back to its mirrors.</summary>
        private List<SourceOption> BuildSourceOptions()
        {
            List<SourceOption> options = new List<SourceOption>();

            if (_resolved?.Qualities != null)
            {
                int index = 0;
                foreach (QualityOption quality in _resolved.Qualities)
                {
                    index++;
                    if (quality == null || string.IsNullOrEmpty(quality.Url))
                    {
                        continue;
                    }

                    string label = quality.Label;
                    if (string.IsNullOrEmpty(label) && quality.Height > 0)
                    {
                        label = quality.Height + "p";
                    }
                    if (string.IsNullOrEmpty(label))
                    {
                        label = "Quality " + index;
                    }

                    options.Add(new SourceOption { Label = label, Url = quality.Url });
                }
            }

            if (options.Count == 0 && _resolved?.Metadata?.Servers != null)
            {
                int index = 0;
                foreach (ServerMirror mirror in _resolved.Metadata.Servers)
                {
                    index++;
                    if (mirror == null || string.IsNullOrEmpty(mirror.Url))
                    {
                        continue;
                    }

                    options.Add(new SourceOption
                    {
                        Label = string.IsNullOrEmpty(mirror.Label) ? "Server " + index : mirror.Label,
                        Url = mirror.Url
                    });
                }
            }

            return options;
        }

        private void UpdateServerButtonLabel()
        {
            if (_serverButton == null)
            {
                return;
            }

            string name = _resolved?.Metadata?.SourceName;
            if (string.IsNullOrEmpty(name))
            {
                name = _resolved?.Metadata?.ProviderName;
            }
            if (string.IsNullOrEmpty(name) && _serverList?.Entries != null)
            {
                ServerEntry entry = _serverList.Entries.FirstOrDefault(e =>
                    string.Equals(e.SourceId, _resolved?.SourceId, StringComparison.Ordinal));
                name = entry?.Name;
            }

            _serverButton.SetLabel(string.IsNullOrEmpty(name) ? "SERVER" : name);
        }

        private void UpdateSourceButtonLabel()
        {
            if (_sourceButton == null)
            {
                return;
            }

            if (_activeAddonStream != null)
            {
                // Addon playback: the button bills the active addon stream
                // ("Torrentio 4K HEVC") instead of the server qualities.
                _sourceButton.SetLabel(BuildAddonStreamLabel(_activeAddonStream));
                return;
            }

            List<SourceOption> options = BuildSourceOptions();
            _sourceButton.SetLabel(options.Count > 0 ? options[0].Label : "AUTO");
        }

        // ---- popup lifecycle ------------------------------------------------

        private void OpenPopup(StreamSelectorPopup popup, PopupKind kind)
        {
            _hideTimer.Stop();
            HideOverlay();

            _activePopupKind = kind;
            _activePopup = popup;
            popup.Selected += OnPopupSelected;
            Add(popup);
            popup.FocusFirstRow();
        }

        private void ClosePopup()
        {
            if (_activePopup == null)
            {
                return;
            }

            StreamSelectorPopup popup = _activePopup;
            _activePopup = null;
            _activePopupKind = PopupKind.None;
            _sourceOptions = null;

            popup.Selected -= OnPopupSelected;
            FocusManager.Instance.SetCurrentFocusView(null);
            Remove(popup);
            popup.Dispose();

            ShowOverlay();
        }

        private void OnPopupSelected(int index)
        {
            if (_activePopupKind == PopupKind.Server)
            {
                List<ServerEntry> entries = _serverList?.Entries;
                ServerEntry entry = entries != null && index >= 0 && index < entries.Count
                    ? entries[index]
                    : null;

                ClosePopup();
                ArmHideTimer();

                if (entry != null)
                {
                    SetStatus($"Resolving {entry.Name}...");
                    _ = ResolveAndPlaySpecificAsync(entry);
                }
                return;
            }

            if (_activePopupKind == PopupKind.Source)
            {
                SourceOption option = _sourceOptions != null && index >= 0 && index < _sourceOptions.Count
                    ? _sourceOptions[index]
                    : null;

                ClosePopup();
                ArmHideTimer();

                if (option != null)
                {
                    // Track WHICH surface owns playback now: selecting an
                    // addon row moves the addon state forward; selecting a
                    // server rendition clears it (ApplyResolution does the
                    // same when the SERVER popup resolves a server).
                    _activeAddonStream = option.AddonStream;
                    _sourceButton.SetLabel(option.Label);
                    _ = PlayStreamAsync(option.Url);
                }
            }
        }

        // ---- status ---------------------------------------------------------

        private void SetStatus(string message)
        {
            if (string.IsNullOrEmpty(message))
            {
                _status.Text = string.Empty;
                _status.Hide();
                return;
            }

            _status.Text = message;
            _status.Show();
        }

        private void SetStatusOnUi(string message)
        {
            UiDispatcher.Post(() =>
            {
                if (!_closed)
                {
                    SetStatus(message);
                }
            });
        }
    }
}
