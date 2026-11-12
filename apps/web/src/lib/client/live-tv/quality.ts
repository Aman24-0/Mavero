// LT-18 — Live TV quality selection: Mavero-owned normalized model (pure).
//
// SINGLE SOURCE OF TRUTH for turning Shaka's variant tracks into the small,
// SAFE quality model the UI may see. The engine (player.ts) reads Shaka's
// `getVariantTracks()` and hands the RAW (untrusted) array HERE; only the
// validated, deduplicated, sorted output of this module ever leaves the
// engine. A raw Shaka track object never reaches the UI.
//
// SECURITY CONTRACT (mirrors player.ts / plan §10/§15):
//   * Every numeric field is validated (finite numbers only); malformed
//     entries are dropped, never repaired.
//   * Only id/label/width/height/bandwidth are exposed — never track URIs,
//     codecs strings, language arrays or any other raw track material, and
//     obviously never signed manifest URLs or ClearKey values (this module
//     cannot even see them: it only receives variant-track metadata).
//   * Labels are built from validated numbers ONLY (`1080p`) or a safe
//     bandwidth fallback (`2500 kbps`) — nothing is interpolated from
//     upstream strings.
//
// DEDUPLICATION (LT-18 brief §2): multiple variants at the SAME resolution
// are ONE visible quality choice; the representative raw track is chosen
// DETERMINISTICALLY (active first, then highest bandwidth, then lowest id)
// so a given manifest always maps to the same representative.
//
// SSR-safe: a pure module, no browser access, importable under Node (the
// LT-18 quality suite imports it exactly like the SSR server would).

/** Normalized, UI-safe quality option (the ONLY quality shape the UI sees). */
export type LiveTvQualityOption = {
        /** Shaka variant-track id of the REPRESENTATIVE track for this quality. */
        id: number;
        /** Safe label: `1080p`-style when height is known, else a bandwidth fallback. */
        label: string;
        width?: number;
        height?: number;
        bandwidth?: number;
};

/** The engine's full quality snapshot (options + which is active + ABR mode). */
export type LiveTvQualitySnapshot = {
        /** Unique quality options, sorted from highest to lowest quality. */
        options: LiveTvQualityOption[];
        /** The representative track id of the currently active quality (null = unknown). */
        activeId: number | null;
        /** True while Shaka ABR owns the selection (the default; "Auto"). */
        auto: boolean;
};

/** The empty snapshot (no session / no variant info / teardown). */
export function emptyLiveTvQualitySnapshot(): LiveTvQualitySnapshot {
        return { options: [], activeId: null, auto: true };
}

/** True for a finite non-negative number (ids, dims and bandwidth are >= 0). */
function isFiniteNonNegative(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** True for a finite POSITIVE number (a usable height/bandwidth is > 0). */
function isFinitePositive(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Safe label for one quality tier: `1080p` when the height is known, else a
 * bandwidth-based fallback (`2500 kbps`). The label derives EXCLUSIVELY from
 * validated numbers — never from upstream strings.
 */
export function liveTvQualityLabel(height: number | undefined, bandwidth: number | undefined): string {
        if (height !== undefined) return `${height}p`;
        if (bandwidth !== undefined) return `${Math.round(bandwidth / 1000)} kbps`;
        return 'Auto';
}

type PreparedTrack = {
        id: number;
        active: boolean;
        width?: number;
        height?: number;
        bandwidth?: number;
};

/**
 * Validate one raw variant-track entry. Returns null for anything without a
 * usable id (malformed metadata is ignored safely — LT-18 brief §2), or
 * without ANY usable quality signal (no height AND no bandwidth: there is
 * nothing truthful to label or sort by).
 */
function prepareTrack(raw: unknown): PreparedTrack | null {
        if (!raw || typeof raw !== 'object') return null;
        const track = raw as Record<string, unknown>;
        if (!isFiniteNonNegative(track.id)) return null;
        const prepared: PreparedTrack = { id: track.id, active: track.active === true };
        const width = track.width;
        const height = track.height;
        const bandwidth = track.bandwidth;
        if (isFinitePositive(width)) prepared.width = Math.round(width);
        if (isFinitePositive(height)) prepared.height = Math.round(height);
        if (isFinitePositive(bandwidth)) prepared.bandwidth = Math.round(bandwidth);
        if (prepared.height === undefined && prepared.bandwidth === undefined) return null;
        return prepared;
}

/** Quality-sort key: height first (desc), bandwidth as the tiebreak (desc). */
function qualityRank(track: { height?: number; bandwidth?: number }): number {
        return (track.height ?? 0) * 1e9 + (track.bandwidth ?? 0);
}

/**
 * Derive the normalized, DEDUPLICATED, sorted quality options from Shaka's
 * raw variant-track array (anything unknown is ignored safely).
 *
 * Determinism: for equivalent resolutions the representative is the ACTIVE
 * track if one exists, else the highest-bandwidth track, else the lowest id —
 * so the same manifest always yields the same options and representatives.
 * Sorting is highest quality first (height desc, then bandwidth desc, then
 * id asc as the final stable tiebreak).
 */
export function deriveLiveTvQualityOptions(rawTracks: unknown): LiveTvQualityOption[] {
        if (!Array.isArray(rawTracks)) return [];
        const prepared: PreparedTrack[] = [];
        for (const raw of rawTracks) {
                const track = prepareTrack(raw);
                if (track) prepared.push(track);
        }
        if (prepared.length === 0) return [];

        // Group by equivalent resolution (same rounded width+height; heightless
        // tiers group by width only, else by bandwidth alone).
        const groups = new Map<string, PreparedTrack[]>();
        for (const track of prepared) {
                const key = track.height !== undefined
                        ? `${track.width ?? '?'}x${track.height}`
                        : `bw:${track.bandwidth ?? '?'}`;
                const bucket = groups.get(key);
                if (bucket) bucket.push(track);
                else groups.set(key, [track]);
        }

        const options: LiveTvQualityOption[] = [];
        for (const bucket of groups.values()) {
                // Deterministic representative: active > bandwidth > lowest id.
                const representative = [...bucket].sort((a, b) => {
                        if (a.active !== b.active) return a.active ? -1 : 1;
                        const ab = a.bandwidth ?? 0;
                        const bb = b.bandwidth ?? 0;
                        if (ab !== bb) return bb - ab;
                        return a.id - b.id;
                })[0];
                const option: LiveTvQualityOption = {
                        id: representative.id,
                        label: liveTvQualityLabel(representative.height, representative.bandwidth)
                };
                if (representative.width !== undefined) option.width = representative.width;
                if (representative.height !== undefined) option.height = representative.height;
                if (representative.bandwidth !== undefined) option.bandwidth = representative.bandwidth;
                options.push(option);
        }

        // Highest quality first; the id tiebreak keeps the order deterministic.
        options.sort((a, b) => qualityRank(b) - qualityRank(a) || a.id - b.id);
        return options;
}

/**
 * The id of the ACTIVE variant track from a raw variant-track array, or null
 * when no entry reports `active: true` (or the input is unusable). Used for
 * the initial snapshot after a successful load — never fabricated.
 */
export function activeLiveTvTrackId(rawTracks: unknown): number | null {
        if (!Array.isArray(rawTracks)) return null;
        let fallback: number | null = null;
        for (const raw of rawTracks) {
                if (!raw || typeof raw !== 'object') continue;
                const track = raw as Record<string, unknown>;
                if (track.active === true && isFiniteNonNegative(track.id)) return track.id;
                if (fallback === null && isFiniteNonNegative(track.id)) fallback = track.id;
        }
        return null;
}
