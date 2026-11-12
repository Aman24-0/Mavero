# Mavero --- User Management & App Analytics

## Complete Implementation Plan & Phase Tracking Specification

**Status:** APPROVED\
**Project:** Mavero\
**Purpose:** Complete first-party user management, app reach,
engagement, viewing, provider-usage, retention, and product analytics
for the Mavero Admin Panel.

------------------------------------------------------------------------

## 1. Document Purpose

This document is the **canonical implementation plan** for the Mavero
User Management & App Analytics project.

It exists so that:

-   GLM can resume work without losing project context.
-   ChatGPT can understand the implementation state without relying on
    conversation memory.
-   Every phase has an explicit checklist.
-   Completed work can be verified against the original approved scope.
-   `worklog.md` records what was actually implemented.
-   Git commit history provides an auditable implementation trail.
-   Future prompts do not need to restate the entire project.
-   Hallucination and accidental duplicate implementation are minimized.

### Canonical project-state files

The implementation must maintain these two documents:

1.  **This file:** `docs/user-management-analytics-plan.md`
    -   Defines what SHOULD be implemented.
    -   The approved target architecture and checklist.
    -   Should change only when the approved plan itself is
        intentionally revised.
2.  **Worklog:** `docs/user-management-analytics-worklog.md`
    -   Defines what HAS actually been implemented.
    -   Updated after every completed phase.
    -   Records files changed, migrations, tests, verification, commit
        hash, and push status.

The plan and worklog are complementary:

``` text
PLAN = intended state
WORKLOG = verified actual state
GIT HISTORY = implementation evidence
```

------------------------------------------------------------------------

# 2. Non-Negotiable Implementation Rules

## 2.1 Read project state before every phase

At the beginning of **every phase**, GLM MUST:

1.  Read this complete plan.
2.  Read `docs/user-management-analytics-worklog.md`.
3.  Inspect the current Git status.
4.  Inspect recent relevant commit history.
5.  Inspect the current implementation before changing anything.
6.  Compare the current state against the phase checklist.
7.  Identify already-completed work and avoid duplicating it.

Do not assume a phase is incomplete merely because the original prompt
says so.

Do not re-run or recreate an already-applied migration without first
verifying the current database/repository state.

------------------------------------------------------------------------

## 2.2 Worklog must be maintained continuously

After meaningful implementation work, update:

`docs/user-management-analytics-worklog.md`

The worklog must contain, at minimum:

-   Current overall status.
-   Completed phases.
-   Current phase.
-   Remaining phases.
-   Exact implementation summary.
-   Database migrations applied.
-   Files created/modified.
-   Tests added/updated.
-   Verification commands and results.
-   Known limitations.
-   Commit hash.
-   Push status.
-   Any deviations from this plan.

The worklog must describe **verified facts**, not assumptions.

------------------------------------------------------------------------

## 2.3 One phase = one commit = one push

When a phase is fully complete and verified:

1.  Update the worklog.
2.  Run the required verification gates.
3.  Review the final diff.
4.  Create **one Git commit for that phase**.
5.  Push that commit to GitHub in **one push**.
6.  Record the commit hash in the worklog.

Do not create multiple commits for one phase unless explicitly required
because of an exceptional recovery situation.

Do not push partially completed phase work.

If a phase cannot be completed safely, do not mark it complete and do
not create a misleading completion commit.

------------------------------------------------------------------------

## 2.4 No scope drift

Only implement items in the current phase and approved plan.

Do not add:

-   unrelated UI redesigns,
-   unrelated refactors,
-   speculative analytics,
-   unnecessary third-party analytics services,
-   AI features,
-   predictive churn scoring,
-   session recording,
-   keystroke tracking,
-   excessive IP collection,
-   unrelated database restructuring.

If an improvement is discovered that belongs to a later phase, record it
in the worklog as a follow-up item rather than silently implementing it.

------------------------------------------------------------------------

## 2.5 Preserve existing Mavero architecture

Before implementing anything:

-   Reuse existing Supabase/Auth architecture.
-   Reuse existing admin authorization.
-   Reuse existing server-side patterns.
-   Reuse existing UI/design-system components.
-   Reuse existing provider/content/user identifiers where appropriate.
-   Do not create a second authentication system.
-   Do not bypass existing RLS/security architecture.
-   Do not replace existing working analytics or user infrastructure
    without evidence that replacement is necessary.

