# MAVERO UX / My List implementation scope

## In scope

This pass is a focused refinement of the existing MAVERO application. It preserves the current SvelteKit 5 architecture, Design DNA, responsive shell, local/cloud synchronization, authentication, content service boundaries, and streaming-provider resolver/player behavior.

### Search and filters

The Search route will retain the query input at the top, followed by the Movies, Shows, and Anime toggle chips. Re-clicking the active chip removes the type constraint and returns to All results without displaying an All chip. OTT, Genre, and Sort will remain independent URL-synchronized filters and will be presented in one compact horizontal control row on mobile rather than three vertically stacked native selects.

The native browser `<select>` UI will be replaced with a reusable MAVERO custom selection sheet. The sheet will use semantic dialog behavior, a backdrop, Escape dismissal, focus-friendly buttons, selected indicators, safe-area padding, restrained motion, and reduced-motion support. Active filters will be visually apparent in the trigger surface through accent border/background/icon treatment, not color alone.

Existing server-side filter contracts and provider filtering will be reused. Search query, type, OTT, genre, and sort state will remain shareable and refresh-safe through the existing URL architecture.

### My List status model

The existing `FavoriteRecord` will be extended additively with `status: 'watching' | 'planned' | 'completed'`. Legacy local/cloud favorites will normalize to `planned` so existing saved titles remain visible. Playback progress remains the source of truth for position and completion; My List status remains the source of truth for user-selected library state. Continue Watching will use the existing progress records and the Watching status where appropriate, without duplicating progress rows.

The local IndexedDB favorite store will be upgraded compatibly, with validation/default normalization for older records. The existing guest memory fallback and cloud merge algorithm will be retained and status changes will remain idempotent by the existing `favorite_key` uniqueness.

The Supabase favorites table will receive an additive `status` column with a safe default, a check constraint, and an index suitable for user/status reads. Existing rows will migrate to `planned`. Generated database types and record mapping will be updated. No unrelated tables will be changed.

### New My List route

A refresh-safe `/my-list` route will be added. It will show all saved titles by default and expose toggle chips for Watching, Planned, and Completed. One status may be active at a time; clicking the active chip removes the `status` URL parameter and returns to all titles. `/my-list?status=watching` will be the destination for Discover/Profile Continue Watching “View all”. Empty states will be status-specific and link back to Discover.

### Detail and Profile

The DetailPage My list action will become a custom status sheet with Watching, Planned, and Completed choices. The current status will be reflected when reopened; selecting a new status will update the existing record rather than create a duplicate. A remove action will remain available from the same sheet for users who want to remove the title entirely.

Profile remains the account hub. Its My List preview will link to `/my-list`, and Continue Watching “View all” will link to `/my-list?status=watching`. The profile page may retain previews but will not become the dedicated library route.

## Planned files

| Area | Files |
|---|---|
| Search sheet/UI | `src/routes/search/+page.svelte`, new `src/lib/components/SelectionSheet.svelte` |
| Local status contracts | `src/lib/client/progress/types.ts`, `database.ts`, `service.ts`, `presenter.ts` if required |
| Merge/cloud sync | `src/lib/shared/progress-merge.ts`, `src/lib/client/progress/cloud.ts`, `src/lib/server/supabase/records.ts`, `src/routes/api/account/sync/+server.ts` |
| Cloud schema | new Supabase migration, `src/lib/server/supabase/database.types.ts` |
| Detail/profile/discover | `src/lib/components/DetailPage.svelte`, `src/lib/components/DiscoverPage.svelte`, `src/routes/profile/+page.svelte` |
| My List | new `src/routes/my-list/+page.svelte` and supporting loader/helper files |

## Migration decision

A database migration is required because cloud favorites currently have no status field. The migration is additive, defaults existing rows to `planned`, preserves `(user_id, favorite_key)` uniqueness and existing RLS policies, and does not modify streaming tables.

## Verification plan

Run `pnpm check` with zero errors and warnings, `pnpm build`, targeted local persistence/service checks, and live/browser checks at approximately 390×844 and desktop width. Verify custom sheets, URL state, type toggle behavior, independent filters, My List status toggles, detail status persistence, guest local records, authenticated sync compatibility, Profile/Discover navigation, accessibility semantics, reduced motion, and unchanged provider watch behavior.
