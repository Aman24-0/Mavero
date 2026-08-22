# MAVERO Design System V2

## Product character

MAVERO is a private screening room for discovering and watching movies, series, and anime. The interface should feel **cinematic, premium, international, minimal, fast, and memorable**. It should guide attention through a clear sequence: brand orientation, one story worth watching, one primary action, supporting context, then editorial rails.

## Design DNA

| Dimension | MAVERO V2 direction |
|---|---|
| Mood | Quiet after midnight: atmospheric, confident, editorial, never loud. |
| Composition | Wide cinematic fields, asymmetric focal points, disciplined negative space, and layered depth used only to support hierarchy. |
| Surface language | Deep charcoal surfaces with occasional translucent graphite panels; artwork and spacing carry more weight than borders. |
| Brand signal | Ivory type, electric amber action color, and a small signal/coordinate vocabulary that makes the product recognizable without becoming decorative noise. |
| Imagery | Strong artwork with controlled saturation, dark readability overlays, and gentle crop movement on interaction. |

## Tokens

### Color

| Role | Token | Value / intent |
|---|---|---|
| Base | `--base` | `#090A0C`, the obsidian canvas. |
| Base lift | `--base-lift` | `#0F1115`, used behind hero and shell transitions. |
| Surface | `--surface` | `#15171C`, restrained graphite cards. |
| Raised surface | `--surface-raised` | `#1D2026`, focused/hovered grouping. |
| Primary text | `--ink` | `#F4F1EA`, soft ivory instead of pure white. |
| Secondary text | `--ink-soft` | `#D2D0C9`, synopsis and supportive copy. |
| Muted text | `--muted` | `#9A9CA3`, secondary controls and metadata. |
| Quiet text | `--muted-deep` | `#686D75`, labels and inactive indicators. |
| Accent | `--accent` | `#D6A35D`, controlled electric amber for action and focus. |
| Accent strong | `--accent-strong` | `#F0C27F`, active and hover emphasis. |
| Accent wash | `--accent-soft` | `rgba(214,163,93,.13)`, selected surfaces only. |
| Secondary atmosphere | `--secondary` | `#8FB0A7`, cool counterpoint for quiet signal details. |
| Borders | `--line`, `--line-strong` | Low-contrast grouping and focus boundaries only. |
| State | `--success`, `--warning`, `--danger` | Muted green, amber, and coral states with text labels where needed. |

### Typography

`Manrope` is the interface and body face. `Space Grotesk` is reserved for the wordmark, hero title, and section titles. `DM Mono` remains a small MAVERO signal language for eyebrow labels and compact metadata, never for long-form content.

| Level | Treatment |
|---|---|
| Hero title | `clamp(2.65rem, 6.2vw, 6.4rem)`, tight line-height, negative tracking, maximum two lines. |
| Section title | `1.15rem–1.55rem`, semibold, tight tracking. |
| Body | `0.9rem–1rem`, line-height `1.6–1.75`, controlled line length. |
| Metadata | `0.58rem–0.7rem`, readable uppercase/small signal labels. |
| Controls | `0.7rem–0.82rem`, semibold, high contrast, comfortable touch targets. |

### Spacing, shape, and elevation

The spacing rhythm is based on 4px increments: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 20px`, `--space-6: 24px`, `--space-8: 32px`, `--space-10: 40px`, `--space-14: 56px`, and `--space-18: 72px`. Public content uses responsive side padding from 16px on small screens to 72px on large screens.

The radius system is restrained: `--radius-sm: 10px` for controls, `--radius-md: 14px` for cards, `--radius-lg: 22px` for grouped surfaces, and `--radius-xl: 30px` for hero frames. Elevation is soft and broad: `--shadow-sm` for cards and `--shadow-lg` for the hero focal surface. Borders are never used as a default outline around every element.

## Component language

Buttons use one clear primary action with amber fill and dark text, plus a quiet secondary outline or translucent surface. Cards are image-forward, with a subtle accent edge, calm default state, contained hover lift, and visible keyboard focus. Continue Watching uses stronger progress visibility; discovery rails use lighter metadata. No action depends on hover alone.

The desktop shell uses a compact integrated header with a restrained active underline. Mobile uses the existing bottom navigation as a first-class part of MAVERO, with safe-area padding, readable labels, and a single accent signal for the active destination. The player, authentication, provider, and admin architectures retain their existing behavior and boundaries.

## Motion language

MAVERO motion is purposeful and interruptible. Hero scene transitions use a deliberate crossfade with a slight directional drift, under one second. Page entry is a short opacity/vertical reveal. Card hover uses a small lift and image scale. Buttons confirm input with a brief scale response. Skeleton shimmer is low contrast. `prefers-reduced-motion` disables non-essential transforms and autoplay while leaving content and controls fully available.

## Responsive compositions

Mobile is composed independently: portrait-first hero artwork, copy below the image, no overlapping decorative cards over text/actions, touch-sized controls, and horizontal rails with a visible partial next card. Tablet keeps the cinematic focal point while reducing density. Desktop uses a wide art frame with an asymmetric copy panel and a compact slide rail, allowing the artwork to breathe without leaving unexplained empty space.

## Quality gates

Every Discover revision must be checked at 390×844, tablet width near 768px, and 1440×900. The page must have no horizontal overflow, clipped actions, text collision, inaccessible controls, accidental playback, or layout jump. Visual QA must inspect hierarchy, crop, typography, spacing, controls, rail rhythm, navigation clearance, and reduced-motion behavior rather than relying on build success alone.
