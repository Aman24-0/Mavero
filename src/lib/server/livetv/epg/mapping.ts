// ============================================================================
// Unified Live TV — Phase 3 EPG channel mapping (server-only, PURE).
//
// Deterministic, conservative resolution of guide channel identities onto
// canonical channels, using EXACTLY the Phase 1/2 model (no second registry,
// no duplicate catalogue):
//
//   1. EXPLICIT admin-managed overrides — rows of
//      `livetv_epg_channel_mappings` for THIS guide source (1:1 in both
//      directions per EPG source, DB-enforced). Authoritative when present.
//   2. tvgId auto-match — a guide channel id matches when the normalized
//      id equals the normalized `tvg_id` of source entries and EVERY mapped
//      entry with that tvg_id agrees on ONE canonical channel. Unmapped
//      entries never vote (conservative). Disagreement → ambiguous, never
//      a guess.
//   3. Otherwise unmatched — reported honestly, NEVER fabricated, and a
//      mapping is NEVER created or mutated as a side effect of ingestion
//      (an unmatched guide channel cannot corrupt a previously valid
//      mapping — Phase 3 brief §7).
//
// MATCHING RULES (brief §7):
//   * Identifiers match EXACTLY after safe normalization: Unicode NFKC +
//     trim. Case is significant (conservative: a case-insensitive match
//     would silently merge distinct identities; explicit admin mappings
//     remain the tool for exotic spellings).
//   * Channel display names are NEVER used as identity (Phase 1 D-3
//     posture, preserved verbatim).
//   * Provenance is preserved: the guide's own ids are never rewritten.
//
// PURE: no I/O, no writes, fully unit-testable. The persistence layer and
// the guide-query helpers consume the plan; nothing else does.
// ============================================================================

/** Normalizes an EPG identity for comparison (NFKC + trim; case-sensitive). */
export function normalizeEpgIdentity(raw: string): string {
        return raw.trim().normalize('NFKC');
}

export type EpgSourceChannelRow = {
        id: string;
        source_id: string;
        source_channel_id: string;
        canonical_channel_id: string | null;
        tvg_id: string | null;
        enabled: boolean;
};

export type EpgMappingRow = {
        epg_channel_id: string;
        channel_id: string;
};

export type EpgGuideMatchSource = 'explicit' | 'tvgid';

export type EpgGuideMatch = {
        status: 'matched' | 'unmatched' | 'ambiguous' | 'invalid';
        /** The resolved canonical channel (null unless matched). */
        channelId: string | null;
        /** Which mechanism resolved it (null unless matched). */
        source: EpgGuideMatchSource | null;
};

export type EpgMappingPlan = {
        /** One entry per guide channel id (document order; ids as-parsed). */
        matches: Map<string, EpgGuideMatch>;
        counts: {
                guideChannels: number;
                matched: number;
                viaExplicit: number;
                viaTvgId: number;
                unmatched: number;
                ambiguous: number;
                invalid: number;
        };
        /** Bounded diagnostic samples (ids as-parsed; never URLs, never secrets). */
        samples: {
                unmatched: string[];
                ambiguous: string[];
                invalid: string[];
        };
};

const SAMPLE_LIMIT = 50;

/** Channel-id parity with the DB CHECK (1..200, no whitespace/control). */
function isValidGuideChannelId(raw: string): boolean {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > 200) return false;
        if (/\s/.test(trimmed)) return false;
        return !/[\u0000-\u001f\u007f]/.test(trimmed);
}

/**
 * Plans the guide→canonical mapping for ONE guide document. Input reflects
 * the CURRENT database state (explicit mapping rows for this EPG source +
 source entries carrying a tvg_id across all sources) and the parsed guide
 * channel ids. Never mutates anything; the counts drive the refresh report.
 */
