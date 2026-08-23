# MAVERO Phase 7D Completion Report — Experimental Vidsrc Embed

**Project:** MAVERO

**Phase:** 7D — First Verified Streaming Provider Integration under the revised user-supplied provider policy

**Status:** Implemented as one **experimental, unverified, disabled-by-default embed provider**. No Phase 7E work has started.

> Vidsrc is not described as licensed, endorsed, or officially approved by MAVERO. The implementation uses only the ordinary public embed URL pattern supplied by the user and does not remove provider-controlled advertisements, redirects, popups, or cross-origin player behavior.

## 1. Technical integration type

Vidsrc is integrated as an **embed** provider. It is never classified as direct media. The adapter returns a normalized Phase 7B `AdapterResult` with `type: "embed"`, and Phase 7B performs the final safe URL validation before the Phase 7C PlayerShell receives the result.

The ordinary public patterns verified for the requested candidate are:

```text
Movie:   https://vidsrc.wiki/embed/movie/{tmdb_id}/
TV:      https://vidsrc.wiki/embed/tv/{tmdb_id}/{season}/{episode}/
```

The public movie and TV episode pages loaded as VidSrc pages and exposed a visible server selector. No hidden media URL, internal player request, cross-origin DOM, or protected endpoint was inspected.

## 2. Provider adapter

The isolated adapter is located at `src/lib/server/resolver/vidsrc.ts` and is registered through `src/lib/server/resolver/adapters.ts` under the adapter ID `vidsrc-embed`.

The adapter:

| Responsibility | Implementation |
|---|---|
| Integration type | `embed` only |
| Adapter ID | `vidsrc-embed` |
| Movie path | `/embed/movie/{tmdb_id}/` |
| TV episode path | `/embed/tv/{tmdb_id}/{season}/{episode}/` |
| Anime | Explicitly unsupported |
| URL origin | Exact `https://vidsrc.wiki` allowlist |
| URL protocol | HTTPS only through existing resolver validation |
| Source result | Normalized embed result only |
| Provider-specific UI | None; existing PlayerShell remains unchanged |

Resolver dispatch now checks the trusted database `adapter_id` before falling back to the generic integration type. This keeps Vidsrc-specific mapping on the server and prevents the browser from selecting an adapter or constructing a provider URL.

## 3. Identifier mapping

Vidsrc uses TMDB identifiers for the requested URL pattern. The adapter consumes `ContentIdentifiers.tmdbId`, which is populated by the existing normalized metadata layer. The browser does not perform TMDB/IMDb/AniList conversion.

A movie request requires `tmdbId`. A TV request requires `tmdbId`, `season`, and `episode`. Missing identifiers produce the existing typed resolver error rather than a malformed provider URL.

## 4. Movie support

Movie support is implemented through the server-side template:

```text
https://vidsrc.wiki/embed/movie/{tmdb_id}/
```

The adapter validates the exact configured template, resolves the TMDB identifier through the allowlisted placeholder resolver, validates the final HTTPS origin, and returns an embed `SourceResult`.

## 5. TV and episode support

TV episode support is implemented through the server-side template:

```text
https://vidsrc.wiki/embed/tv/{tmdb_id}/{season}/{episode}/
```

The existing Phase 7B request parser validates the episode scope. The adapter rejects missing or invalid episode context through the existing typed error model. The Phase 7C PlayerShell remains responsible for episode navigation and progress; no provider-specific progress storage was added.

## 6. Anime support

Anime support is explicitly disabled for Vidsrc in both provider and source capabilities. Anime requests return `UNSUPPORTED_MEDIA_TYPE`. MAVERO’s future provider architecture remains capable of adding anime through another separately approved adapter.

## 7. Database configuration

Migration `supabase/migrations/20260820018000_phase7d_vidsrc_experimental.sql` seeds the provider and source through the existing Phase 7A registry architecture.

