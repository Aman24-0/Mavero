/* ============================================================================
 * Mavero TV — AVPlay PoC (Tizen Web App / .wgt)
 *
 * Goal: prove on the REAL TV that Samsung's native player (AVPlay) plays the
 * formats Stremio / Nuvio addons and CloudStream extensions hand out — which
 * are ~99% MKV — plus HLS, with full D-pad navigation.
 *
 * How the full app will use this:
 *   - pressing PLAY on a title → resolve sources from the ACTIVE addons
 *     (the existing "Mavero Downloader" pipeline, called over the backend)
 *   - AVPlay plays the first (addon) source directly
 *   - a source-switch overlay lists every source → AVPlay re-opens the pick
 *   - embed iframe stays as the secondary fallback
 *
 * This file only needs to answer: does AVPlay play MKV on this TV? If yes,
 * the full player is wired in next.
 * ==========================================================================*/

(function () {
    'use strict';

    // --- Sources to test -----------------------------------------------------
    // Replace / add your own addon MKV URL in the "custom" entry (the exact
    // link an addon gives you). The public ones below just prove the pipeline.
    var SOURCES = [
        {
            name: 'MKV — Big Buck Bunny (public test)',
            tag: 'MKV',
            url: 'https://test-videos.co.uk/vids/bigbuckbunny/mkv/720/Big_Buck_Bunny_720_10s_1MB.mkv'
        },
        {
            name: 'MKV — Sintel (public test)',
            tag: 'MKV',
            url: 'https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4'
        },
        {
            name: 'HLS — Mux test stream',
            tag: 'HLS',
            url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
        },
        {
            name: 'MP4 — Sintel 480p (blender, reachable)',
            tag: 'MP4',
            // commondatastorage.googleapis.com was PLAYER_ERROR_CONNECTION_FAILED
            // on the TV (host blocked/unreachable in its region) — use the same
            // blender host the Sintel entry already streamed audio from.
            url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4'
        }
    ];

    // --- DOM -----------------------------------------------------------------
    var listEl = document.getElementById('list');
    var listView = document.getElementById('list-view');
    var playerView = document.getElementById('player-view');
    var statusEl = document.getElementById('status');

    var focusIndex = 0;
    var playing = false;

    function setStatus(msg) {
        statusEl.textContent = msg;
    }

    // --- Render the list -----------------------------------------------------
    function render() {
        listEl.innerHTML = '';
        SOURCES.forEach(function (src, i) {
            var li = document.createElement('li');
            li.className = i === focusIndex ? 'focused' : '';

            var label = document.createElement('span');
            label.textContent = src.name;

            var tag = document.createElement('span');
            tag.className = 'tag' + (src.tag === 'HLS' ? ' hls' : (src.tag === 'MP4' ? ' mp4' : ''));
            tag.textContent = src.tag;

            li.appendChild(label);
            li.appendChild(tag);
            listEl.appendChild(li);
        });
    }

    function move(delta) {
        focusIndex = (focusIndex + delta + SOURCES.length) % SOURCES.length;
        render();
    }

    // --- AVPlay --------------------------------------------------------------
    function avplayStop() {
        try { webapis.avplay.stop(); } catch (e) { /* not playing */ }
        try { webapis.avplay.close(); } catch (e) { /* already closed */ }
    }

    function play(src) {
        if (!window.webapis || !webapis.avplay) {
            setStatus('ERROR: webapis.avplay not available (not a Tizen TV runtime?)');
            return;
        }

        listView.style.display = 'none';
        playerView.style.display = 'block';
        playing = true;

        try {
            avplayStop();
            webapis.avplay.open(src.url);

            // AVPlay draws onto the video plane that belongs to the
            // <object id="av-player"> plugin element (Samsung's official
            // AVPlay sample: playerEl = the <object>, NOT a div).
            //
            // Its rect comes in WEB-viewport px, but the video plane is in
            // PHYSICAL screen px (1920x1080) and the web viewport is usually
            // SMALLER than the screen — scale web px -> physical px exactly
            // like Samsung's sample (screenWidth / viewportWidth):
            var playerEl = document.getElementById('av-player');
            var rect = playerEl.getBoundingClientRect();
            var sx = window.screen.width / (document.documentElement.clientWidth || window.screen.width);
            var sy = window.screen.height / (document.documentElement.clientHeight || window.screen.height);
            webapis.avplay.setDisplayRect(
                Math.round(rect.left * sx), Math.round(rect.top * sy),
                Math.round(rect.width * sx), Math.round(rect.height * sy)
            );
            webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');

            // Debug (visible in the status bar on the TV): screen vs viewport
            // vs the scaled rect actually handed to the video plane.
            setStatus('open: screen ' + window.screen.width + 'x' + window.screen.height +
                ', viewport ' + document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight +
                ', rect->' + Math.round(rect.width * sx) + 'x' + Math.round(rect.height * sy) +
                ' px (scale ' + sx.toFixed(2) + '/' + sy.toFixed(2) + ')');

            webapis.avplay.setListener({
                onbufferingstart: function () { setStatus('Buffering… ' + src.url); },
                onbufferingprogress: function (p) { setStatus('Buffering ' + p + '%'); },
                onbufferingcomplete: function () { setStatus('Playing: ' + src.url); },
                // Do NOT auto-return to the list (not even on completion) —
                // keep the message readable; only Back goes to the list.
                onstreamcompleted: function () { setStatus('Completed: ' + src.url + ' — press Back for the list'); },
                oncurrentplaytime: function () { /* noop */ },
                onerror: function (e) { setStatus('AVPLAY ERROR: ' + e + ' — ' + src.url + ' (staying on player; Back = list)'); },
                onsubtitlechange: function () { /* noop */ },
                ondrmevent: function () { /* noop */ },
                onevent: function () { /* noop */ }
            });

            setStatus('Preparing: ' + src.url);
            webapis.avplay.prepareAsync(
                function () {
                    webapis.avplay.play();
                    setStatus('Playing: ' + src.url);
                },
                function (e) {
                    setStatus('PREPARE FAILED: ' + e + ' — ' + src.url);
                }
            );
        } catch (err) {
            setStatus('EXCEPTION: ' + (err && err.message ? err.message : err));
        }
    }

    function backToList() {
        avplayStop();
        playing = false;
        playerView.style.display = 'none';
        listView.style.display = 'flex';
        setStatus('Stopped.');
    }

    // --- Remote / D-pad keys -------------------------------------------------
    // 37← 38↑ 39→ 40↓ 13=OK 10009=Back (TV) 27=Esc (emulator)
    function onKey(e) {
        var code = e.keyCode;

        if (playing) {
            if (code === 10009 || code === 27) {   // Back
                e.preventDefault();
                backToList();
            }
            return;
        }

        switch (code) {
            case 38: case 37:                     // up / left
                e.preventDefault(); move(-1); break;
            case 40: case 39:                     // down / right
                e.preventDefault(); move(1); break;
            case 13:                              // Enter / OK
                e.preventDefault(); play(SOURCES[focusIndex]); break;
            case 10009: case 27:                  // Back → exit app
                e.preventDefault();
                try { tizen.application.getCurrentApplication().exit(); } catch (x) { }
                break;
            default:
                break;
        }
    }

    // --- Boot ----------------------------------------------------------------
    function boot() {
        // Register media keys so the remote's play/pause reach us (best-effort).
        try {
            if (window.tizen && tizen.tvinputdevice) {
                tizen.tvinputdevice.registerKeyBatch(
                    ['MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']
                );
            }
        } catch (e) { /* ignore on emulator */ }

        render();
        document.addEventListener('keydown', onKey);
        setStatus('Ready. D-pad se source chuno, Enter se play karo.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
