# Mavero TV — `.wgt` (Tizen Web App) — PoC

This folder is a **self-contained proof-of-concept**, separate from the web app
(`apps/web` is untouched). It answers three questions on the real TV before we
build the full app:

1. Does a `.wgt` install on the TV via **Apps2Samsung**? (yes — Apps2Samsung
   makes the certificate and installs; no Tizen Studio needed)
2. Does **Samsung AVPlay** play **MKV** (what Stremio / CloudStream addons
   hand out), plus HLS?
3. Does **full D-pad navigation** work?

Once all three are green, we wire the real Mavero UI in and switch the TV
player path to AVPlay (addon sources first, embed iframe as fallback).

---

## Files

```
apps/tizen-wgt/
├── config.xml                Tizen web app manifest (TV profile, internet, hwkey-event)
├── index.html                Source-list UI (D-pad)
├── app.js                    AVPlay player + key handling  ← the thing under test
├── icon.png                  launcher icon (512×512)
├── tizen_web_project.yaml    tizen-core project metadata (pinned: profile tv, files, excludes)
└── README.md                 this file
```

---

## The [118, -19] install failure — root cause (fixed)

`[118, -19] "could not read the package's manifest"` was **not** a packaging
(zip) problem and **not** a Tizen-version problem (`required_version="2.3"`
≤ 6.0 is correct). The TV's package manager validates `config.xml` against the
Tizen widget schema, and the tv-profile schema (`widgets.tizen.xsd`, byte-
identical in every Tizen Studio profile from 2.3 to 9.0) requires:

```
tizen:application/@package : [0-9a-zA-Z]{10}                      exactly 10 alphanumerics — NO dots
tizen:application/@id      : [0-9a-zA-Z]{10}[.][0-9a-zA-Z]{1,52}  <package>.<AppName>
```

The old manifest used `package="org.mavero"` / `id="org.mavero.tv"` — dots in
both, neither pattern matched → the manifest failed schema parsing before any
version check ran. Verified against the OFFICIAL schema shipped in Tizen
Studio: the old config is INVALID (exactly two pattern violations), the fixed
config is VALID. Every known-good shipping TV app follows the same rule:

| App | package (10 chars) | id = package + "." + name |
|---|---|---|
| jellyfin-tizen | `AprZAARz4r` | `AprZAARz4r.Jellyfin` |
| Moonlight | `MoonLightS` | `MoonLightS.MoonlightWasm` |
| Twellie (smarttv-twitch) | `Twellie001` | `Twellie001.Twellie` |
| **Mavero** | `MaveroTV01` | `MaveroTV01.MaveroTV` |

The manifest also gained the two privileges the PoC's runtime needs:
`http://tizen.org/privilege/tv.inputdevice` (D-pad registration) and
`http://developer.samsung.com/privilege/avplay` (webapis.avplay).

## Audio plays but NO video — root cause (fixed)

AVPlay does **not** render into a plain `<div>`. It needs the plugin element
Samsung's official sample ([SampleWebApps-PlayerAvplay](https://github.com/SamsungDForum/SampleWebApps-PlayerAvplay))
uses, and it draws onto a video plane **below** the web layer:

1. `<div id="video">` → `<object id="av-player" type="application/avplayer"></object>`.
   A plain div never receives frames — you hear audio but the video plane is
   blank/covered (plus the opaque page background hides everything).
2. `setDisplayRect()` must be in **physical screen px**, not raw viewport px.
   The web viewport is usually SMALLER than the physical 1920x1080 screen, so
   the rect is scaled like Samsung's sample:
   `coords * (window.screen.width / documentElement.clientWidth)`.
3. `setDisplayMethod('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO')` — the sample
   always calls it; without it the plane can letterbox/glitch (the blue
   striped bar at the bottom).
4. Errors/completions no longer bounce back to the list — the status line
   keeps the message readable; only **Back** returns to the list.
