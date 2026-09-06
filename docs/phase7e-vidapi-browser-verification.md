# VidAPI.tw and VidAPI.qzz.io Browser Verification

## Deployment under test

MAVERO deployed URL: `https://mavero1.netlify.app`.

Netlify deploy under test: `6a88952e0419484239088e07`.

Both VidAPI providers and sources were temporarily enabled in the Supabase registry for controlled browser verification. They must be restored to disabled-by-default after all checks.

## Movie route and Sources

Route: `https://mavero1.netlify.app/watch/movie/movie-1493400`.

The Sources drawer displayed both experimental template sources:

- `VidAPI.tw Embed` — experimental · template · sandbox: required
- `VidAPI.qzz.io Embed` — experimental · template · sandbox: required

The existing Vidsrc, VidLink, Peachify, RiveStream, Nxsha, NHDAPI, Mapple, CineSrc, VidPhantom, and YapGrid sources remained present and unchanged.

## VidAPI.tw movie checkpoint

Selecting VidAPI.tw entered the normal `Switching source…` / `Switching server` state and returned a provider-owned frame. Parent-DOM inspection confirmed:

- exact iframe URL: `https://vaplayer.ru/embed/movie/1493400`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible MAVERO resolver error text: none

The provider surface displayed a provider-owned `Playback blocked` state in the rendered frame. This is reported as provider behavior and was not bypassed.

## VidAPI.qzz.io movie checkpoint

Selecting VidAPI.qzz.io entered the normal switching/loading state and returned a provider-owned frame. Parent-DOM inspection confirmed:

- exact iframe URL: `https://vidapi.qzz.io/movie/1493400`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible MAVERO resolver error text: none

The frame rendered provider media controls inside the iframe. The user brief records that normal provider Play may redirect to `kettledroopingcontinuation.com`; any such redirect remains provider-controlled and is not intercepted or bypassed.

## Movie source switching

VidAPI.qzz.io → Vidsrc entered the existing switching state and returned to `https://vidsrc.wiki/embed/movie/1493400/` without stale qzz.io state or a MAVERO resolver error. The inverse Vidsrc → VidAPI.qzz.io transition entered the same switching state and returned to `https://vidapi.qzz.io/movie/1493400` with required sandbox `allow-forms allow-presentation allow-same-origin allow-scripts`, allow `autoplay; fullscreen; picture-in-picture`, and no visible MAVERO resolver error.

Actual movie playback is not claimed; personal user confirmation is required.

## TV S01E01 checkpoints

Route: `https://mavero1.netlify.app/watch/series/series-95350?season=1&episode=1`.

VidAPI.tw appeared in Sources and, when selected, entered the normal switching/loading state. Parent-DOM inspection confirmed:

- exact iframe URL: `https://vaplayer.ru/embed/tv/95350/1/1`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible MAVERO resolver error text: none

VidAPI.qzz.io appeared in Sources and, when selected, entered the normal switching/loading state. Parent-DOM inspection confirmed:

- exact iframe URL: `https://vidapi.qzz.io/tv/95350/1/1`
- sandbox: `allow-forms allow-presentation allow-same-origin allow-scripts`
- allow: `autoplay; fullscreen; picture-in-picture`
- visible MAVERO resolver error text: none

## Server navigation

With VidAPI.qzz.io active on the TV route, Previous Server entered `Switching source…` / `Switching server` and returned a resolved Vaplayer frame (`https://vaplayer.ru/embed/tv/95350/1/1`) with no MAVERO resolver error. Next Server then entered the same switching state and returned to `https://vidapi.qzz.io/tv/95350/1/1` with no MAVERO resolver error. This confirms the two VidAPI sources participate in MAVERO’s source ordering without exposing provider-internal servers as MAVERO sources.

VidAPI.tw → Vidsrc entered the existing switching state and returned to `https://vidsrc.wiki/embed/tv/95350/1/1/` without stale Vaplayer state or a MAVERO resolver error. The reverse Vidsrc → VidAPI.tw transition entered the same switching state and returned to `https://vaplayer.ru/embed/tv/95350/1/1` with required sandbox `allow-forms allow-presentation allow-same-origin allow-scripts`, allow `autoplay; fullscreen; picture-in-picture`, and no visible MAVERO resolver error.

## Mobile checkpoint — VidAPI.tw

Two 390×844 captures were taken. The longer-budget capture reached the MAVERO PlayerShell and showed the compact title/episode header, Details, Episodes, Previous, Sources, Next, Sandbox, centered `Starting your stream` treatment, and previous/next episode controls without horizontal overflow. The provider area remained in `LOADING EMBED…` at capture time. This confirms mobile shell/layout behavior only; VidAPI.tw playback on mobile is not claimed.

## Mobile checkpoint — VidAPI.qzz.io

The 390×844 capture reached the MAVERO PlayerShell and showed the compact Lanterns/S01E01 header, Details, Episodes, Previous, Sources, Next, Sandbox, centered `Starting your stream` treatment, and episode navigation without horizontal overflow. The provider area remained in `LOADING EMBED…` at capture time. This confirms mobile shell/layout behavior only; VidAPI.qzz.io playback on mobile is not claimed.

## Sandbox and fullscreen

The required sandbox policy was confirmed on both VidAPI frames. On VidAPI.qzz.io TV, Sandbox Off preserved `https://vidapi.qzz.io/tv/95350/1/1` and removed the iframe `sandbox` attribute. The same user-facing Sandbox Off control on VidAPI.tw TV preserved `https://vaplayer.ru/embed/tv/95350/1/1` and removed its sandbox attribute. In both cases the `allow` attribute remained `autoplay; fullscreen; picture-in-picture`.

The existing MAVERO Landscape control was exercised with VidAPI.qzz.io active. Parent-page inspection reported `document.fullscreenElement === true`, fullscreen element `DIV`, `screen.orientation.type === "landscape-primary"`, and a 5120×4400 fullscreen viewport. Escape exited cleanly with `document.fullscreenElement === false`; the provider iframe URL remained active. No provider-specific fullscreen implementation was added.

## Final registry state

After the controlled verification, Supabase was restored and verified with both provider and source rows disabled:

| Provider | Provider enabled | Source | Source enabled | Ordering |
|---|---:|---|---:|---:|
| `vidapi-tw` | `false` | `vidapi-tw-embed` | `false` | `180` |
| `vidapi-qzz` | `false` | `vidapi-qzz-embed` | `false` | `190` |

Actual TV playback is not claimed; personal user confirmation is required.