------------------------------------------------------------------------

# 3. Product Goal

Create a complete Admin Panel area that answers:

### Reach

-   How many people are using Mavero?
-   How many are guests?
-   How many are logged-in?
-   How many are new?
-   How many are returning?
-   How many are active?

### Conversion

-   How many visitors arrive as guests?
-   How many create accounts?
-   How many continue using Mavero after registration?

### Engagement

-   DAU / WAU / MAU.
-   Sessions.
-   Meaningful activity.
-   Feature usage.
-   Returning behavior.
-   Retention.

### User management

-   Who are the registered users?
-   When did they register?
-   When were they first seen?
-   When were they last active?
-   What is their usage activity?
-   What have they watched?
-   What providers have they used?

### Viewing

-   What movies and series are users watching?
-   Which titles have the most unique viewers?
-   Which titles have the most starts?
-   Which titles have the most watch time?
-   Which titles are trending?
-   What genres/categories are popular?
-   What searches produce no results?

### Providers

-   Which providers are actually used?
-   Which providers are configured as defaults?
-   Which providers are manually selected?
-   How often do users switch providers?
-   Which provider transitions are common?
-   What are provider success/failure rates?

### Product improvement

-   Which features are actually used?
-   Where do users drop out?
-   What content are users looking for?
-   What content/discovery gaps exist?
-   Which signals can later support personalization/recommendation
    systems?

------------------------------------------------------------------------

# 4. Admin Navigation

Current Mavero Admin sidebar should gain a dedicated section:

``` text
USERS & ANALYTICS

User Management
```

Inside:

``` text
User Management
├── Overview
├── Users
├── Viewing
├── Providers
└── Retention
```

The feature should remain visually consistent with the existing Mavero
Admin design system.

Do not unnecessarily restructure unrelated admin navigation.

------------------------------------------------------------------------

# 5. Global Date Range System

All analytics pages should use a shared date-range control.

Supported ranges:

``` text
Last 24 Hours
Last 7 Days
Last 30 Days
Last 3 Months
Last 6 Months
Last 1 Year
Custom
```

Custom range:

``` text
From
To
```

All period-dependent metrics must respect the selected range.

Avoid implementing separate incompatible date filtering logic on each
page.

A shared date-range abstraction should be created if the current
architecture does not already provide one.

------------------------------------------------------------------------

# 6. Analytics Identity Model

## 6.1 Anonymous identity

Guest users require a persistent anonymous identifier.

Concept:

``` text
anonymous_id
```

Do not rely on IP address as the primary guest identity.

Example:

``` text
anonymous_id = guest_<stable-random-id>
```

The identifier should be persistent for the supported guest lifecycle.

------------------------------------------------------------------------

## 6.2 Authenticated identity

Registered users use the existing Mavero/Supabase user identity.

Concept:

``` text
user_id
```

Do not create a parallel account identity system.

------------------------------------------------------------------------

## 6.3 Identity stitching

When a guest creates an account or logs in:

``` text
Guest activity
    ↓
anonymous_id
    ↓
Signup/Login
    ↓
user_id
    ↓
Historical guest activity associated with the user where technically and privacy-wise appropriate
```

This allows measurement of:

-   guest-to-account conversion,
-   activity before signup,
-   activity after signup,
-   returning behavior.

The implementation must avoid incorrectly merging unrelated identities.

------------------------------------------------------------------------

# 7. Analytics Event Architecture

Analytics should use a central event-based model rather than independent
counters scattered throughout the application.

Conceptual raw event structure:

``` text
analytics_events
├── id / event_id
├── anonymous_id
├── user_id
├── session_id
├── event_name
├── event_time
├── content_id
├── content_type
├── provider_id
├── source_id
└── metadata
```

Exact schema must be adapted to the current Mavero/Supabase architecture
after repository inspection.

------------------------------------------------------------------------

# 8. Core Event Taxonomy

## Application/session events

``` text
app_open
session_start
session_end
```

## Discovery events

``` text
search
search_result_open
detail_open
```

## Playback events

``` text
watch_start
watch_progress
watch_stop
watch_complete
playback_success
playback_failed
```

## Provider events

``` text
provider_selected
provider_switched
```

Where possible, include reason only when the application knows the
actual reason:

``` text
manual_switch
playback_failure
no_source
slow_loading
user_preference
```

Do not infer reasons that the application does not know.

## Authentication events

``` text
signup_started
signup_completed
login
logout
```

## Feature events

Examples:

``` text
favorite_added
favorite_removed
mylist_open
continue_watching_open
download_started
download_completed
```

Only meaningful events should be added. Do not instrument every click by
default.

------------------------------------------------------------------------

# 9. Event Integrity

Every event should have an idempotency mechanism such as:

``` text
event_id
```

This prevents network retries from creating duplicate analytics events.

The ingestion layer should be designed so that duplicate event
submissions do not inflate important metrics.

Critical business metrics should preferably use server-authoritative
events where possible.

Client-side events can supplement them but should not blindly be trusted
for critical facts.

------------------------------------------------------------------------

# 10. Session Model

Track:

``` text
session_id
anonymous_id / user_id
started_at
last_activity
ended_at
duration
```

This enables:

-   sessions per day,
-   sessions per user,
-   session duration,
-   active users,
-   returning users.

The exact session timeout should be defined consistently in the
implementation rather than independently by each feature.

------------------------------------------------------------------------

# 11. Active User Definition

The canonical Mavero definition:

> A user is active when they perform at least one meaningful Mavero
> activity during the selected period.

Meaningful examples:

``` text
search
detail_open
watch_start
watch_progress
favorite
MyList interaction
provider selection
other meaningful product interaction
```

A simple page load should not automatically make a user active if it
would inflate the metric through refreshes/background behavior.

The exact event list must be centralized.

------------------------------------------------------------------------

# 12. Overview Dashboard

The Overview page is the primary Mavero reach/engagement dashboard.

## Top metric cards

``` text
Total Users
Active Users
New Users
Returning Users
```

## Guest vs logged-in

Display:

``` text
Guest Reach
Logged-in Reach

Guest Active
Logged-in Active

Guest New
Logged-in New

Guest Returning
Logged-in Returning
```

## Reach graph

Graph toggles:

``` text
All
Guest
Logged-in
New
Returning
```

Possible metric toggle:

``` text
Users
Sessions
Watch Starts
```

## DAU / WAU / MAU

Display:

``` text
DAU
WAU
MAU
```

Also provide:

``` text
DAU / MAU
```

as an engagement/stickiness metric.

## Guest → account funnel

``` text
New Visitors
      ↓
Used Mavero
      ↓
Returned
      ↓
Created Account
      ↓
Used Mavero After Signup
```

Show counts and conversion percentages.

------------------------------------------------------------------------

# 13. User Lifecycle

Support lifecycle concepts:

``` text
New
Activated
Returning
Engaged
Dormant
```

Suggested definitions:

### New

First-ever meaningful Mavero activity occurs during the selected period.

### Activated

A new user performs a meaningful product action beyond merely arriving.

### Returning

Previously seen/active before the selected period and active again
during it.

### Engaged

Meets a defined meaningful engagement threshold.

### Dormant

Previously active but has not had recent meaningful activity.

Definitions must be documented and implemented consistently.

------------------------------------------------------------------------

# 14. Users Page

Provide a searchable/filterable user-management table.

Columns should include, where applicable:

``` text
User
Type
Created
First Seen
Last Active
Sessions
Watch Starts
```

User types:

``` text
Guest
Registered
```

Filters:

``` text
All
Guest
Registered
Active
Inactive
New
Returning
```

Search:

``` text
email
username
user ID
```

Use pagination/server-side querying for scalability.

------------------------------------------------------------------------

# 15. User Detail Page

Opening a user shows:

## Profile

``` text
Email
Username
User ID
Account Created
First Seen
Last Active
Email Verification State (if available)
```

## Activity summary

``` text
Total Sessions
Total Watch Starts
Total Watch Time
Movies Watched
Series Watched
Searches
Detail Views
Provider Switches
```

## Recent activity timeline

Examples:

``` text
Opened title
Started playback
Selected provider
Searched
Added to MyList
```

## Viewing history

``` text
Title
Type
Last Watched
Progress
Provider
```

## Session/device summary

Where available and appropriate:

``` text
Device type
Browser
OS
Last seen
Session count
```

Do not expose unnecessary sensitive data such as raw IP addresses in the
normal user-management UI unless a separately approved security
requirement exists.

