# MAVERO Phase 7B Completion Report

**Author:** Manus AI  
**Project:** MAVERO  
**Repository:** [Aman24-0/Mavero](https://github.com/Aman24-0/Mavero)  
**Phase boundary:** Phase 7B only. Phase 7C, 7D, and 7E were not started.

## Executive summary

Phase 7B adds a secure, typed, provider-agnostic Source Resolver layer on top of the approved Phase 7A registry. The browser now submits only a minimal playback request containing a source identifier, content identifier, media type, and optional episode scope. The server loads the authoritative provider and source configuration, validates status and capabilities, selects a typed adapter, resolves only allowlisted templates or mock adapter results, validates the normalized result, and returns a safe `direct`, `embed`, `unavailable`, or controlled error response.

No real third-party streaming provider was integrated. No provider endpoint was called, no provider was scraped, no DRM or access-control restriction was bypassed, no cross-origin embed was inspected or manipulated, and no Mavero Player was implemented. The existing watch route remains a non-playing shell; Phase 7B only adds an explicit source-preparation request and displays the normalized result status.

## 1. Implemented architecture

The implementation follows this boundary:

> MAVERO UI → playback request → server-side Source Resolver → Phase 7A provider/source configuration → typed Provider Adapter → normalized safe SourceResult → future Mavero Player.

| Layer | Implementation | Responsibility |
|---|---|---|
| Browser request | `POST /api/playback/resolve` | Sends only source ID, content ID, media type, and optional season/episode. |
| Server wrapper | `src/lib/server/resolver/service.ts` | Loads private registry configuration with a server-only Supabase credential and normalized content details. |
| Pure resolver core | `src/lib/server/resolver/core.ts` | Enforces provider/source state, visibility, capability, episode, adapter, result, and expiry policies. |
| Request and identifier layer | `identifiers.ts` | Validates IDs, media type, season/episode scope, and normalized TMDB/IMDb/AniList/MAL/internal identifiers. |
| Template layer | `template.ts` | Allows only explicit placeholders; does not execute expressions, JavaScript, or functions. |
| Adapter layer | `adapters.ts` | Defines typed template, direct, embed, API, custom, and mock adapters. API/custom adapters are intentionally inert. |
| Safety layer | `safe-url.ts` | Validates protocols, credentials, private destinations, embed origins, provider endpoints, and expiry timestamps. |
| Client result | `SourceResult` | Exposes only normalized safe playback metadata and user-safe errors. |

## 2. Typed source-resolution contract

The resolver accepts a `ResolverRequest` with `sourceId`, `contentId`, `mediaType`, and optional positive integer `season` and `episode`. It returns a normalized `SourceResult` with `type`, `url`, `providerId`, `sourceId`, `mediaType`, optional subtitles, qualities, safe headers, expiry, and safe metadata. The result type is restricted to `direct`, `embed`, `unavailable`, or `error`.

The resolver does not accept provider configuration, templates, API endpoints, target URLs, or credentials from the browser. The provider and source records are loaded server-side from the Phase 7A registry. If the server-only `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` is absent, private registry lookup does not fall back to revoked anonymous base-table access; the endpoint returns a controlled unavailable result instead.

## 3. Identifier and episode handling

The normalized identifier layer supports the existing content model’s internal ID, TMDB ID, IMDb ID, AniList ID, MAL ID, and slug fields. Provider-specific identifier modes are resolved explicitly. Missing identifiers produce `MISSING_IDENTIFIER`; identifiers are never fabricated.

Movie requests reject any season or episode fields. Series and anime requests reject partial, non-integer, non-positive, or unreasonable episode scopes. Episode fields are omitted from the normalized request when they are not supplied.

## 4. Template security

Templates support only the following allowlisted placeholders:

| Placeholder | Source |
|---|---|
| `{tmdb_id}` | Normalized TMDB identifier |
| `{imdb_id}` | Normalized IMDb identifier |
| `{anilist_id}` | Normalized AniList identifier |
| `{mal_id}` | Normalized MAL identifier |
| `{content_id}` | Internal MAVERO content ID |
| `{slug}` | Requested content slug |
| `{season}` | Validated season number |
| `{episode}` | Validated episode number |

Unknown placeholders, empty templates, and newline-containing templates become controlled configuration errors. Templates cannot execute JavaScript, arbitrary expressions, functions, or code. Values are URI-encoded before interpolation.

## 5. Provider adapter model

The adapter contract is typed and provider-agnostic. Template and direct adapters can produce validated direct results; embed adapters produce validated embed results; API and custom adapters intentionally return unavailable because Phase 7B does not integrate real provider APIs. A test-only mock adapter factory verifies the contract without adding credentials or third-party endpoints.

Embed results are accepted only when their HTTPS origin is present in the source’s explicit `allowed_embed_origins` capability metadata. A source cannot be silently reclassified from embed to direct, and the resolver never attempts to inspect or manipulate a cross-origin iframe.

## 6. URL and SSRF protections

Playback URLs require HTTPS and reject malformed URLs, `javascript:`, `data:`, filesystem URLs, embedded credentials, localhost, loopback, link-local, private IPv4 ranges, private IPv6 ranges, `.local`, and `.internal` destinations. Provider endpoints use a separate HTTPS-only validation path with the same private-destination restrictions.

Phase 7B does not perform server-side provider HTTP requests. Consequently, no generic `fetch(userProvidedUrl)` path exists, no browser-provided URL becomes a server fetch target, and redirect-following behavior is not activated. The API/custom adapter abstraction is ready for a later approved provider phase to add a constrained server-side request policy.

## 7. Server endpoint and watch-shell integration

The new endpoint is:

```text
POST /api/playback/resolve
```

The response is either:

```json
{
  "ok": true,
  "source": {
    "type": "direct",
    "url": "https://trusted.example/stream.m3u8",
    "providerId": "…",
    "sourceId": "…",
    "mediaType": "movie"
  }
}
```

or a safe error such as:

```json
{
  "ok": false,
  "error": {
    "code": "RESOLUTION_UNAVAILABLE",
    "message": "This source is not available yet."
  }
}
```

All endpoint responses use `Cache-Control: no-store`. Internal stack traces, Supabase errors, credentials, service-role keys, private templates, and raw provider responses are not returned to the browser.

The watch shell now offers **Prepare selected source** when sanitized public sources exist. It does not start playback, attach a player, construct provider URLs, or activate embeds. In the current empty configuration state it displays that no public sources are configured.

## 8. Error model

The resolver exposes stable, user-safe error codes including `INVALID_REQUEST`, `SOURCE_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `PROVIDER_DISABLED`, `SOURCE_DISABLED`, `SOURCE_MAINTENANCE`, `UNSUPPORTED_MEDIA_TYPE`, `MISSING_IDENTIFIER`, `INVALID_TEMPLATE`, `INVALID_SOURCE_URL`, `INVALID_PROVIDER_ENDPOINT`, `PROVIDER_RESPONSE_INVALID`, `SOURCE_EXPIRED`, `RESOLUTION_UNAVAILABLE`, and `INTERNAL_RESOLUTION_ERROR`.

Internal exceptions are converted to safe messages. Diagnostic causes are logged server-side only when appropriate; they are never serialized into the client response.

## 9. Security and configuration review

Phase 7B preserves the Phase 7A rule that the browser cannot supply complete provider configuration. Provider and source status are revalidated server-side. Providers must be enabled and active. Sources must be enabled, public, and active; maintenance or unavailable records are rejected, and experimental playback requires explicit capability permission.

The new server-only environment template entry is:

```text
PRIVATE_SUPABASE_SERVICE_ROLE_KEY=...
```

It is documented as private, is not prefixed with `PUBLIC_`, and was not added to the client bundle. The client bundle credential scan passed. No real provider names, researched provider endpoints, or generic user-controlled URL fetch patterns were found in the resolver implementation.

## 10. Validation performed

| Validation | Result |
|---|---|
| Phase 7B resolver contract tests | Passed. Templates, adapters, identifiers, capability/status gates, URL validation, SSRF guards, and safe errors were exercised. |
| Phase 7A validation tests | Passed. |
| Phase 7A public configuration contract test | Passed. |
| SvelteKit/TypeScript diagnostics | Passed with 0 errors and 0 warnings. |
| Cloudflare-adapted production build | Passed with `@sveltejs/adapter-cloudflare`. |
| Endpoint malformed request smoke test | Passed with HTTP 400 and `INVALID_REQUEST`. |
| Endpoint valid-shaped request without private resolver credential | Passed with HTTP 503 and `RESOLUTION_UNAVAILABLE`. |
| Endpoint response headers | Passed with JSON content type and `Cache-Control: no-store`. |
| Client private-credential scan | Passed. |
| Git whitespace check | Passed. |
| Real provider endpoint call | Not performed by design. |
| Playback activation or Player implementation | Not performed by design. |

The local Cloudflare Worker preview was stopped after smoke testing. No Worker deployment was performed during Phase 7B because Wrangler OAuth authorization remained incomplete; the Cloudflare adapter and `wrangler.jsonc` configuration are present for a later authorized deployment.

## 11. Files added or changed

The main Phase 7B additions are:

| Area | Files |
|---|---|
| Resolver core | `src/lib/server/resolver/types.ts`, `errors.ts`, `identifiers.ts`, `safe-url.ts`, `template.ts`, `adapters.ts`, `core.ts`, `service.ts` |
| Endpoint | `src/routes/api/playback/resolve/+server.ts` |
| Watch shell | `src/routes/watch/[type]/[id]/+page.svelte` |
| Environment | `.env.example` |
| Tests | `scripts/phase7b_resolver_test.ts`, `tsconfig.scripts.json` |
| Cloudflare portability | `@sveltejs/adapter-cloudflare`, `wrangler.jsonc`, `worker-configuration.d.ts`, adjusted build/check configuration |
| Phase 7A carried changes | Registry services, Admin routes, migrations, generated Supabase types, sanitized public configuration, and Phase 7A tests remain in the working tree for the Phase 7A commit. |

## 12. Known limitations and explicit non-goals

Phase 7B does not integrate TMDB, AniList, or any real streaming provider as a playback provider. It does not resolve third-party API URLs, perform redirects, bypass authentication or paywalls, remove provider advertisements, bypass DRM, inspect cross-origin embeds, persist temporary playback URLs, forward provider secrets, or implement the Mavero Player.

A production deployment must provide the private Supabase service-role credential to the Cloudflare Worker through a server-side secret mechanism. That credential must never be placed in `PUBLIC_` variables, committed to Git, or returned from the resolver endpoint.

## 13. Recommended next phase

Phase 7B is complete at its approved boundary. The next possible phase is **Phase 7C**, but it requires explicit approval. Phase 7C should select and integrate only an authorized, legitimate provider under a separately reviewed security and legal scope. No Phase 7C work has been started.

## References

[1]: https://github.com/Aman24-0/Mavero "MAVERO GitHub repository"
[2]: https://developers.cloudflare.com/workers/ "Cloudflare Workers documentation"
[3]: https://developers.cloudflare.com/workers/wrangler/commands/ "Cloudflare Wrangler command documentation"