| Field | Provider | Source |
|---|---|---|
| Name/slug | `Vidsrc` / `vidsrc` | `Vidsrc Embed` / `vidsrc-embed` |
| Status | `experimental` | `experimental` |
| Enabled | `false` | `false` |
| Visibility | — | `public` when explicitly enabled |
| Integration type | `embed` | `embed` |
| Adapter ID | `vidsrc-embed` | — |
| Identifier mode | — | `tmdb_id` |
| Anime capability | `false` | `false` |
| Direct capability | `false` | `false` |
| Allowed embed origin | `https://vidsrc.wiki` | `https://vidsrc.wiki` |

The migration was applied to the MAVERO Supabase project `whekhqimzrafhsrmswbn`. Post-application verification confirmed the provider/source are experimental and disabled. The public mirror query returned no Vidsrc row while disabled.

## 8. Admin controls

No provider-specific frontend button was added. The existing Admin provider/source management controls remain the activation surface. An Admin can review and change provider/source enabled state, status, visibility, ordering, and categories through the Phase 7A architecture.

A transactional lifecycle check temporarily enabled the Vidsrc provider/source, confirmed that the public mirror exposed the source while enabled, and rolled the transaction back. A post-rollback query confirmed:

```text
provider_enabled: false
source_enabled: false
status: experimental
public_mirror_id: null
```

The production configuration therefore remains disabled by default and requires explicit Admin action.

## 9. Resolver integration

The end-to-end server flow remains:

```text
Watch page
  → sourceId only
  → POST /api/playback/resolve
  → trusted Supabase provider/source lookup
  → adapter_id = vidsrc-embed
  → Vidsrc embed adapter
  → exact-origin and HTTPS validation
  → normalized embed SourceResult
  → Phase 7C PlayerShell
```

The browser cannot override provider templates, supply an arbitrary provider URL, select a different adapter ID, or request direct playback from this provider.

## 10. Player integration

The Phase 7C PlayerShell was not modified for Vidsrc. It already supports normalized embed results through its controlled iframe path. The player continues to provide its own Back, Retry, Change Source, fullscreen, focus, loading, and error states.

Provider-controlled advertising, redirects, popups, and navigation remain inside the provider boundary. No ad-removal button, redirect bypass, popup circumvention, cross-origin DOM manipulation, hidden stream extraction, DRM bypass, anti-bot bypass, CAPTCHA bypass, or iframe permission escalation was implemented.

MAVERO can request fullscreen and best-effort orientation for its own player shell where the browser allows it. It cannot universally force a cross-origin provider iframe to rotate or change its internal layout.

## 11. Security boundaries

The implementation preserves these protections:

- Exact HTTPS origin allowlisting for `https://vidsrc.wiki`.
- No arbitrary server-side URL fetching.
- No private-hostname or credential-bearing URL acceptance.
- No client-supplied raw playback URL.
- No direct-media classification.
- No hidden media URL extraction.
- No cross-origin DOM inspection or player manipulation.
- No DRM, authentication, paywall, access-control, anti-bot, CAPTCHA, or CORS circumvention.
- No provider secrets or new credentials.
- No provider-specific data stored in public configuration beyond safe capabilities and source identity.
- Disabled provider/source rejected by the resolver.
- Experimental status requires explicit capability opt-in and enabled provider/source state.

## 12. Verification status

The revised policy permits an unverified user-supplied provider to be implemented through its ordinary public interface when the provider is marked experimental/unverified and the implementation does not circumvent technical protections. Vidsrc is therefore marked **experimental and unverified**, not licensed, authorized, endorsed, or production-approved by MAVERO.

The ordinary public movie and TV/episode pages were minimally verified in a browser. Both supplied URL patterns loaded as Vidsrc pages and exposed a visible `Pro 1` server selector. The verification did not inspect internal player behavior or extract media URLs.

## 13. Known limitations

Vidsrc is disabled by default and is not presented as an authorized or licensed catalog. Public-page reachability does not guarantee playback availability, content rights, stable response behavior, or device compatibility. Provider-controlled ads, redirects, popups, server selection, and player layout remain outside MAVERO control. The provider is embed-only; no direct media URL is returned. Anime is disabled. Fullscreen/orientation behavior inside a cross-origin provider iframe cannot be universally forced.