------------------------------------------------------------------------

# 16. Viewing Analytics

Dedicated page:

``` text
Viewing
```

## Primary metrics

For the selected period:

``` text
Unique Viewers
Watch Starts
Completed Watches
Watch Time
```

## Most watched titles

Table:

``` text
Title
Type
Unique Viewers
Watch Starts
Watch Time
Completion
```

Unique viewers should be a primary popularity measure.

## Movies vs Series

Show usage distribution:

``` text
Movies %
Series %
```

## Content trends

Provide:

``` text
Most Watched
Most Started
Most Completed
Trending
```

Trending should compare equivalent time periods rather than simply
sorting all-time totals.

## Genres/categories

Aggregate viewing behavior by available metadata.

Avoid duplicating metadata unnecessarily if it already exists in
Mavero/TMDB-related structures.

------------------------------------------------------------------------

# 17. Search Analytics

Track:

``` text
search
search_result_open
```

Store the minimum required data to analyze discovery.

Provide:

## Most searched

``` text
Query
Search Count
Unique Users
```

## No-result searches

``` text
Query
Occurrences
Unique Users
```

## Search conversion

Where possible:

``` text
Search
  ↓
Result selected
  ↓
Detail opened
  ↓
Playback started
```

This helps identify discovery gaps.

------------------------------------------------------------------------

# 18. Trending Content

Trending should not simply mean highest lifetime views.

Use a period-aware model such as:

``` text
current period activity
vs
previous equivalent period
```

Possible metrics:

``` text
unique viewers
watch starts
watch time
growth/change
```

The exact ranking formula must be documented and deterministic.

------------------------------------------------------------------------

# 19. Provider Analytics

Dedicated Providers analytics page.

Track separately:

### Default provider

What the user's configured default is.

### Selected provider

What the user selected for a playback attempt.

### Actual provider

What provider actually served the playback/resolution path.

Do not treat these as interchangeable.

------------------------------------------------------------------------

# 20. Provider Usage

Provide:

``` text
Provider
Unique Users
Playback Attempts
Successful Plays
Failed Plays
Success Rate
Manual Switches
```

Additional useful metric:

``` text
Average resolution/selection time
```

only if reliable timing data already exists.

------------------------------------------------------------------------

# 21. Provider Switching

Track transitions:

``` text
Provider A → Provider B
```

Example:

``` text
VidY → VidLink
VidY → Vidzee
VidLink → VidY
```

Show:

``` text
Switch count
Unique users
```

Also distinguish:

``` text
manual switch
automatic fallback
failure-driven switch
```

when the application can reliably identify the mechanism.

Do not infer a reason.

------------------------------------------------------------------------

# 22. Provider Reliability

Where technically supported:

``` text
Provider
Attempts
Successes
Failures
Success Rate
```

This complements usage data.

A provider being frequently used does not automatically mean it is
technically reliable; these are separate metrics.

------------------------------------------------------------------------

# 23. Feature Usage

Track meaningful Mavero features:

``` text
Search
Discover
MyList
Continue Watching
Favorites
Downloads
Stremio Addons
Provider Switching
QR Login
```

For each:

``` text
Unique Users
Total Uses
```

Only add events that are useful for product decisions.

------------------------------------------------------------------------

# 24. User Paths

Provide a simplified navigation/path analysis where practical.

Example:

``` text
Home
 ↓
Search
 ↓
Detail
 ↓
Play
 ↓
Provider Switch
 ↓
Playback
```

The implementation does not need a full external analytics platform.

A focused Mavero-specific path view is sufficient for the first version.

------------------------------------------------------------------------

# 25. Retention Page

Provide:

## New-user retention

``` text
Day 1
Day 7
Day 30
```

## Signup retention

``` text
Account Created
    ↓
Returned
```

## First-use retention

``` text
First Mavero Use
    ↓
Returned
```

## First-watch retention

``` text
First Watch
    ↓
Watched Again
```

The exact cohort definitions must be documented.

------------------------------------------------------------------------

# 26. Cohorts

Support useful behavior-based cohorts, including:

``` text
New Users
Guest Users
Registered Users
Heavy Viewers
Light Viewers
Movie-focused Users
Series-focused Users
Users who manually switch providers
Users who use Stremio Addons
Users inactive for 30 days
```

