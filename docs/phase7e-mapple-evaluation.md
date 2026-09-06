# MAVERO Phase 7E — Mapple Audit

## Scope

This task implements only Mapple as the next experimental MAVERO provider. Existing Vidsrc, VidLink, Peachify, RiveStream, Nxsha, and NHDAPI integrations remain unchanged. No Phase 7F work, download, API-key integration, proxying, cross-origin manipulation, or provider-security bypass is included.

## Verified public endpoints

The current Mapple site is reachable at [mapple.uk](https://mapple.uk). The specified movie path [https://mapple.uk/watch/movie/550](https://mapple.uk/watch/movie/550) renders a Mapple movie watch page for Fight Club. The specified TV path [https://mapple.uk/watch/tv/1399-1-1](https://mapple.uk/watch/tv/1399-1-1) renders a Mapple TV watch page for Game of Thrones S01E01. The public pages expose provider-owned controls such as Back, Save, Party, Chat, Server, and Info, which is consistent with an iframe/embed-style integration.

## Adapter decision

The existing generic template adapter is sufficient because both Mapple URLs are deterministic and use the supported `{tmdb_id}`, `{season}`, and `{episode}` placeholders:

```text
Movie: https://mapple.uk/watch/movie/{tmdb_id}
TV:    https://mapple.uk/watch/tv/{tmdb_id}-{season}-{episode}
```

The source will use `integration_type = 'template'`, `result_type = 'embed'`, `identifier_mode = 'tmdb_id'`, and exact `allowed_embed_origins = ['https://mapple.uk']`. Anime remains disabled initially.

## Sandbox decision

The migration will start with the existing required sandbox policy as the safe default. Browser verification will explicitly test Sandbox On and Sandbox Off. If Mapple requires a different setting for actual playback, only the Mapple provider/source configuration will be adjusted to the minimum existing policy supported by MAVERO; global sandbox behavior will not change.

## Proposed registry state

The provider and source will be named `mapple` and `mapple-embed`, marked `experimental`, seeded with ordering `140`, and disabled by default. NHDAPI remains at the existing prior ordering; no unrelated provider records will be changed.

## References

[1]: https://mapple.uk/ "Mapple official public site"
[2]: https://mapple.uk/watch/movie/550 "Mapple movie watch endpoint"
[3]: https://mapple.uk/watch/tv/1399-1-1 "Mapple TV episode watch endpoint"
