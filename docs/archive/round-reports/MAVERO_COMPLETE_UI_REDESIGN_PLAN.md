# MAVERO --- Complete UI Redesign Plan

**Project:** Mavero\
**Redesign type:** Complete public UI redesign\
**Status:** Planning / Ready for implementation\
**Design direction:** Adaptive Cinematic Glass\
**Reference:** Approved visual reference supplied by the user on
2026-09-27

------------------------------------------------------------------------

## 1. Redesign Decision

This is a **complete UI redesign**.

The previous Cyberpunk/green visual system is **not being preserved as
the visual foundation**. The new system should be implemented as a
coherent replacement, while the existing application architecture,
business logic, playback logic, data contracts, authentication,
analytics, downloader, and other proven functionality should remain
intact unless a UI change genuinely requires an interface adjustment.

The goal is not to gradually decorate the old UI.

The goal is to build a new visual language and then migrate the
application **page by page**, validating every component and interaction
as it enters the new system.

### Core visual direction

**Adaptive Cinematic Glass**

1.  Artwork is the visual environment.
2.  Glass is the interface layer.
3.  Typography and spacing provide hierarchy.
4.  The active title determines the accent palette.
5.  Mavero's identity comes from its logo, typography, layout language,
    iconography, motion, and component design---not from a permanently
    fixed green accent.

------------------------------------------------------------------------

# 2. Reference Image --- Design Principles

The approved reference establishes the following principles.

## 2.1 Artwork-driven environment

The hero artwork should influence the surrounding visual atmosphere.

The page should feel as though the current movie/show has temporarily
taken over the application.

Example:

``` text
Dune artwork
    ↓
warm brown / orange / dark red palette
    ↓
atmospheric background
    ↓
warm translucent glass
    ↓
amber/orange accent
```

A blue sci-fi title should produce a cooler environment, while a red
title should produce a darker red/burgundy environment.

## 2.2 Dynamic accent

The green accent is no longer a permanent global accent for the consumer
UI.

The active artwork should determine the accent.

The system must safely derive:

-   primary accent
-   secondary accent
-   dark atmospheric color
-   soft atmospheric color
-   glass tint
-   glow color
-   readable foreground color

The accent must be contrast-safe and must never be applied blindly from
a raw image color.

## 2.3 Glass is a layer, not the whole design

Do not turn every surface into a glass card.

Use glass selectively for:

-   navigation
-   floating controls
-   search surfaces
-   tabs
-   important metadata groups
-   selected controls
-   mobile dock
-   contextual panels

Poster cards should remain primarily artwork-driven.

## 2.4 Dark cinematic foundation

The application still needs a dark foundation so that artwork and
typography remain readable.

The new design should not become a bright colorful application.

Target visual balance:

-   roughly 70% dark/neutral cinematic environment
-   roughly 20% translucent/glass surfaces
-   roughly 10% active accent

These are design targets, not rigid numerical CSS requirements.

------------------------------------------------------------------------

# 3. Non-Goals

The redesign must NOT:

-   rewrite playback architecture
-   rewrite progress/resume architecture
-   rewrite authentication
-   rewrite analytics
-   rewrite downloader logic
-   rewrite source/provider resolution
-   replace working data contracts without need
-   introduce unnecessary product features
-   copy another streaming application's UI one-to-one
-   make every element glow
-   use neon green as a permanent consumer accent
-   make every surface a glassmorphism panel
-   create a second parallel component system that duplicates existing
    functionality

The redesign is primarily a **presentation-system replacement and page
migration**.

------------------------------------------------------------------------

# 4. Implementation Strategy

## Critical rule

**Do NOT redesign the entire application in one pass.**

Every major page must be redesigned independently and brought into the
new system one at a time.

The reason is visual refinement.

Each page should allow us to inspect:

-   spacing
-   typography
-   glass opacity
-   border treatment
-   artwork treatment
-   accent behavior
-   button hierarchy
-   card proportions
-   mobile behavior
-   desktop behavior
-   transitions
-   component blending

before the next page is migrated.

## Migration model

