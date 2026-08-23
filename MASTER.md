# MAVERO Editorial Streaming Design System

## Visual thesis
Mavero is an editorial streaming space: **ink-black and warm charcoal surfaces, soft ivory type, warm amber for intent, and pale mint for trust and progress**. Typography uses a high-contrast editorial serif for hero and page titles paired with a quiet geometric sans for navigation, metadata, and controls. Layouts are airy but information-rich, built on a 4px base rhythm with generous section separation, medium rounded corners, and hairline borders. Content is always the hero; chrome stays calm.

## Interaction thesis
Interactions are **fast and quiet**: 160ms for controls, 260ms for cards, and up to 520ms for page-level reveals. Hover uses a subtle lift, border illumination, and image scale rather than bounce. Scroll reveals are opacity and translate-only, with no layout animation. Mobile uses touch-sized targets and horizontal rails; desktop uses a persistent sidebar and denser grids. Reduced motion disables transforms and nonessential reveals.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#F5F1E8` | Primary text and high-emphasis content |
| `--ink-soft` | `#C9C6BE` | Body copy and secondary labels |
| `--muted` | `#8E8D8A` | Supporting copy and inactive navigation |
| `--muted-deep` | `#5D605F` | Metadata, captions, utility text |
| `--base` | `#090A0B` | Global page background |
| `--base-lift` | `#0F1112` | Raised page layers |
| `--surface` | `#141617` | Cards, panels, and navigation surfaces |
| `--surface-2` | `#1A1C1D` | Hover and nested surface |
| `--surface-raised` | `#222525` | Active or elevated surface |
| `--line` | `rgba(245, 241, 232, .10)` | Default borders |
| `--line-strong` | `rgba(245, 241, 232, .20)` | Focus and stronger separators |
| `--accent` | `#D8A34E` | Primary action and editorial highlight |
| `--accent-strong` | `#F0BE68` | Hover, active, and rating emphasis |
| `--accent-soft` | `rgba(216, 163, 78, .14)` | Amber tint surfaces |
| `--secondary` | `#A9D0BF` | Progress, operational success, and trust |
| `--secondary-soft` | `rgba(169, 208, 191, .13)` | Mint tint surfaces |
| `--success` | `#A9D0BF` | Healthy / synced state |
| `--warning` | `#E2B170` | Warnings and degraded states |
| `--danger` | `#E78C8D` | Errors and destructive actions |

## Typography

The display family is `Cormorant Garamond`, used for hero and page titles with strong contrast and generous line-height. The interface family is `Manrope`, used for body, controls, cards, and navigation. `DM Mono` is reserved for metadata, system labels, and technical status. Display scale is fluid from 2.8rem on mobile to 6.8rem on large desktop. Body copy stays between .78rem and .98rem with 1.55–1.75 line-height.

## Layout

The desktop shell uses a 240px navigation rail and a content canvas capped at 1480px. Mobile collapses to a fixed bottom navigation with four primary destinations and a compact top utility bar. The responsive breakpoints are 375px, 640px, 900px, and 1440px. Content grids use `repeat(auto-fill, minmax())`, while editorial rails use horizontal scroll with snap points and hidden scrollbars.

## Components

Buttons use 10px radius, 44px minimum height, and clear five-state treatment: default, hover, focus, active, and disabled. Cards use 14px radius, image-led hierarchy, and a mint/amber progress marker. Panels use 16px radius and hairline borders rather than heavy shadows. Empty and error states remain useful and action-oriented. Pagination is a quiet utility bar with explicit page state, disabled affordances, and preserved URL filters.

## Motion tokens

| Token | Value |
| --- | --- |
| `--motion-fast` | `160ms` |
| `--motion-normal` | `260ms` |
| `--motion-slow` | `520ms` |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` |

Use opacity and transforms only for motion. Never animate width, height, or layout-dependent properties. Respect `prefers-reduced-motion: reduce` globally.
