# MAVERO Modern Streaming Design System

## New visual thesis
Mavero is a **content-first streaming application**, not an editorial publication. The visual identity comes from cinematic backdrops, poster artwork, layered dark surfaces, and confident product chrome. Typography is a modern sans-serif utility: clear, compact, and subordinate to the content. The interface uses near-black and blue-charcoal surfaces, one electric violet action accent, and a quiet teal secondary signal for progress and system health. Cards and panels are moderately rounded, bordered with restraint, and composed on a precise 8px rhythm.

## Interaction thesis
Interactions are fast and purposeful: 140ms controls, 220ms card states, and 420ms page reveals. Hover and press states use a subtle lift, image scale, and accent border. Carousels keep the active title dominant with minimal supporting context and no random rotation or physical card pile. Mobile is a purpose-built single-column experience with a fixed bottom navigation, swipe-friendly rails, compact controls, and touch targets of at least 44px. Motion uses opacity and transforms only, and all nonessential animation respects reduced motion.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#F8FAFC` | Primary text |
| `--ink-soft` | `#C6CBD5` | Body copy |
| `--muted` | `#8B93A1` | Secondary copy and inactive labels |
| `--muted-deep` | `#596170` | Metadata and utility text |
| `--base` | `#0A0C10` | Global background |
| `--base-lift` | `#0F1218` | Elevated canvas |
| `--surface` | `#151923` | Cards and panels |
| `--surface-2` | `#1B202C` | Hovered or nested surface |
| `--surface-raised` | `#242A38` | Active surface |
| `--line` | `rgba(248, 250, 252, .09)` | Default border |
| `--line-strong` | `rgba(248, 250, 252, .18)` | Strong border and focus |
| `--accent` | `#8B5CF6` | Primary action and active navigation |
| `--accent-strong` | `#A78BFA` | Highlight and hover |
| `--accent-soft` | `rgba(139, 92, 246, .16)` | Accent surface |
| `--secondary` | `#55D6C2` | Progress, success, and health |
| `--secondary-soft` | `rgba(85, 214, 194, .13)` | Teal tint surface |
| `--success` | `#55D6C2` | Operational success |
| `--warning` | `#F5B96B` | Warnings |
| `--danger` | `#F37F8B` | Errors and destructive states |

## Typography

Use `Manrope` for the full product UI with `Space Grotesk` as a restrained display face for page titles and high-impact numeric values. Do not use serif typography. Hero titles cap at 4.8rem on large screens and 2.4–3.2rem on phones so the artwork and title read as one composition. Body text remains between .78rem and .95rem, with 1.55–1.7 line-height. `DM Mono` is reserved for metadata and system labels.

## Layout and responsive behavior

Desktop uses a 232px persistent navigation rail and a content canvas that expands up to 1520px. The top utility bar remains compact and aligned with the canvas. At 900px the shell becomes a single canvas with a compact top bar, and at 640px it becomes a phone-first layout with a fixed bottom navigation. Poster rails use horizontal scrolling and snap points; collection grids use auto-fill with a minimum card width so they remain usable from 375px through 1440px.

## Components

Buttons have 10px radius and a 44px minimum height. Cards are image-first with a 14px radius, short metadata, optional rating badge, and progress bar. Hero content is embedded in the hero composition, never repeated in a separate title block. Panels use moderate rounding, thin borders, and shallow shadows. Empty states are compact and actionable. Filters and pagination remain compact utility controls that preserve URL state.

## Motion

| Token | Value |
| --- | --- |
| `--motion-fast` | `140ms` |
| `--motion-normal` | `220ms` |
| `--motion-slow` | `420ms` |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` |

Animate opacity and transforms only. Avoid random rotation, excessive physical stacking, layout-property animation, and large decorative transitions.
