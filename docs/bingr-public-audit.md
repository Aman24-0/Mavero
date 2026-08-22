# Bingr public behavior audit

Audit date: 2026-08-22

The public movie route `https://bingr.one/watch/movie/1493400` returned only a short loading/projectionist message through text extraction, and the sandbox browser navigation did not produce an accessible page. This does not establish a usable movie stream result.

The public TV route `https://bingr.one/watch/tv/95350/1/1` returned a rendered textual page containing settings, episode metadata for Lanterns Season 1, quality choices (`1080p`, `720p`, `480p`), audio choices, subtitle choices, and a server list including Bingr, Sirius, DarkMatter, Quasar, Apollo, Miller, Mann, Edmunds, Luna, and Aditya. The returned content did not include a directly usable normalized media URL or a verified public server identifier contract.

This audit is passive only. No login, CAPTCHA, DRM, anti-bot, paywall, geo, access-control, token, credential, or cross-origin bypass was attempted. The implementation should treat the Bingr target as unresolved until a legitimate public media candidate and public resolution contract can be observed.


The isolated generic resolver probe was run against both target URLs. The movie and TV requests completed without a resolver crash, but both produced `candidatesFound: 0`, `finalStreamCount: 0`, and no resolver attempts. Therefore, the current accessible responses do not prove a normalized usable stream for either target. Bingr remains unsupported by the generic foundation at this milestone; no Bingr-specific adapter was added because no legitimate public media reference or verified public stream API contract was observed.