Do not build an unnecessarily complex cohort-builder in the first
implementation unless required by the existing architecture.

------------------------------------------------------------------------

# 27. Recommendation/Personalization Signals

Analytics should expose data that can later support recommendation
systems.

Useful signals:

``` text
Genre affinity
Movie/series preference
Recent viewing
Repeat viewing
Watch completion
Provider usage
Search behavior
Feature engagement
```

Analytics and recommendation logic should remain separate.

Analytics is the source of behavioral evidence; recommendation logic may
consume aggregated signals later.

------------------------------------------------------------------------

# 28. Data Architecture

Preferred conceptual architecture:

``` text
Mavero App
    │
    ├── Auth
    ├── Guest
    ├── Watch
    ├── Search
    ├── Providers
    └── Features
            │
            ▼
      Analytics Event Layer
            │
            ▼
      Supabase / PostgreSQL
            │
       ┌────┴─────┐
       │          │
 Raw Events   Aggregates
       │          │
       └────┬─────┘
            ▼
      Admin Analytics
```

The implementation must inspect the existing schema before creating new
tables.

------------------------------------------------------------------------

# 29. Raw Events and Aggregates

Do not make every dashboard query scan the entire raw event table.

Conceptual raw table:

``` text
analytics_events
```

Conceptual aggregates:

``` text
analytics_daily
analytics_content_daily
analytics_provider_daily
analytics_user_daily
```

Exact table names and columns should be adapted to Mavero's existing
conventions.

------------------------------------------------------------------------

# 30. Aggregation Strategy

Use aggregation for:

``` text
daily user metrics
content metrics
provider metrics
feature metrics
retention/cohort inputs
```

Supabase/Postgres scheduled jobs may be used where appropriate.

The implementation should prioritize:

-   indexes,
-   bounded queries,
-   pre-aggregation,
-   pagination,
-   caching where useful.

Do not prematurely over-engineer.

------------------------------------------------------------------------

# 31. Real-time vs Aggregated Metrics

### Near-real-time

Suitable for:

``` text
Current active users
Today's users
Current sessions
```

### Aggregated

Suitable for:

``` text
7 days
30 days
3 months
6 months
1 year
Retention
Content trends
Provider trends
```

The dashboard should not perform expensive full-history aggregation on
every page load.

------------------------------------------------------------------------

# 32. Data Retention

Raw detailed event data should not grow without bounds.

Conceptual lifecycle:

``` text
Detailed raw events
        ↓
limited retention period
        ↓
daily aggregates
        ↓
long-term trends
```

Exact retention duration must be decided during implementation based on:

-   database size,
-   expected traffic,
-   query needs,
-   privacy requirements.

The chosen retention policy must be recorded in the worklog.

------------------------------------------------------------------------

# 33. Security and Privacy

Analytics is admin-only.

Reuse Mavero's existing authorization model.

Do not expose analytics tables or user analytics endpoints to ordinary
users.

Use server-side authorization and existing Supabase RLS/security
patterns.

User email/activity information is sensitive operational data and must
remain behind admin authorization.

Avoid collecting data that is not required for the stated analytics
goals.

------------------------------------------------------------------------

# 34. Scalability Requirements

The implementation should remain usable as Mavero grows.

Required considerations:

-   indexed user identifiers,
-   indexed timestamps,
-   indexed event names,
-   indexed content IDs where needed,
-   efficient date filtering,
-   pagination,
-   aggregate tables,
-   bounded raw-event retention,
-   avoiding N+1 database queries.

The exact indexes must be based on actual query patterns after
implementation.

------------------------------------------------------------------------

# 35. Error and Failure Handling

Analytics failures should not break core Mavero functionality.

If an analytics event cannot be recorded:

-   the main user action should normally continue,
-   errors should be logged appropriately,
-   retry behavior should not create duplicate events,
-   analytics must remain non-blocking where practical.

Analytics is observability/product intelligence, not a dependency that
should prevent playback, browsing, or authentication.

------------------------------------------------------------------------

# 36. Phase Plan

## Phase 1 --- Analytics Foundation

### Goal

Build the event/identity/session foundation.

### Checklist

