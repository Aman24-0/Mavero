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
            name: 'MP4 — Big Buck Bunny',
            tag: 'MP4',
            url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
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

        var w = window.innerWidth;
        var h = window.innerHeight;

        try {
            avplayStop();
            webapis.avplay.open(src.url);

            // Render AVPlay into the full-screen video element.
            var rect = document.getElementById('video').getBoundingClientRect();
            webapis.avplay.setDisplayRect(
                Math.round(rect.left), Math.round(rect.top),
                Math.round(rect.width || w), Math.round(rect.height || h)
            );

            webapis.avplay.setListener({
                onbufferingstart: function () { setStatus('Buffering… ' + src.url); },
                onbufferingprogress: function (p) { setStatus('Buffering ' + p + '%'); },
                onbufferingcomplete: function () { setStatus('Playing: ' + src.url); },
                onstreamcompleted: function () { setStatus('Completed: ' + src.url); backToList(); },
                oncurrentplaytime: function () { /* noop */ },
                onerror: function (e) { setStatus('AVPLAY ERROR: ' + e + ' — ' + src.url); },
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