``` text
New foundation
      ↓
Theme engine
      ↓
Global shell
      ↓
Discover/Home
      ↓
Detail
      ↓
Search
      ↓
My List
      ↓
Continue Watching
      ↓
Account/Profile
      ↓
Settings
      ↓
Watch/Player chrome
      ↓
TV / Large Screen
      ↓
Remaining secondary pages
      ↓
Global polish
```

A phase may contain multiple commits, but each page should be completed
and visually validated before moving to the next page.

------------------------------------------------------------------------

# 5. New UI System Architecture

The new UI should be based on a small number of reusable primitives.

## 5.1 Theme Layer

Conceptual variables:

``` text
--theme-primary
--theme-secondary
--theme-bg
--theme-bg-soft
--theme-glass
--theme-glass-strong
--theme-glass-soft
--theme-border
--theme-border-strong
--theme-glow
--theme-foreground
--theme-foreground-muted
--theme-button
--theme-button-foreground
```

Exact names may follow the existing project conventions.

## 5.2 Palette extraction

Preferred fallback chain:

``` text
active backdrop
    ↓
poster
    ↓
existing item accent
    ↓
neutral Mavero palette
```

The extraction layer must provide safe output even when:

-   artwork is missing
-   image loading fails
-   the image is extremely bright
-   the image is almost black
-   the image has very low saturation
-   extraction is unavailable during SSR
-   the user changes slides rapidly

## 5.3 Contrast safety

The theme engine must:

-   clamp brightness
-   clamp saturation where necessary
-   preserve readable text
-   choose appropriate foreground color
-   avoid low-contrast CTA buttons
-   avoid making glass surfaces visually disappear
-   maintain accessibility requirements

## 5.4 Theme transition

When the active hero changes:

``` text
Theme A
   ↓
soft transition
   ↓
Theme B
```

Do not abruptly flash between unrelated colors.

The transition should be subtle and cinematic.

------------------------------------------------------------------------

# 6. Global Visual Language

## 6.1 Glass surfaces

Base glass:

``` text
dark translucent background
moderate backdrop blur
subtle white border
soft shadow
optional artwork-derived tint
```

Strong glass:

``` text
higher opacity
stronger blur
used for navigation and important overlays
```

Soft glass:

``` text
lower opacity
lighter visual weight
used for secondary controls
```

## 6.2 Borders

Borders should be subtle.

Avoid bright permanent green outlines.

Use:

-   low-opacity neutral border
-   theme-aware border where appropriate
-   stronger border only for active/focus state

## 6.3 Shadows

Prefer large soft shadows over neon glows.

Accent glow should be used sparingly.

## 6.4 Typography

Typography should create hierarchy through:

-   scale
-   weight
-   tracking
-   opacity
-   spacing

Do not compensate for weak hierarchy with color.

## 6.5 Radius

Use a consistent radius scale.

Do not give every element an oversized pill shape.

Pills are reserved for:

-   tags
-   compact filters
-   status indicators
-   selected controls
-   small metadata chips

------------------------------------------------------------------------

# 7. Phase 0 --- Audit, Baseline & Redesign Contract

### Objective

Create a precise baseline before implementation.

### Tasks

-   inspect current public routes
-   inspect current layout hierarchy
-   inspect shared UI components
-   inspect existing responsive behavior
-   inspect existing design tokens
-   inspect existing artwork/accent pipeline
-   identify components that can be restyled instead of replaced
-   identify duplicated/legacy visual systems
-   document pages requiring migration
-   capture baseline screenshots where practical
-   define acceptance criteria

### Deliverables

-   redesign plan
-   page inventory
-   component inventory
-   migration map
-   baseline notes
-   implementation worklog

### Gate

No visual implementation should begin until the implementation agent
understands which existing logic must remain untouched.

------------------------------------------------------------------------

# 8. Phase 1 --- Adaptive Theme Engine

### Objective

Build the foundation that allows the UI to respond to artwork.

### Tasks

1.  Create palette extraction utility.
2.  Add safe fallback palette.
3.  Create theme state/controller.
4.  Connect theme state to CSS custom properties.
5.  Add contrast validation.
6.  Add theme transition behavior.
7.  Define SSR-safe behavior.
8.  Define image-load failure behavior.
9.  Connect hero artwork to theme.
10. Ensure rapid carousel changes do not create stale theme updates.

