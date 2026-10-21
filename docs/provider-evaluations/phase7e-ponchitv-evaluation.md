# MAVERO Phase 7E — PonchiTV Fresh Evaluation

## Initial findings

The current canonical service discovered from fresh search and direct access is `https://www.ponchitv.xyz/`. The site brands itself as PONCHI[TV] in the page title and footer, while the footer states that the service pulls streams from third-party providers.

The live homepage exposes TMDB-style numeric movie and TV identifiers in its current links. Examples captured from the live page include:

| Content | Current route example |
|---|---|
| Movie watch | `https://www.ponchitv.xyz/watch/movie/1054867` |
| TV watch, S01E01 | `https://www.ponchitv.xyz/watch/tv/120089/1/1` |
| Movie detail | `https://www.ponchitv.xyz/movie/155` |
| TV detail | `https://www.ponchitv.xyz/tv/95350` |

The current public watch page `https://ponchitv.xyz/watch/tv/630bd3c48ecf1b3970a17a98c6ecced8%3Afbb864c01fc7af1397f06a1a51b01843` renders a page titled Video Player with a Server control, but that route uses a non-TMDB encoded identifier and is not sufficient to establish the current deterministic route contract by itself. The current homepage links are the stronger fresh evidence for numeric TMDB-style watch routes.

The current TV detail page `https://www.ponchitv.xyz/tv/65942` loads episode metadata and a Play Now action, confirming TV and episode support at the application level. Actual provider playback and exact iframe behavior remain to be tested before implementation.

No provider registry, source registry, resolver, migration, or frontend production code has been changed for PonchiTV at this checkpoint.

## Direct movie-route check

The exact current movie route `https://www.ponchitv.xyz/watch/movie/1493400` loaded the PonchiTV application shell and displayed Back and Server controls. The main player region remained blank/white after waiting; no server-specific provider player, video controls, or actual movie playback became visible in the browser. The route did not show an explicit application error in the extracted page content.

## Movie server and player check

The current PonchiTV movie Server selector exposes five provider-owned choices. Server 1 is described as `ZXC[STREAM] Main Server`; Server 2 as `Main Backup Server`; Server 3 as a fast movie-limited server; Server 4 as a 4K/ads server; and Server 5 as a reliable ads server. The page also exposes a Sandbox (Adblocker) switch and warns that some servers require Sandbox Off.

Selecting Server 1 on the movie route displayed a provider-owned Camp Rock 3 player surface with artwork and a buffering notice, but no visible native playback controls or confirmed moving video was observed at the checkpoint. PonchiTV’s page therefore functions as a server-selection application that embeds or loads other provider servers rather than as a single clearly identified deterministic stream provider.

## Confirmed movie playback

After selecting Server 1 and using the provider-owned play control, the visible player time advanced from `0:00` to `0:11 / 1:32:22`, confirming actual movie playback for Camp Rock 3 through PonchiTV Server 1 in the current browser session. PonchiTV’s player controls and Settings control were visible.

The server sheet exposes a Sandbox (Adblocker) switch and states that some servers require Sandbox Off. Server 1 is marked recommended and has `sandboxSupport: false` in the current client route configuration, so the current server/sandbox relationship is provider-controlled and must not be copied into separate MAVERO sources without an explicit provider contract decision.

Sandbox Off was toggled through PonchiTV’s own provider control while Server 1 was selected. The provider server sheet remained open and no explicit error was shown; the player had been confirmed playing before opening the sheet. Because PonchiTV owns the server selection and sandbox behavior, this is recorded as a provider-controlled setting rather than a MAVERO policy change.

## TV S01E01 check

The exact current TV route `https://www.ponchitv.xyz/watch/tv/95350/1/1` loaded the PonchiTV player shell and the same five-server selector. The underlying provider queue showed `Aquarius I — No Video Found` while `Orion II` was checking and other provider entries remained queued. The route reached the provider-side server-selection state, but no verified S01E01 video playback was established at this checkpoint.

Selecting PonchiTV Server 1 for Lanterns S01E01 did not produce a playable episode. After waiting, Aquarius I and Orion II displayed `No Video Found`; Berkas III remained `Connecting...`, and the remaining provider entries remained queued. The player did not expose an episode timeline or play control, so actual TV playback was not verified.

A second released TV test, Game of Thrones S01E01 at `https://www.ponchitv.xyz/watch/tv/1399/1/1`, reached the PonchiTV provider queue. Aquarius I was checking, with Orion II and other providers queued. Actual episode playback still required a server selection and had not yet been established at this checkpoint.

For the released Game of Thrones S01E01 route, PonchiTV Server 1 reached a provider-owned paused player shell showing the episode title and synopsis. No visible timeline, play control, or advancing episode time appeared during the checkpoint, so actual TV playback remained unverified. This contrasts with the confirmed movie Server 1 playback and indicates PonchiTV’s current TV behavior is server/title dependent.

## Adapter decision and final suitability

PonchiTV is not a single deterministic embed provider in the current implementation. Its watch route is a full application shell that constructs and selects five internal third-party server URLs, including `zxcprime.xyz`, `vidup.to`, `player.videasy.net`, and `vidsrc.xyz`. The current route bundle explicitly owns server selection and a Sandbox (Adblocker) control. Embedding the PonchiTV shell as a generic MAVERO source would delegate the user experience and playback to a third-party aggregator rather than to a stable PonchiTV provider endpoint; modeling the internal servers separately would violate the requested scope and duplicate unrelated provider integrations.

The generic MAVERO template adapter can mechanically expand the numeric movie and TV routes, but technical suitability is not established because TV episode playback was not verified for either Lanterns S01E01 or Game of Thrones S01E01. The movie Server 1 did play after normal user interaction, but the TV route remained provider-queue/paused with no confirmed advancing episode time. No dedicated adapter is justified or implemented.

The current allowed origin for the PonchiTV application shell is `https://www.ponchitv.xyz`. The provider-owned Sandbox control documents that some internal servers require Sandbox Off; there is no single stable PonchiTV sandbox policy that MAVERO could safely register. The exact movie and TV watch responses returned HTTP 200 HTML, and no `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` header was observed in the top-level response. This does not establish that every internal provider iframe is frameable.

### Final classification

**Provider-side limitation.** PonchiTV’s current movie Server 1 playback was confirmed, but TV episode playback was not reliably verified and the service is an aggregator application with provider-controlled server and sandbox behavior. Per the task’s stop condition, no PonchiTV implementation, migration, registry entry, test, deployment, or commit is created. Existing MAVERO providers remain unchanged.

### References

[1]: https://www.ponchitv.xyz/ "Current PonchiTV canonical homepage"
[2]: https://www.ponchitv.xyz/watch/movie/1493400 "Current PonchiTV movie watch route"
[3]: https://www.ponchitv.xyz/watch/tv/95350/1/1 "Current PonchiTV Lanterns TV watch route"
[4]: https://www.ponchitv.xyz/watch/tv/1399/1/1 "Current PonchiTV Game of Thrones TV watch route"
[5]: https://www.ponchitv.xyz/tv/65942 "Current PonchiTV TV detail and episode page"