-   [ ] Inspect current user/auth architecture.
-   [ ] Inspect current guest identity implementation.
-   [ ] Inspect existing watch/provider/search event opportunities.
-   [ ] Design final analytics event schema.
-   [ ] Add anonymous identity mechanism if required.
-   [ ] Add session model.
-   [ ] Add event ingestion.
-   [ ] Add event idempotency.
-   [ ] Add server-authoritative events where practical.
-   [ ] Add admin-safe database access.
-   [ ] Add indexes.
-   [ ] Add core event taxonomy.
-   [ ] Add tests.
-   [ ] Verify existing application behavior remains intact.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

### Required verification

At minimum, run the repository's applicable:

``` text
pnpm check
pnpm test
pnpm build
```

plus relevant targeted analytics tests.

------------------------------------------------------------------------

# 37. Phase 2 --- Overview Dashboard

### Goal

Build the main reach and engagement dashboard.

### Checklist

-   [ ] Add User Management navigation.
-   [ ] Add Overview page.
-   [ ] Add shared date-range selector.
-   [ ] Add total users.
-   [ ] Add active users.
-   [ ] Add new users.
-   [ ] Add returning users.
-   [ ] Add guest reach.
-   [ ] Add logged-in reach.
-   [ ] Add guest active.
-   [ ] Add logged-in active.
-   [ ] Add guest new.
-   [ ] Add logged-in new.
-   [ ] Add guest returning.
-   [ ] Add logged-in returning.
-   [ ] Add reach graph.
-   [ ] Add DAU.
-   [ ] Add WAU.
-   [ ] Add MAU.
-   [ ] Add DAU/MAU.
-   [ ] Add guest-to-account funnel.
-   [ ] Add loading/error/empty states.
-   [ ] Add tests.
-   [ ] Verify performance.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 38. Phase 3 --- User Management

### Goal

Provide searchable users and user detail pages.

### Checklist

-   [ ] Add Users page.
-   [ ] Add search.
-   [ ] Add pagination.
-   [ ] Add user-type filters.
-   [ ] Add active/inactive filters.
-   [ ] Add new/returning filters.
-   [ ] Add user table.
-   [ ] Add user detail page.
-   [ ] Add account information.
-   [ ] Add first-seen/last-active data.
-   [ ] Add activity summary.
-   [ ] Add recent activity timeline.
-   [ ] Add viewing summary.
-   [ ] Add session summary.
-   [ ] Add guest-to-account history where supported.
-   [ ] Add security checks.
-   [ ] Add tests.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 39. Phase 4 --- Viewing & Discovery Analytics

### Goal

Understand what Mavero users watch and search for.

### Checklist

-   [ ] Add Viewing page.
-   [ ] Add unique viewers.
-   [ ] Add watch starts.
-   [ ] Add completed watches.
-   [ ] Add watch time.
-   [ ] Add most watched titles.
-   [ ] Add most started titles.
-   [ ] Add most completed titles.
-   [ ] Add period-aware trending.
-   [ ] Add movies vs series.
-   [ ] Add genre/category analytics.
-   [ ] Add most searched queries.
-   [ ] Add no-result searches.
-   [ ] Add search-to-content interaction where supported.
-   [ ] Add loading/error/empty states.
-   [ ] Add tests.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 40. Phase 5 --- Provider Analytics

### Goal

Understand provider selection, switching, and reliability.

### Checklist

-   [ ] Add Providers analytics page/section.
-   [ ] Track default provider.
-   [ ] Track selected provider.
-   [ ] Track actual provider.
-   [ ] Add provider usage.
-   [ ] Add unique users per provider.
-   [ ] Add playback attempts.
-   [ ] Add success/failure.
-   [ ] Add success rate.
-   [ ] Add manual provider switching.
-   [ ] Add provider transition table.
-   [ ] Add switch reason only where known.
-   [ ] Add provider reliability metrics.
-   [ ] Add period filtering.
-   [ ] Add tests.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 41. Phase 6 --- Retention & Cohorts

### Goal

Measure whether users return and how user groups behave over time.

### Checklist

-   [ ] Add Retention page.
-   [ ] Add new-user retention.
-   [ ] Add signup retention.
-   [ ] Add first-use retention.
-   [ ] Add first-watch retention.
-   [ ] Add Day 1 retention.
-   [ ] Add Day 7 retention.
-   [ ] Add Day 30 retention.
-   [ ] Add cohort tables.
-   [ ] Add useful behavior cohorts.
-   [ ] Add cohort filtering where practical.
-   [ ] Verify date/cohort calculations.
-   [ ] Add tests.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 42. Phase 7 --- Performance, Hardening & Final Audit