### Acceptance criteria

-   Dune-like artwork produces a warm theme.
-   Blue artwork produces a cool theme.
-   Red artwork produces a red/burgundy theme.
-   Missing artwork falls back cleanly.
-   No unreadable text appears.
-   No hydration mismatch is introduced.
-   Theme changes do not cause layout shift.

------------------------------------------------------------------------

# 9. Phase 2 --- Global Shell & Navigation

### Objective

Replace the old consumer navigation presentation with the new cinematic
shell.

### Desktop

Implement:

-   floating glass navigation
-   Mavero branding
-   primary navigation
-   search entry
-   theme control
-   profile control
-   compact layout
-   correct hover/focus/active states

### Mobile

Implement:

-   cinematic top bar
-   floating glass bottom dock
-   active-state treatment
-   safe-area handling
-   touch-friendly targets

### Large screen

Adapt navigation for:

-   1080p
-   1440p+
-   TV distance

### Acceptance criteria

-   shell works without a hero
-   shell works with different themes
-   shell remains readable over artwork
-   mobile dock does not obstruct content
-   desktop navigation does not consume excessive vertical space
-   keyboard focus remains visible

------------------------------------------------------------------------

# 10. Phase 3 --- Discover / Home Page

**This is the primary visual showcase.**

Do this page completely before migrating other pages.

## 10.1 Hero

Redesign:

-   artwork composition
-   content positioning
-   title typography
-   metadata
-   description
-   Play CTA
-   secondary actions
-   carousel navigation
-   slide indicators
-   hero atmosphere
-   responsive crop

Use the existing hero functionality where possible.

## 10.2 Trending Movies

Redesign:

-   section header
-   rail spacing
-   card dimensions
-   poster treatment
-   rating treatment
-   metadata
-   hover/focus state
-   mobile rail behavior

## 10.3 Streaming Providers

Redesign:

-   provider tiles
-   logos
-   glass surfaces
-   selected/hover states
-   horizontal overflow
-   mobile behavior

## 10.4 Other Discover rails

Apply the new component language consistently.

### Acceptance criteria

The Discover page should visually demonstrate the complete design
system:

``` text
artwork
+
atmosphere
+
glass
+
dynamic accent
+
cards
+
typography
+
navigation
```

Only after this page is visually stable should the next page begin.

------------------------------------------------------------------------

# 11. Phase 4 --- Detail Page

### Objective

Create the cinematic title experience.

## Hero

-   high-quality backdrop
-   adaptive atmosphere
-   poster/content balance
-   title
-   release date
-   runtime
-   rating
-   genres
-   description
-   Play
-   My List
-   information controls

## Tabs

Use restrained glass/segmented controls for:

-   Overview
-   Cast & Crew
-   Videos
-   Streaming Providers
-   Similar Titles

## Cast & Crew

-   poster/headshot presentation
-   names
-   roles
-   responsive rail

## Streaming Providers

-   provider identity
-   available services
-   glass provider cards

## Similar Titles

Use the new MediaCard system.

### Acceptance criteria

Movie and series detail pages must both feel native to the new system.

Series-specific functionality such as episode selection and resume
behavior must remain intact.

------------------------------------------------------------------------

# 12. Phase 5 --- Search

### Objective

Create a cinematic search experience.

### Design

Search should behave like an overlay/environment rather than a generic
black page.

Implement:

-   blurred background atmosphere
-   glass search field
-   filters
-   result categories
-   result rows/cards
-   keyboard navigation
-   mobile search
-   empty state
-   loading state
-   error state

### Acceptance criteria

Search feels like part of Mavero rather than a separate utility page.

------------------------------------------------------------------------

# 13. Phase 6 --- My List

### Objective

Redesign the user's saved-content experience.

### Tasks

-   page header
-   filter controls
-   media cards
-   empty state
-   responsive grid/rail
-   contextual actions
-   resume state
-   progress display

Preserve:

-   favorite state
-   resume behavior
-   source behavior
-   existing data flow

------------------------------------------------------------------------

# 14. Phase 7 --- Continue Watching / Viewing Surfaces

### Objective

Make progress-driven UI visually consistent with the new system.

### Tasks