export function planEpgMapping(input: {
        guideChannelIds: readonly string[];
        explicitMappings: readonly EpgMappingRow[];
        sourceChannels: readonly EpgSourceChannelRow[];
}): EpgMappingPlan {
        // Explicit mappings: exact id first, normalized second.
        const explicitByExact = new Map<string, string>();
        const explicitByNormalized = new Map<string, Set<string>>();
        for (const row of input.explicitMappings) {
                if (!explicitByExact.has(row.epg_channel_id)) explicitByExact.set(row.epg_channel_id, row.channel_id);
                const normalized = normalizeEpgIdentity(row.epg_channel_id);
                let bucket = explicitByNormalized.get(normalized);
                if (!bucket) {
                        bucket = new Set<string>();
                        explicitByNormalized.set(normalized, bucket);
                }
                bucket.add(row.channel_id);
        }

        // tvgId votes: normalized tvg_id → set of canonical channels among MAPPED entries.
        const tvgVotes = new Map<string, Set<string>>();
        for (const entry of input.sourceChannels) {
                if (!entry.tvg_id || !entry.canonical_channel_id) continue;
                const normalized = normalizeEpgIdentity(entry.tvg_id);
                let bucket = tvgVotes.get(normalized);
                if (!bucket) {
                        bucket = new Set<string>();
                        tvgVotes.set(normalized, bucket);
                }
                bucket.add(entry.canonical_channel_id);
        }

        const matches = new Map<string, EpgGuideMatch>();
        const counts = { guideChannels: 0, matched: 0, viaExplicit: 0, viaTvgId: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
        const samples = { unmatched: [] as string[], ambiguous: [] as string[], invalid: [] as string[] };

        for (const guideId of input.guideChannelIds) {
                counts.guideChannels += 1;

                if (!isValidGuideChannelId(guideId)) {
                        counts.invalid += 1;
                        if (samples.invalid.length < SAMPLE_LIMIT) samples.invalid.push(guideId.slice(0, 200));
                        matches.set(guideId, { status: 'invalid', channelId: null, source: null });
                        continue;
                }

                // 1. Explicit overrides — authoritative.
                const normalized = normalizeEpgIdentity(guideId);
                const exactTarget = explicitByExact.get(guideId);
                if (exactTarget) {
                        counts.matched += 1;
                        counts.viaExplicit += 1;
                        matches.set(guideId, { status: 'matched', channelId: exactTarget, source: 'explicit' });
                        continue;
                }
                const normalizedTargets = explicitByNormalized.get(normalized);
                if (normalizedTargets && normalizedTargets.size === 1) {
                        counts.matched += 1;
                        counts.viaExplicit += 1;
                        matches.set(guideId, { status: 'matched', channelId: [...normalizedTargets][0]!, source: 'explicit' });
                        continue;
                }
                if (normalizedTargets && normalizedTargets.size > 1) {
                        // Admin-managed rows disagree after normalization — never guess.
                        counts.ambiguous += 1;
                        if (samples.ambiguous.length < SAMPLE_LIMIT) samples.ambiguous.push(guideId);
                        matches.set(guideId, { status: 'ambiguous', channelId: null, source: null });
                        continue;
                }

                // 2. tvgId auto-match — unanimous mapped entries only.
                const votes = tvgVotes.get(normalized);
                if (votes && votes.size === 1) {
                        counts.matched += 1;
                        counts.viaTvgId += 1;
                        matches.set(guideId, { status: 'matched', channelId: [...votes][0]!, source: 'tvgid' });
                        continue;
                }
                if (votes && votes.size > 1) {
                        counts.ambiguous += 1;
                        if (samples.ambiguous.length < SAMPLE_LIMIT) samples.ambiguous.push(guideId);
                        matches.set(guideId, { status: 'ambiguous', channelId: null, source: null });
                        continue;
                }

                // 3. Unmatched — honest gap, never a fabricated mapping.
                counts.unmatched += 1;
                if (samples.unmatched.length < SAMPLE_LIMIT) samples.unmatched.push(guideId);
                matches.set(guideId, { status: 'unmatched', channelId: null, source: null });
        }

        return { matches, counts, samples };
}
