# UI Redesign Reference Notes

## Repository context
- Repository: `Aman24-0/Mavero`
- Framework: SvelteKit 2 + Svelte 5 + Vite 7.
- Styling: Tailwind CSS 4 is present; existing project also has `src/app.css`.
- Icon library: `lucide-svelte`.
- Animation library: `gsap` is installed.
- Data / backend context visible from repo and user brief: TMDB, Supabase, Netlify.
- GitHub latest commit at audit time: `redesign mavero discover experience` (`2ae36ee`, Aug 22, 2026).
- Existing repository includes design documents and prior UI audit/report artifacts, so implementation should preserve established product/business contracts and inspect current route behavior before modifying visual code.

## Bingr reference observations
- Dark, cinematic visual direction with prominent content-first homepage.
- Navigation is simple and content-oriented: Home, Search, TV, Anime, Movies, Sports, Sparks, Categories, My Space.
- Hero area uses a large backdrop/poster with title, rating/year/type metadata, synopsis, and clear actions (`Watch` / `See More`).
- Below the hero, the page moves into named content rails such as Trending Right Now, New Movies, and Popular TV Shows.
- Cards are image-led with compact metadata; section headers include a `View All` affordance.
- The strongest transferable pattern is not copying the exact look, but combining a dramatic hero, clearly labeled rails, compact metadata, and a personal-space destination for saved content.

## Initial design direction
- Build a cohesive dark streaming shell with a restrained, high-contrast accent system.
- Give each primary page a distinct job: Discover = guided exploration and editorial hierarchy; My List = organized saved library; Profile = personal identity and viewing activity; Admin = operational control center.
- Avoid introducing new dependencies; use existing Svelte/CSS/Lucide/GSAP capabilities where already present.

## Local browser verification checkpoint
- The first local render returned HTTP 500 because the repository intentionally guards against missing Supabase public configuration; a local-only `.env` with placeholder public values was added for preview and is not intended as a deployment secret.
- After configuration, the app rendered the new editorial shell with desktop left rail, compact utility search, responsive navigation structure, route cards, and updated poster/card styling.
- The live catalog preview reports the expected TMDB/Supabase data-unavailable warning in this sandbox; this is an environment limitation rather than a UI compile failure. Existing fallback content still renders into the rails.

## Personal-space verification checkpoint
- My List renders as a dedicated library workspace with a large editorial title, sync state, summary metrics, status filters, an action-oriented empty state, and a responsive grid/rail structure.
- Profile renders as an identity-led personal space with avatar, guest/cloud messaging, activity metrics, saved library section, preference anchor, and sync-safe actions.
- Both pages retain their existing links and state-driven messaging in the browser preview.

## Operations and collection verification checkpoint
- `/admin` correctly preserves the existing authorization boundary by redirecting an unauthenticated preview session to `/auth/sign-in?next=%2Fadmin`; no admin logic was bypassed.
- `/discover/movies` renders the new editorial collection title, filter toolbar, empty/error state, and explicit pagination controls with preserved route semantics.
- The local preview has no live Supabase/TMDB credentials, so catalog counts and content availability are expected to be empty or fallback-only in this environment.