5. The `commondatastorage.googleapis.com` MP4 was a test-data issue
   (`PLAYER_ERROR_CONNECTION_FAILED`, host unreachable from the TV's region)
   — replaced with the reachable `download.blender.org` Sintel 480p MP4.

The status bar logs `screen WxH, viewport WxH, rect-> WxH px` on every open,
so the scaling is verifiable directly on the TV.

## Build the `.wgt` (official Tizen CLI — NOT a raw zip)

CI builds the package with the **official Tizen Studio CLI** (`.github/workflows/build-wgt.yml`):
the web-cli installer's `tizen-core` (`tz`) tool schema-validates the manifest,
builds the app and packs a structurally correct `.wgt` (config.xml at the
root, `author-signature.xml` + `signature1.xml` skeletons present — Apps2Samsung
re-signs with the real Samsung certificate on install). The result is attached
to the rolling **`wgt-latest` release** and as the `MaveroTV-wgt` artifact.

Download: `https://github.com/Aman24-0/Mavero/releases/download/wgt-latest/MaveroTV.wgt`
(GitHub caches release assets — add a `?v=<timestamp>` cache-buster).

### Build locally (optional)

```bash
# 1. Install Tizen Studio web-cli (headless, ~280 MB download):
curl -fsSLo /tmp/web-cli.bin \
  "http://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin"
bash /tmp/web-cli.bin --accept-license --no-java-check ~/tizen-studio

# 2. Sync SDK components once (expected output: "Nothing to install"):
~/tizen-studio/package-manager/package-manager-cli.bin install --accept-license --no-java-check TOOLS

# 3. Build + pack:
cd apps/tizen-wgt
~/tizen-studio/tools/tizen-core/tz build .
~/tizen-studio/tools/tizen-core/tz pack .
# → Debug/<name>.wgt — rename to MaveroTV.wgt and install.
```

---

## Install on the TV with Apps2Samsung

1. **TV in Developer Mode:** Apps → type `12345` → Developer mode **ON** →
   enter the **PC's IP** → restart the TV.
2. Open **Apps2Samsung** (Windows app / Android app / CLI — https://apps2samsung.com).
3. It finds the TV → choose **"your own `.wgt`"** → pick `MaveroTV.wgt` → **Install**.
   (First install signs you in to Samsung once to create the certificate; reused after.)
4. Launch **Mavero TV** from the TV's app list.

---

## What to test on the TV

- D-pad **↑ ↓** moves the focus ring, **Enter** plays the highlighted source.
- The sources should show **VIDEO and audio** (not audio alone): MKV, MP4 and
  HLS all render inside the `<object id="av-player">` element, full screen.
- The status bar shows `open: screen …, viewport …, rect-> …` then
  `Playing: <url>`; errors **stay on the player** (only **Back** returns to
  the list, Back again exits).

### Test with a REAL addon link
Open `app.js`, replace the first entry's `url` (or add one) with an actual
MKV link from your addon:
```js
{ name: 'My addon source', tag: 'MKV', url: 'https://…your-addon-mkv-link…' }
```
Repackage and reinstall.

---

## What "success" looks like

| Result | Meaning |
|---|---|
| MKV plays | ✅ AVPlay handles addon MKVs → full player can use addon sources first |
| Only HLS/MP4 play, MKV errors | MKV container/codec unsupported on this TV → Worker must remux MKV → HLS |
| Nothing plays | AVPlay/network issue → check `internet` privilege + URL reachability |

---

## Next (after PoC passes)

1. Package the **full Mavero web app** as a static SPA `.wgt` (separate build
   config — the deployed web app is not modified).
2. Replace the TV player with an **AVPlay adapter** (addon source → AVPlay).
3. **Source-switch overlay** (list every addon source → AVPlay re-open).
4. **Embed iframe** as the secondary fallback.
5. Full **D-pad navigation** across the app (arrow-key focus system).
