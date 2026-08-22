# MAVERO Phase 7G Completion Report

## Outcome

Phase 7G, **Provider Ranking + Optimization**, is complete. The implementation adds a deterministic provider/source-pair ranking layer above the existing Phase 7F health and bounded fallback system. It does not replace the Phase 7F health model, does not duplicate fallback logic, and does not add providers, scraping, source discovery, direct stream extraction, HLS/DASH extraction, or 7H work.

The implementation is committed to GitHub `main` and deployed to [https://mavero1.netlify.app](https://mavero1.netlify.app). The final provider registry remains governed by its existing Admin enabled/disabled state.

## Ranking architecture

Automatic playback now follows this sequence: load the ordered eligible registry candidates, retrieve one aggregate health snapshot for the candidate sources, filter administrative and runtime eligibility, calculate deterministic scores, order the remaining provider/source pairs, and pass the ordered candidates to the existing Phase 7F bounded fallback engine. Phase 7G ranks; Phase 7F attempts and records resolver outcomes.

Ranking occurs at the **provider/source pair** level because the Phase 7F health table is keyed by `provider_id` and `source_id`. The existing source `ordering` remains the first stable tie-break after equal scores, followed by stable provider ID and source ID. No random selection, adaptive permanent reorder, latency leaderboard, or user-facing source-order control was introduced.

## Inputs and eligibility rules

The ranking input uses only signals that MAVERO legitimately observes: administrative enabled state, source visibility and lifecycle status, requested content type capability, runtime health state, success count, failure count, consecutive failures, last checked timestamp, and last successful resolution timestamp.

A candidate is excluded before scoring if its provider is administratively disabled, its source is disabled or non-public, lifecycle rules reject playback, the provider or source explicitly rejects the requested content type, runtime cooldown is active, or runtime state is unhealthy. Administrative disabled state remains authoritative and cannot be overridden by historical ranking data. Unknown and degraded candidates remain eligible.

## Scoring model

The score is bounded to `[0, 1]` and is deliberately simple:

```text
score = 0.30 × freshness-adjusted health state
      + 0.45 × freshness-adjusted smoothed reliability
      + 0.15 × recent-success signal
      + 0.10 × freshness-adjusted stability
```

Healthy, degraded, and unknown states contribute health baselines of `1.0`, `0.65`, and `0.50`. Reliability uses Laplace smoothing, `(success_count + 1) / (success_count + failure_count + 2)`, and is blended toward neutral `0.5` using a 30-day exponential half-life based on `last_checked_at`. The recent-success signal decays toward neutral using a 14-day half-life based on `last_success_at`. Stability decreases as consecutive failures approach three.

A source with no health row receives a deterministic neutral exploration score of `0.55`. It is neither automatically first nor automatically last; existing source order resolves equal-score cases. This avoids starving new sources without allowing unknown history to outrank an established healthy source by default.

## Fallback integration

Automatic ranking supplies the ordered eligible list to `resolveWithBoundedFallback`. The fallback layer preserves its existing duplicate-provider avoidance, first-usable-result behavior, health outcome recording, and bounded attempt policy. The maximum automatic attempt count is the number of ranked candidates, which is never greater than the enabled ordered source list.

Manual source selection continues to send `enableFallback: false`. In that path ranking is bypassed and only the explicitly selected source is attempted. The existing Sources drawer and PlayerShell were not redesigned.

## Recent-data and observability policy

The implementation does not create per-click, per-heartbeat, per-frame, or per-player-event analytics rows. It reuses the existing aggregate Phase 7F health records and performs one source-health snapshot query per automatic resolver initialization. Older observations lose influence through decay rather than permanently dominating newer behavior.

MAVERO does not treat iframe presence as video playback success. Third-party player internals, cross-origin playback state, hidden player latency, and inaccessible events remain outside the observable boundary. Only resolver-level success and failure signals influence the score.

## Admin behavior

The existing Admin provider registry continues to show runtime health labels and freshness information. A context-free global rank score is intentionally not displayed because the rank depends on requested media type, the current candidate set, and the current health snapshot. No ranking controls, charts, or user-facing ranking overrides were added.

## Tests and verification

The complete repository verification passed:

```text
pnpm check
pnpm test
pnpm build
```

`pnpm check` completed with zero errors and zero warnings. `pnpm test` passed all Phase 7E provider tests, Phase 7F health/fallback tests, and the new Phase 7G ranking test. `pnpm build` completed successfully with the Netlify adapter.

The focused Phase 7G test covers healthy reliability ordering, cooldown exclusion, Admin-disabled exclusion, capability filtering, unknown-provider neutral treatment, recent performance, stale history decay, deterministic ordering, stable tie-breaking, manual selection bypass, ranked candidates flowing into Phase 7F fallback, all-candidate exhaustion, and bounded no-loop behavior.

The production homepage rendered successfully after deployment. The Admin provider registry rendered with the existing controls and runtime health labels, including `Health: Unknown` for unobserved providers and `Health: Healthy` for Vidsrc after an observed successful resolver path. The live verification notes are stored in `docs/phase7g-browser-verification.md`.

## Git and deployment

| Item | Result |
|---|---|
| Implementation commit | `022a55d` |
| Commit message | `feat: Phase 7G provider ranking and optimization` |
| Push result | Pushed successfully to `origin/main` |
| Final deployment | Netlify deployment `6a89171dc923eadb8cae9989` |
| Deployment state | Ready / published |
| Production URL | [https://mavero1.netlify.app](https://mavero1.netlify.app) |
| Supabase migration | No new migration required; existing `streaming_provider_health` semantics preserved |
| Working tree | Clean after documentation commit |

## Files changed

| Area | Files |
|---|---|
| Ranking engine | `src/lib/server/resolver/ranking.ts` |
| Automatic resolver integration | `src/lib/server/resolver/service.ts` |
| Health snapshot helper | `src/lib/server/streaming/health-service.ts` |
| Focused ranking tests | `scripts/phase7g_ranking_test.ts` |
| Test chain | `package.json` |
| Design policy | `docs/phase7g-ranking-design.md` |
| Browser verification | `docs/phase7g-browser-verification.md` |

## Limitations and explicit stop condition

The ranking system can optimize resolver reliability and recency but cannot observe third-party iframe internal playback, hidden media state, inaccessible cross-origin events, or unexposed quality information. Direct quality ranking, stream extraction, scraper crawling, subtitle discovery, adaptive source crawling, and provider-specific implementation changes remain out of scope.

**Phase 7G is complete. MAVERO is stopped here. The Stremio-style Streaming Resolver/Scraper System and Phase 7H have not been started.**
