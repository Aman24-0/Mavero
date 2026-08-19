# MAVERO Design DNA

## Design system

| Dimension | Direction |
|---|---|
| Base palette | Obsidian `#08090b`, carbon `#101216`, graphite `#191c22`, warm ivory `#f1eee8`, muted ash `#9a9da6` |
| Accent | A single electric violet accent `#9b87f5` used for primary action, active navigation, and progress; no multicolor gradients |
| Typography | Display: `Manrope`/system sans with strong weight contrast; body: clean system sans; headings use balanced wrapping, copy uses readable measure |
| Spacing | 4px base rhythm; generous 24–32px section padding; 72px desktop shell gutter; 20px mobile gutter |
| Layout | 12-column desktop content grid; max-width 1440px; cinematic hero edge-to-edge inside shell; content rails use snap scrolling |
| Shape | 18px card radius, 12px controls, 999px pills; minimal borders using low-contrast graphite only |
| Elevation | Layered black surfaces, subtle Tailwind shadow scale, no decorative glow as primary affordance |
| Imagery | Strong artwork, dark overlays derived from content image, portrait cards with consistent aspect ratio, lazy loading |
| Motion | Ease-out, 120–180ms interaction feedback, 450–700ms page/hero choreography; transforms and opacity only |
| Accessibility | Visible focus rings, semantic buttons/links, `aria-label` on icon-only controls, reduced-motion mode, touch targets >= 44px |

## Design style

MAVERO should feel like a private screening room: cinematic, confident, quiet, and modern. The visual language uses deep negative space, tactile poster cards, warm ivory typography, and a single violet signal for action. It should feel original rather than imitating Netflix, Prime, Disney+, or a generic movie database.

The composition is intentionally asymmetrical in the hero, with content metadata anchored near the lower left and a restrained floating “signal” control on the opposite side. Content rails establish rhythm without making the page feel like a dense catalog. Empty states are calm and editorial, with one clear next action.

## Visual effects

| Effect | Implementation | Intensity |
|---|---|---|
| Hero image entrance | GSAP opacity + translateY only; paused when hero is off-screen | Medium |
| Card hover | CSS transform scale and translateY with ease-out | Low |
| Scroll reveal | IntersectionObserver + GSAP timeline for section headings and rails | Medium |
| Poster highlight | Small transform/opacity treatment; no large blur or backdrop-filter | Low |
| Shell background | Static radial texture generated with CSS color fields; not animated | Low |
| Reduced motion | Disable GSAP entrance and card transforms when `prefers-reduced-motion` is set | Required |

## UI architecture

- `AppShell`: responsive frame, page background, header, route content, bottom navigation.
- `TopBar`: wordmark, primary navigation, search affordance, profile affordance.
- `MobileBottomNav`: exactly Discover, Search, Profile; safe-area aware.
- `HeroBanner`: featured title, metadata, description, primary watch action, secondary detail action.
- `ContentRail`: section title, context label, arrow controls, horizontal snap track.
- `MediaCard`: poster, hover/focus treatment, metadata, progress bar, optional signal tag.
- `FilterBar` / `FilterSheet`: desktop toolbar and mobile bottom sheet using the same state model.
- `SearchResults`: grouped by movie/series/anime with debounce and empty states.
- `DetailHero`: poster, backdrop, metadata, action row, recommendations.
- `PlayerShell` / `PlayerGuard`: first-party control shell around direct playback or authorized embeds.
- `ProfileSection`: continue watching, favorites, history, preferences, CineLog CTA.
- `AdminShell`: denser but consistent management UI with provider/source/category modules.

## Interaction heuristics

- Use progressive disclosure: show the primary watch intent first, secondary metadata on demand.
- Keep one accent per view; use neutral status colors only for health semantics.
- Never rely on hover for essential actions; mobile cards open on tap.
- Use structural skeletons for loading rather than blank regions.
- Place validation/errors next to the triggering action.
- Use a confirmation dialog for destructive admin actions.
- Respect safe-area insets for fixed mobile navigation and player controls.
- Use fixed z-index layers: base 0, shell 10, sticky header 20, overlay 30, dialog 40, toast 50.

## Motion implementation plan

GSAP will be loaded only where a timeline or scroll choreography adds clear value. The initial implementation will prefer CSS transitions for local card feedback and GSAP for hero/section entrance sequences. Motion will animate only `transform` and `opacity`, use ease-out defaults, stay under 200ms for direct interaction feedback, and pause looping effects when off-screen. No custom cursor, particle field, noisy shader, or continuously animated full-screen surface will be introduced unless a later visual-quality review demonstrates real product value.

The requested GSAP skill directories were not present in the sandbox, so this document captures the applicable architecture and the implementation will use the official `gsap` package with Svelte lifecycle hooks rather than inventing unsupported skill APIs. The requested Impeccable-style baseline is represented through the registry’s baseline-ui guidance: default Tailwind tokens, no gradients, no arbitrary z-index scale, balanced text, reduced motion, safe areas, and accessible icon buttons.