### Goal

Make the complete analytics system production-ready.

### Checklist

-   [ ] Audit all analytics queries.
-   [ ] Audit database indexes.
-   [ ] Audit RLS/admin authorization.
-   [ ] Audit API access.
-   [ ] Audit client exposure.
-   [ ] Audit event duplication.
-   [ ] Audit identity stitching.
-   [ ] Audit guest counting.
-   [ ] Audit active-user definitions.
-   [ ] Audit date-range calculations.
-   [ ] Audit retention calculations.
-   [ ] Audit aggregate jobs.
-   [ ] Audit raw-event retention.
-   [ ] Audit loading/error states.
-   [ ] Audit mobile admin UI.
-   [ ] Audit desktop admin UI.
-   [ ] Audit accessibility.
-   [ ] Add/expand tests where needed.
-   [ ] Run complete repository checks.
-   [ ] Run complete test suite.
-   [ ] Run production build.
-   [ ] Review final diff.
-   [ ] Update worklog.
-   [ ] Commit phase.
-   [ ] Push phase.

------------------------------------------------------------------------

# 43. Required Worklog Format

Create:

`docs/user-management-analytics-worklog.md`

The worklog should use this structure:

``` md
# Mavero User Management & App Analytics — Worklog

## Current Status

Phase:
Status:
Last Updated:

## Phase Status

| Phase | Status | Commit | Push |
|---|---|---|---|
| Phase 1 | Pending | — | — |
| Phase 2 | Pending | — | — |
| Phase 3 | Pending | — | — |
| Phase 4 | Pending | — | — |
| Phase 5 | Pending | — | — |
| Phase 6 | Pending | — | — |
| Phase 7 | Pending | — | — |

## Completed Work

...

## Current Phase

...

## Database / Migrations

...

## Files Changed

...

## Tests

...

## Verification

...

## Known Limitations

...

## Deviations From Plan

...

## Next Phase

...
```

The exact worklog can become more detailed as implementation progresses.

------------------------------------------------------------------------

# 44. Phase Completion Protocol

At the end of every phase, GLM MUST follow this exact sequence:

``` text
1. Complete implementation
2. Run targeted tests
3. Run repository verification gates
4. Inspect git diff
5. Confirm phase checklist
6. Update worklog
7. Review worklog
8. Create ONE commit
9. Push ONCE
10. Record commit hash
11. Confirm clean/expected working tree
```

The phase must not be marked complete before verification.

------------------------------------------------------------------------

# 45. Start-of-Phase Protocol

At the beginning of every new phase:

``` text
1. Read docs/user-management-analytics-plan.md
2. Read docs/user-management-analytics-worklog.md
3. Inspect git status
4. Inspect recent relevant commits
5. Inspect current implementation
6. Compare checklist against actual state
7. Determine exactly what remains
8. Implement only the current phase
```

This protocol is mandatory for all future GLM prompts.

------------------------------------------------------------------------

# 46. Migration Safety Rules

Before creating any migration:

-   inspect existing migrations,
-   inspect current database schema,
-   verify whether the required structure already exists,
-   never blindly create a duplicate migration,
-   never assume an earlier migration has not already been applied,
-   verify migration state before execution.

If a required schema change already exists, reuse it.

If a migration exists in the repository but database state is uncertain,
verify before applying anything.

Record migration names and status in the worklog.

------------------------------------------------------------------------

# 47. Git Rules

Each completed phase must produce:

``` text
ONE phase commit
ONE push
```

Commit message should clearly identify the phase, for example:

``` text
feat(analytics): implement user analytics foundation
feat(analytics): add overview dashboard
feat(analytics): add user management
feat(analytics): add viewing analytics
feat(analytics): add provider analytics
feat(analytics): add retention and cohorts
feat(analytics): harden and audit analytics
```

Actual commit message may follow the repository's established
conventions if they differ.

The worklog must record the exact resulting commit hash.

------------------------------------------------------------------------

# 48. GLM Prompt Requirements for Every Phase

Every phase-specific GLM prompt must explicitly instruct GLM to:

1.  Read the complete plan first.
2.  Read the current worklog second.
3.  Inspect Git status/history.
4.  Inspect the existing implementation.
5.  Continue from actual repository state rather than assuming the phase
    is untouched.