-   Continue Watching rail
-   progress indicator
-   resume label
-   remaining time
-   episode context
-   movie context
-   hover/focus
-   mobile layout

Preserve the existing corrected resume architecture.

Do not reintroduce:

-   movie-default-provider mistakes
-   series episode loss
-   progress flush races
-   incorrect completion semantics

This phase is visual unless a presentation contract requires a small
data adjustment.

------------------------------------------------------------------------

# 15. Phase 8 --- Account / Profile

### Objective

Redesign user-facing account surfaces.

### Tasks

-   profile header
-   account information
-   avatar
-   account actions
-   provider/default-source information where applicable
-   glass sections
-   responsive layout

Avoid unnecessary decorative features.

------------------------------------------------------------------------

# 16. Phase 9 --- Settings

### Objective

Create a clean premium settings experience.

### Sections

Potential existing settings should be grouped visually into:

-   Playback
-   Appearance
-   Account
-   Privacy
-   Preferences
-   Advanced

Do not add settings that do not already exist.

Use:

-   glass groups
-   clear labels
-   secondary descriptions
-   switches
-   segmented controls
-   safe destructive-action styling

------------------------------------------------------------------------

# 17. Phase 10 --- Watch / Player Chrome

### Objective

Bring the surrounding player UI into the new design without compromising
playback.

### Important rule

The actual provider/embed surface should remain functionally isolated.

Redesign only Mavero-owned chrome such as:

-   back/navigation
-   episode selector
-   source controls
-   provider selection
-   playback metadata
-   resume indicators
-   error/retry UI

Do not introduce another embed/proxy experiment.

Playback behavior must remain unchanged unless a UI bug is found during
migration.

------------------------------------------------------------------------

# 18. Phase 11 --- TV / Large Screen

### Objective

Create a dedicated 10-foot UI treatment.

### Requirements

-   large typography
-   large focus targets
-   remote-friendly navigation
-   strong focus ring
-   reduced visual density
-   large hero composition
-   large content rails
-   adaptive theme
-   predictable focus movement

Do not simply scale desktop down/up.

------------------------------------------------------------------------

# 19. Phase 12 --- Secondary / Remaining Public Pages

Audit all remaining public pages and migrate them to the new system.

For every page:

1.  identify existing components
2.  identify required data
3.  apply theme
4.  redesign structure
5.  redesign components
6.  test desktop
7.  test mobile
8.  test keyboard/focus
9.  verify loading/error/empty states
10. complete visual review
11. update worklog
12. commit and push

------------------------------------------------------------------------

# 20. Page-by-Page Completion Rule

Every page is considered complete only when all of these are checked:

### Visual

-   [ ] New navigation
-   [ ] New typography hierarchy
-   [ ] New spacing
-   [ ] New surface treatment
-   [ ] New buttons
-   [ ] New cards
-   [ ] Dynamic accent
-   [ ] Artwork atmosphere
-   [ ] Empty state
-   [ ] Loading state
-   [ ] Error state

### Responsive

-   [ ] Mobile
-   [ ] Tablet
-   [ ] Desktop
-   [ ] Large screen

### Interaction

-   [ ] Hover
-   [ ] Focus
-   [ ] Active
-   [ ] Disabled
-   [ ] Keyboard navigation
-   [ ] Touch targets

### Accessibility

-   [ ] Contrast
-   [ ] Focus visibility
-   [ ] Reduced motion
-   [ ] Labels
-   [ ] Semantic structure

### Engineering

-   [ ] No unnecessary business-logic changes
-   [ ] No regressions
-   [ ] Tests/checks pass
-   [ ] Build passes
-   [ ] Worklog updated
-   [ ] Changes committed
-   [ ] Changes pushed

------------------------------------------------------------------------

# 21. Worklog Protocol --- Mandatory

The implementation agent (GLM) must maintain the redesign worklog
continuously.

Suggested file:

``` text
docs/worklog/MAVERO_UI_REDESIGN_WORKLOG.md
```

If the repository already has an established worklog location, use that
location instead of creating a duplicate.

## Before each phase

Record:

-   phase
-   page/component
-   current state
-   intended change
-   constraints
-   relevant files
-   acceptance criteria

## During implementation

Record meaningful discoveries:

-   visual problems
-   architecture findings
-   reusable component decisions
-   palette problems
-   responsive issues
-   accessibility issues
-   implementation decisions
-   rejected approaches and why

Do not fill the worklog with meaningless command-by-command narration.

## After each page

Record:

-   what changed
-   files changed
-   visual behavior
-   responsive behavior
-   tests/checks
-   known limitations
-   next step

## After each phase

Record:

-   phase status
-   completed pages
-   changed components
-   validation results
-   commit hash
-   push status
-   remaining work

------------------------------------------------------------------------

# 22. Git / Commit Protocol

GLM must keep Git history clean and traceable.

Recommended pattern:

``` text
ui: add adaptive theme foundation
ui: redesign cinematic shell
ui: redesign discover page
ui: redesign detail page
ui: redesign search experience
ui: redesign my list
ui: redesign account surfaces
ui: redesign settings
ui: redesign player chrome
ui: redesign tv layout
ui: polish adaptive visual system
```

The exact commit message can follow repository conventions.

### Required after meaningful completed work

1.  Run relevant checks.
2.  Update worklog.
3.  Review diff.
4.  Commit.
5.  Push to GitHub.
6.  Record commit in worklog.

Do not leave the repository with undocumented visual changes.

------------------------------------------------------------------------

# 23. Testing Strategy

Every migrated page must pass:

## Functional

-   navigation
-   buttons
-   links
-   search
-   favorite
-   playback entry
-   resume entry
-   provider selection
-   forms/settings where applicable

## Visual

Check at minimum:

``` text
390 × 844
412 × 915
768 × ~1024
1280 × 720
1440 × 900
1920 × 1080
```

and the project's supported TV/large-screen dimensions.

## Theme

Test with contrasting artwork:

-   warm orange
-   blue
-   green
-   red
-   purple
-   monochrome
-   very dark
-   very bright

## Failure states

-   no backdrop
-   broken image
-   missing poster
-   palette extraction failure
-   empty content
-   API/content failure

------------------------------------------------------------------------

# 24. Performance Requirements

The redesign must not turn artwork processing into a performance
problem.

Rules:

-   do not repeatedly extract the same image palette
-   cache palette results where appropriate
-   do not block initial render unnecessarily
-   do not introduce large client-only work without reason
-   keep hero loading optimized
-   preserve current image loading strategy
-   avoid layout shifts
-   avoid expensive continuous blur animations
-   avoid unnecessary DOM layers

The atmospheric layer should be visually rich but computationally cheap.

------------------------------------------------------------------------

# 25. Accessibility Requirements

Dynamic color must never override accessibility.

Required:

-   WCAG-appropriate contrast
-   visible focus
-   keyboard navigation
-   touch target sizing
-   reduced-motion support
-   semantic buttons/links
-   meaningful accessible labels
-   no color-only information
-   readable metadata over artwork

When an extracted accent fails contrast requirements, automatically fall
back to a safer derived value.

------------------------------------------------------------------------

# 26. Mobile Rules

Mobile is not a compressed desktop.

The new design should specifically account for:

-   small viewport height
-   safe areas
-   thumb reach
-   floating navigation
-   hero crop
-   card width
-   horizontal rails
-   touch targets
-   reduced information density

The supplied reference's mobile composition should be used as the visual
direction, not copied pixel-for-pixel.

------------------------------------------------------------------------

# 27. Desktop Rules

Desktop should use the additional space for:

-   cinematic hero composition
-   wider content rails
-   stronger metadata hierarchy
-   floating navigation
-   breathing room

Do not simply enlarge every component.

------------------------------------------------------------------------

# 28. Component Migration Strategy

Existing reusable components should be migrated before creating
replacements.

Preferred approach:

``` text
Existing MediaCard
      ↓
new visual treatment
      ↓
same data contract
      ↓
same interaction contract
```

rather than:

``` text
Old MediaCard
+
New MediaCard
+
Legacy MediaCard
```

Avoid duplicate component systems.

Create new primitives only when the old component's responsibilities
fundamentally conflict with the new visual system.

------------------------------------------------------------------------

# 29. Design Tokens to Establish

The final token set should cover:

## Color

