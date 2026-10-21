# MAVERO Phase 7G ranking policy

Phase 7G ranks provider/source pairs only for automatic playback. Explicit source selection continues to bypass ranking and keeps Phase 7F fallback disabled.

## Eligibility order

The ranking input is filtered before scoring. A candidate is excluded when its provider or source is administratively disabled, the provider/source is not publicly playable under the existing lifecycle rules, the requested content type is explicitly disabled by either capability object, runtime health is currently in cooldown, or runtime health is unhealthy under the Phase 7G policy. Unknown and degraded candidates remain eligible. No ranking signal can re-enable an administratively disabled record.

## Score

The score is deterministic and bounded to `[0, 1]`:

```text
score = 0.30 × health component
      + 0.45 × recency-adjusted reliability
      + 0.15 × recent-success component
      + 0.10 × stability component
```

The health component is `1.0` for healthy, `0.65` for degraded, and `0.50` for unknown. Cooldown and unhealthy states are filtered before scoring. Reliability uses Laplace smoothing, `(success_count + 1) / (success_count + failure_count + 2)`, and is blended toward the neutral value `0.5` using exponential freshness over a 30-day half-life derived from `last_checked_at`. The recent-success component uses a 14-day exponential decay from `last_success_at`; candidates without a success observation receive the neutral value `0.5`. Stability is `1 - min(consecutive_failures / 3, 1)`.

This model uses only resolver-observable aggregate data. It does not infer video playback success from iframe presence, does not use inaccessible third-party player latency, and does not create click- or heartbeat-level analytics rows.

## Unknown and stale policy

A candidate without health history receives a neutral score of `0.55` and remains eligible. It is not automatically first or last; the existing source order breaks equal scores. Historical success and failure counts lose influence as `last_checked_at` ages, so stale history cannot permanently dominate current behavior.

## Stability and fallback

Candidates are ordered by descending score, then by the existing supplied source order, then by stable provider ID and source ID. The ranked list is passed to the existing Phase 7F bounded fallback engine. Phase 7G does not duplicate retry logic, does not introduce infinite loops, and keeps duplicate-provider avoidance in Phase 7F.

Ranking is performed from one health snapshot query per automatic playback initialization. The Admin UI continues to show runtime health; it does not display a context-free rank score because rank depends on requested content type and the current eligible candidate set.