## 14. Test results

The deterministic Vidsrc suite passed:

```text
Phase 7D Vidsrc adapter tests passed.
```

Coverage includes:

| Scenario | Result |
|---|---|
| Valid movie TMDB ID | Passed; normalized embed URL |
| Valid TV episode | Passed; normalized embed URL with season/episode |
| Missing TMDB identifier | Passed; typed missing-identifier failure |
| Anime request | Passed; unsupported-media failure |
| Malicious configured origin/template | Passed; invalid-template failure |
| Disabled provider | Passed; provider-disabled failure |
| Disabled source | Passed; source-disabled failure |
| Experimental provider/source enabled with opt-in | Passed |
| Experimental provider/source without opt-in | Passed; provider-disabled failure |
| Direct classification attempt | Passed; adapter remains embed-only |
| Public mirror disabled state | Passed; no public Vidsrc row |
| Admin lifecycle transaction | Passed; temporary exposure rolled back |

## 15. Browser verification

The supplied movie and TV episode embed URLs were opened through ordinary browser navigation. Both rendered a VidSrc page with a visible server selector. No internal frame inspection or provider-control manipulation was performed.

The MAVERO PlayerShell integration is covered by the normalized adapter tests and the existing Phase 7C browser QA. Since the database source remains disabled by default, it does not appear in normal public source selection until an Admin explicitly enables it. This is intentional.

## 16. Regression validation

The following available suites passed after the Vidsrc integration:

- Phase 4 progress tests.
- Phase 6 Auth safety tests.
- Phase 7A validation tests.
- Phase 7A public configuration contract tests.
- Phase 7B resolver tests.
- Phase 7C player contract tests.
- Phase 7D Vidsrc adapter tests.
- `pnpm check` with 0 errors and 0 warnings.
- `pnpm build` using `@sveltejs/adapter-netlify`.
- `git diff --check`.

The existing two-user Phase 6 RLS fixture remains dependent on a User B credential that previously returned `Invalid login credentials`; that external fixture-state issue is unrelated to the Vidsrc adapter.

## 17. Files changed

| File | Change |
|---|---|
| `src/lib/server/resolver/vidsrc.ts` | Isolated experimental Vidsrc embed adapter |
| `src/lib/server/resolver/adapters.ts` | Adapter-ID registry |
| `src/lib/server/resolver/core.ts` | Trusted adapter-ID dispatch and explicit experimental status handling |
| `src/lib/server/resolver/types.ts` | Optional adapter ID and adapter-by-ID dependency contract |
| `supabase/migrations/20260820018000_phase7d_vidsrc_experimental.sql` | Disabled-by-default provider/source seed migration |
| `scripts/phase7d_vidsrc_test.ts` | Deterministic Vidsrc resolver/security tests |
| `./PHASE_7D_PROVIDER_RESEARCH_NOTES.md` | Current ordinary-interface verification notes |
| `./MAVERO_PHASE_7D_REPORT.md` | This completion report |

No Phase 7A, 7B, or 7C player architecture was redesigned. No extra dependency was added.

## 18. Build result

```text
pnpm build — passed
Using @sveltejs/adapter-netlify
```

## 19. Svelte-check result

```text
pnpm check
svelte-check found 0 errors and 0 warnings
```

## 20. Final phase boundary

The revised Phase 7D implementation is complete. Vidsrc remains **experimental and disabled by default**. No second provider, automatic fallback, health monitoring, ranking, provider optimization, or Phase 7E work has started.

MAVERO stops after revised Phase 7D and waits for explicit approval before Phase 7E.

## References

[1]: https://vidsrc.domains/ "Vidsrc public domain-directory page reviewed during candidate evaluation"
[2]: https://vidsrc.wiki/embed/movie/533535/ "Vidsrc movie embed page minimally verified"
[3]: https://vidsrc.wiki/embed/tv/79744/1/1/ "Vidsrc TV episode embed page minimally verified"
[4]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe "MDN iframe element reference"
[5]: https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API "MDN Fullscreen API reference"