6.  Follow only the current phase checklist.
7.  Maintain the worklog continuously.
8.  Update the worklog after completing the phase.
9.  Run all required verification.
10. Commit the completed phase as one commit.
11. Push that phase in one push.
12. Record the commit hash in the worklog.
13. Do not claim completion without evidence.
14. Do not duplicate migrations or already completed work.
15. Do not silently change the approved plan.
16. Record deviations instead of hiding them.

------------------------------------------------------------------------

# 49. Completion Criteria for the Entire Project

The project is complete only when all phases are verified and the
worklog confirms:

``` text
Phase 1 — Complete
Phase 2 — Complete
Phase 3 — Complete
Phase 4 — Complete
Phase 5 — Complete
Phase 6 — Complete
Phase 7 — Complete
```

And:

-   all applicable tests pass,
-   type/check gates pass,
-   production build passes,
-   admin authorization is verified,
-   analytics data is correctly scoped,
-   guest identity works,
-   authenticated identity works,
-   identity stitching is correct,
-   date ranges are correct,
-   aggregation is performant,
-   retention calculations are verified,
-   provider analytics are verified,
-   viewing analytics are verified,
-   no critical regressions exist,
-   final phase commit is pushed,
-   worklog reflects the actual final state.

------------------------------------------------------------------------

# 50. Definition of Done

The User Management & App Analytics system is considered
production-ready when an Mavero admin can open:

``` text
Admin
  → User Management
```

and answer, from the UI:

### Reach

> How many people are using Mavero?

### Audience

> How many are guests vs logged-in?

### Engagement

> How many are active, new, and returning?

### Growth

> How many new users arrived over a selected period?

### Conversion

> How many guests became registered users and continued using Mavero?

### Users

> Who are the registered users and how active are they?

### Viewing

> What are users watching?

### Discovery

> What are users searching for and what cannot they find?

### Providers

> Which providers are actually being used and switched to?

### Reliability

> Which providers successfully serve playback?

### Retention

> Are users returning after first use/signup/watch?

### Product behavior

> Which Mavero features are actually being used?

### Future personalization

> What behavioral signals can support better discovery/recommendations?

If these questions can be answered reliably from the Admin Panel, using
verified data and documented definitions, the project has achieved its
intended purpose.

------------------------------------------------------------------------

# 51. Future Enhancements --- NOT Part of Initial Scope

These may be considered later but must not be silently added during the
current implementation:

``` text
AI-powered analytics summaries
Predictive churn models
Automated recommendation engine
Advanced funnel builder
Advanced path explorer
Real-time live dashboard
Geographic analytics
Device-level analytics expansion
Automated anomaly detection
Custom admin-created cohorts
External analytics platform integration
```

Any such feature requires separate approval.

------------------------------------------------------------------------

# 52. Source/Research Basis

The approved plan is informed by established product analytics concepts
including:

-   active/new/returning users,
-   event-based product analytics,
-   feature engagement,
-   retention,
-   behavioral cohorts,
-   user paths,
-   funnel/conversion analysis,
-   first-party database-backed analytics.

Relevant references consulted during planning include:

-   Amplitude Product Analytics documentation.
-   Amplitude definitions for active/new/returning users.
-   Amplitude retention and cohort documentation.
-   PostHog product analytics and paths documentation.
-   Google Analytics user lifecycle terminology.
-   Supabase Auth/user-management/audit-log documentation.
-   Supabase Cron documentation.

The implementation should still prioritize Mavero's existing
architecture over blindly copying any third-party analytics product.

------------------------------------------------------------------------

# 53. Final Operating Rule

**This file tells GLM and ChatGPT what the project is supposed to
become.**

**The worklog tells GLM and ChatGPT what has actually happened.**

**Git history provides the implementation trail.**

At every phase boundary:

``` text
PLAN
  ↓
WORKLOG
  ↓
CURRENT REPO
  ↓
IMPLEMENT
  ↓
TEST
  ↓
WORKLOG UPDATE
  ↓
ONE COMMIT
  ↓
ONE PUSH
  ↓
NEXT PHASE
```

Never skip the state-reading step.

Never assume.

Never duplicate already-completed work.

Never mark an unverified phase complete.

Never silently change the approved scope.
