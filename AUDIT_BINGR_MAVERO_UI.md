# Bingr reference and MAVERO UI audit

## Reference observations

Source: https://bingr.one/home, extracted 2026-08-20.

Bingr presents a dark, content-first streaming home with a large featured hero followed by distinct vertical content sections. The home content hierarchy is simple: featured title, rating/year/type metadata, synopsis, a compact See More action, then movie and series rails. The reference uses recognizable current titles and imagery rather than abstract fixture artwork. Its mobile inspiration shows a persistent floating bottom navigation with icon-only destinations, large poster cards in a two-column grid, section headings with rounded View All actions, and a low-noise black background.

The reference player inspiration uses a provider-owned playback surface, compact source/server selection above the player, and no duplicate outer playback controls. Provider controls remain inside the embed. The surrounding shell should only own navigation, source selection, retry/change-source actions, and a viewport orientation action.

## MAVERO requirements from user

1. Preserve MAVERO Design DNA: cinematic dark UI, warm ivory text, electric-violet accent.
2. Reorganize the streaming/watch UI into a clean responsive structure inspired by Bingr, without copying its full design or architecture.
3. When the selected provider owns the player, remove MAVERO PlayerControls completely. Do not render duplicate play, timeline, volume, quality, or fullscreen controls around the provider embed.
4. Preserve the landscape/orientation button. It should rotate/expand the app/player shell for portrait and landscape use.
5. Provider embeds must fit cleanly in portrait and landscape. The provider iframe should occupy the responsive viewport without extra black/empty regions caused by the outer MAVERO control shell.
6. Keep source selection and provider error/retry UI, but organize them outside the provider player.
7. Do not begin Phase 7E.