-   background
-   surface
-   elevated surface
-   glass
-   glass strong
-   border
-   border strong
-   text
-   text muted
-   text subtle
-   theme primary
-   theme secondary
-   theme glow
-   success
-   warning
-   error
-   focus

## Spacing

A consistent scale for:

-   page padding
-   section gaps
-   card gaps
-   control gaps
-   text spacing

## Radius

A controlled scale for:

-   small controls
-   cards
-   panels
-   floating surfaces

## Motion

Define:

-   fast interaction
-   normal transition
-   theme transition
-   page transition

Respect reduced motion.

------------------------------------------------------------------------

# 30. Definition of Done --- Entire Redesign

The redesign is complete only when:

-   [ ] Old consumer Cyberpunk/green visual language is no longer the
    active UI system.
-   [ ] Adaptive artwork-driven theme works across supported content
    types.
-   [ ] Discover is fully migrated.
-   [ ] Detail pages are fully migrated.
-   [ ] Search is fully migrated.
-   [ ] My List is fully migrated.
-   [ ] Continue Watching surfaces are fully migrated.
-   [ ] Account/Profile is fully migrated.
-   [ ] Settings is fully migrated.
-   [ ] Mavero-owned player chrome is migrated.
-   [ ] TV/Large Screen layout is migrated.
-   [ ] Remaining public pages are migrated.
-   [ ] Dynamic palette has safe fallbacks.
-   [ ] Mobile and desktop are both intentionally designed.
-   [ ] Accessibility checks pass.
-   [ ] Performance remains acceptable.
-   [ ] Existing playback/resume behavior remains correct.
-   [ ] Existing authentication/data functionality remains correct.
-   [ ] All relevant tests/checks/build pass.
-   [ ] Worklog contains the complete implementation history.
-   [ ] Every phase has a traceable commit.
-   [ ] All completed changes are pushed to GitHub.

------------------------------------------------------------------------

# 31. Final Visual Target

The finished Mavero experience should communicate:

``` text
                 MAVERO
                    │
             ┌──────┴──────┐
             │             │
          ARTWORK        GLASS
             │             │
             └──────┬──────┘
                    │
              CINEMATIC UI
                    │
          adaptive accent color
                    │
             content first
```

The user should be able to switch from one title to another and
immediately notice that the environment has changed---while still
knowing they are inside Mavero.

The visual system should feel:

-   cinematic
-   premium
-   calm
-   immersive
-   modern
-   adaptive
-   consistent
-   content-first

without becoming:

-   neon-heavy
-   overly colorful
-   glass-everywhere
-   cluttered
-   derivative
-   difficult to read.

------------------------------------------------------------------------

# 32. Implementation Instruction for GLM

**Do not attempt the whole redesign in a single implementation pass.**

Follow the phases sequentially.

For each page:

1.  Audit the existing implementation.
2.  Identify reusable logic/components.
3.  Implement only the required new visual system pieces.
4.  Integrate the page into the adaptive theme.
5.  Test the page at desktop and mobile sizes.
6.  Fix visual inconsistencies before moving on.
7.  Run relevant checks.
8.  Update the redesign worklog.
9.  Commit the completed work.
10. Push to GitHub.
11. Record the commit and validation result in the worklog.
12. Proceed to the next page only after the current page is stable.

**Do not silently skip worklog updates.**

**Do not leave completed phases undocumented.**

**Do not rewrite working product logic simply because the UI is
changing.**

The redesign is a visual-system migration with deliberate page-by-page
refinement, not a feature rewrite.

------------------------------------------------------------------------

# 33. Suggested Execution Order

``` text
R0  Audit + baseline
 ↓
R1  Adaptive theme engine
 ↓
R2  Global shell/navigation
 ↓
R3  Discover/Home
 ↓
R4  Detail page
 ↓
R5  Search
 ↓
R6  My List
 ↓
R7  Continue Watching
 ↓
R8  Account/Profile
 ↓
R9  Settings
 ↓
R10 Player chrome
 ↓
R11 TV/Large Screen
 ↓
R12 Remaining pages
 ↓
R13 Global visual polish
 ↓
R14 Final regression + production verification
```

The exact phase count may be adjusted after the repository audit, but
the **page-by-page migration principle must remain unchanged**.
