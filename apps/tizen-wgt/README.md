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
├── config.xml     Tizen web app manifest (TV profile, internet, hwkey-event)
├── index.html     Source-list UI (D-pad)
├── app.js         AVPlay player + key handling  ← the thing under test
├── icon.png       launcher icon (512×512)
└── README.md      this file
```

---

## Build the `.wgt` (a `.wgt` is just a ZIP with `config.xml` at the root)

### Windows (you)
1. Open the `apps/tizen-wgt` folder.
2. Select **all files inside it** (`config.xml`, `index.html`, `app.js`,
   `icon.png`) — **not** the folder itself.
3. Right-click → **Send to → Compressed (zipped) folder**.
4. Rename the resulting `.zip` to **`MaveroTV.wgt`** (extension change to `.wgt`).

> Important: `config.xml` must be at the **root** of the zip. If you zip the
> folder itself you'll get `tizen-wgt/config.xml` and the TV will reject it.

### Linux / macOS
```bash
cd apps/tizen-wgt
zip -r ../MaveroTV.wgt config.xml index.html app.js icon.png
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
- The **MKV** entries should start playing (AVPlay). The status bar at the
  bottom shows `Playing: <url>` or an `AVPLAY ERROR: …` message.
- **Back** stops playback and returns to the list; **Back** again exits.

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
