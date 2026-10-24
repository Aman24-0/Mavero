// ============================================================================
// Unified Live TV R-1 — deterministic catalogue channel grouping (PURE).
//
// The grouping model behind the source-first user catalogue: equivalent
// channels available from MULTIPLE enabled sources collapse into ONE
// user-facing card, with the eligible alternative sources retained (bounded,
// labeled, deterministically ordered) so the player can offer source
// switching. This module owns NO database I/O, NO fetching and NO flag read —
// it is a pure transformation over pre-read rows (the caller performs the
// same bounded, exposure-filtered reads as R-0 and hands them here), so the
// whole model is unit-testable without a database.
//
// IDENTITY STRATEGY (conservative, deterministic — plan §18.2):
//
//   1. CANONICAL MAPPING is the trusted, explicit identity. Enabled entries
//      mapped to an ENABLED canonical channel group under `chan:<channelId>`
//      (several sources' entries collapse into ONE card; the canonical row
//      supplies the display metadata). An entry mapped to a canonical row
//      that is absent from the input (disabled — the caller loads only
//      enabled canonical rows — or deleted) contributes NOTHING: mapping
//      means "this entry's identity IS that channel" (C1 semantics
//      preserved); it must never fall back to name grouping.
//   2. UNMAPPED entries group by EXACT normalized display-name equality:
//      NFKC → trim → collapse internal whitespace → casefold. This is an
//      EXACT-match fallback — NEVER fuzzy matching: no similarity scores, no
//      token/prefix heuristics, no transliteration, no quality-tag stripping.
//      Channels whose names merely look similar are never merged. Name
//      groups never merge into canonical groups (canonical grouping requires
//      the explicit mapping).
//   3. A database entry can never be emitted twice: every entry row is
//      visited exactly once and each group holds one member per (entry row).
//      Duplicate input row ids (a caller bug) are defensively dropped.
//
// PREFERRED SOURCE (deterministic; the existing priority + eligibility rules
// — nothing new is invented): among a group's member entries, order by
//   source priority ASC → source slug ASC → entry source_channel_id ASC →
//   entry row id ASC.
// The first member is the group's preferred entry: for a canonical group it
// is the default candidate head (the canonical path orders by the same
// source priority); for a name-group it supplies display metadata AND the
// card identity (`entry:<rowId>` — the R-0 direct-entry selection id the
// resolver already accepts).
//
// ALTERNATIVES (the R-1 additive wire field): one alternative per
// CONTRIBUTING SOURCE (that source's best-ranked member; its own
// `entry:<rowId>` selection id), labeled with the source display name,
// ordered by the same comparator, bounded to MAX_CATALOGUE_GROUP_SOURCES.
// No config, URLs, slugs or visibility data ever enters these rows.
//
// Determinism: same input rows ⇒ byte-identical output (stable sorts over
// totally-ordered keys; no reliance on input order, no timing, no locale
// folding beyond the documented normalization).
// ============================================================================

/** One eligible, public source as the grouping model sees it. */
export type CatalogueGroupSourceRef = {
        id: string;
        /** Admin display name — the ONLY label material for alternatives. */
        name: string;
        slug: string;
        priority: number;
};

/** One enabled entry row of those sources (narrowed by the caller). */
export type CatalogueGroupEntryRef = {
        /** The entry ROW id (the `entry:` selection identity base). */
        id: string;
        sourceId: string;
        sourceChannelId: string;
        canonicalChannelId: string | null;
        /** Unmapped entries need a display name; mapped ones do not. */
        name: string | null;
        category: string | null;
        logoUrl: string | null;
};

/** Internal member view: the entry joined with its (eligible) source fields. */
type Member = CatalogueGroupEntryRef & { sourcePriority: number; sourceSlug: string; sourceName: string };

/** One ENABLED canonical channel row (the caller loads enabled-only). */
export type CatalogueGroupCanonicalRef = {
        id: string;
        name: string;
        category: string | null;
        logoUrl: string | null;
};

/** One switchable source alternative on the wire (bounded, labeled). */
export type CatalogueGroupAlternative = {
        /** The selection id that resolves THIS source's stream for the group. */
        id: string;
        /** The source display name (never a raw id, never config). */
        label: string;
};

/** One user-facing channel card (the grouped catalogue row). */
export type CatalogueChannelGroup = {
        /** Internal identity-space key (never emitted to the client). */
        key: string;
        /** The card/selection id: canonical uuid, or `entry:<preferredRowId>`. */
        id: string;
        name: string;
        category: string | null;
        logoUrl: string | null;
        /** Preferred-first, source-distinct, bounded alternatives. */
        alternatives: CatalogueGroupAlternative[];
        /** Sort material (canonical groups lead, then name ASC, then id). */
        isCanonical: boolean;
};

/** Hard bound on per-card alternatives (the switcher is a compact control). */
export const MAX_CATALOGUE_GROUP_SOURCES = 6;

/** The canonical-group key prefix (identity space 1). */
const CANONICAL_KEY_PREFIX = 'chan:';
/** The name-group key prefix (identity space 2). */
const NAME_KEY_PREFIX = 'name:';
/** The stable direct-entry selection prefix (shared with user-catalogue). */
const ENTRY_SELECTION_PREFIX = 'entry:';

/**
 * The exact display-name normalization behind name grouping: NFKC → trim →
 * collapse internal whitespace → casefold. Pure, locale-independent.
 * Returns null when nothing usable remains (the entry is then never grouped,
 * never coerced).
 */
export function normalizeLivetvGroupName(raw: unknown): string | null {
        if (typeof raw !== 'string') return null;
        // eslint-disable-next-line no-control-regex -- explicit normalization, no user regex
        const nfkc = raw.normalize('NFKC').trim();
        if (nfkc.length === 0) return null;
        const collapsed = nfkc.replace(/\s+/g, ' ').toLowerCase();
        return collapsed.length > 0 ? collapsed : null;
}

/** The total member ordering: source priority → slug → source_channel_id → row id. */
export function compareCatalogueGroupMembers(
        a: { sourcePriority: number; sourceSlug: string; sourceChannelId: string; id: string },
        b: { sourcePriority: number; sourceSlug: string; sourceChannelId: string; id: string }
): number {
        if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
        if (a.sourceSlug !== b.sourceSlug) return a.sourceSlug < b.sourceSlug ? -1 : 1;
        if (a.sourceChannelId !== b.sourceChannelId) return a.sourceChannelId < b.sourceChannelId ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type LivetvCatalogueGroupsInput = {
        sources: readonly CatalogueGroupSourceRef[];
        entries: readonly CatalogueGroupEntryRef[];
        canonicals: readonly CatalogueGroupCanonicalRef[];
};

export type LivetvCatalogueGroupsResult = {
        /** Canonical groups first (name, id), then name groups (name, preferred id). */
        groups: CatalogueChannelGroup[];
        /** Defensive count of duplicate entry-row ids dropped (first wins). */
        duplicateEntryIdsDropped: number;
};

/**
 * Build the deterministic grouped catalogue from pre-read rows. Every gate
 * that needs DB context is the CALLER's responsibility (flag, source
 * enabled/eligible/public, entry enabled, canonical enabled) — this module
 * re-verifies only what its inputs can prove (source membership, name
 * usability, duplicate ids) and drops unusable rows, never coerces them.
 */
export function buildLivetvCatalogueGroups(input: LivetvCatalogueGroupsInput): LivetvCatalogueGroupsResult {
        const sourceById = new Map<string, CatalogueGroupSourceRef>();
        for (const source of input.sources) {
                if (typeof source?.id === 'string' && source.id.length > 0) sourceById.set(source.id, source);
        }
        const canonicalById = new Map<string, CatalogueGroupCanonicalRef>();
        for (const canonical of input.canonicals) {
                if (typeof canonical?.id === 'string' && canonical.id.length > 0) canonicalById.set(canonical.id, canonical);
        }

        const canonicalMembers = new Map<string, Member[]>();
        const nameMembers = new Map<string, Member[]>();
        const canonicalMeta = new Map<string, CatalogueGroupCanonicalRef>();
        const nameMeta = new Map<string, { name: string; category: string | null; logoUrl: string | null }>();

        let duplicateEntryIdsDropped = 0;
        const seenEntryIds = new Set<string>();

        for (const entry of input.entries) {
                // Structural usability — one visit per row, duplicates dropped.
                if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
                if (seenEntryIds.has(entry.id)) {
                        duplicateEntryIdsDropped += 1;
                        continue;
                }
                seenEntryIds.add(entry.id);
                // Source membership: an entry whose source is not among the
                // eligible inputs can never contribute (defense in depth —
                // the caller already filtered).
                const source = sourceById.get(entry.sourceId);
                if (!source) continue;

                const canonicalId = typeof entry.canonicalChannelId === 'string' && entry.canonicalChannelId.length > 0 ? entry.canonicalChannelId : null;
                if (canonicalId !== null) {
                        // Identity 1 — mapped. Only an ENABLED canonical row (present
                        // in the input) hosts it; a missing row contributes nothing.
                        const canonical = canonicalById.get(canonicalId);
                        if (!canonical) continue;
                        const member: Member = { ...entry, sourcePriority: source.priority, sourceSlug: source.slug, sourceName: source.name };
                        const bucket = canonicalMembers.get(canonicalId) ?? [];
                        bucket.push(member);
                        canonicalMembers.set(canonicalId, bucket);
                        canonicalMeta.set(canonicalId, canonical);
                        continue;
                }

                // Identity 2 — unmapped: exact normalized display-name equality.
                const normalizedName = normalizeLivetvGroupName(entry.name);
                if (normalizedName === null) continue; // unusable display metadata — dropped, never coerced
                const member: Member = { ...entry, sourcePriority: source.priority, sourceSlug: source.slug, sourceName: source.name };
                const bucket = nameMembers.get(normalizedName) ?? [];
                bucket.push(member);
                nameMembers.set(normalizedName, bucket);
                if (!nameMeta.has(normalizedName)) {
                        nameMeta.set(normalizedName, { name: typeof entry.name === 'string' ? entry.name : normalizedName, category: entry.category, logoUrl: entry.logoUrl });
                }
        }

        const groups: CatalogueChannelGroup[] = [];

        // Canonical groups — the stable leading surface.
        for (const [canonicalId, members] of canonicalMembers) {
                const canonical = canonicalMeta.get(canonicalId);
                if (!canonical || members.length === 0) continue;
                const ordered = [...members].sort(compareCatalogueGroupMembers);
                groups.push({
                        key: `${CANONICAL_KEY_PREFIX}${canonicalId}`,
                        id: canonicalId,
                        name: canonical.name,
                        category: canonical.category,
                        logoUrl: canonical.logoUrl,
                        alternatives: buildAlternatives(ordered),
                        isCanonical: true
                });
        }

        // Name groups — the R-0 direct-entry surface, now deduplicated.
        for (const [key, members] of nameMembers) {
                if (members.length === 0) continue;
                const ordered = [...members].sort(compareCatalogueGroupMembers);
                const preferred = ordered[0]!;
                groups.push({
                        key: `${NAME_KEY_PREFIX}${key}`,
                        id: `${ENTRY_SELECTION_PREFIX}${preferred.id}`,
                        name: nameMeta.get(key)?.name ?? preferred.name ?? key,
                        category: preferred.category,
                        logoUrl: preferred.logoUrl,
                        alternatives: buildAlternatives(ordered),
                        isCanonical: false
                });
        }

        // Deterministic order: canonical block first (name ASC, id ASC), then
        // name groups (name ASC, preferred entry id ASC).
        groups.sort((a, b) => {
                if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
                if (a.name !== b.name) return a.name < b.name ? -1 : 1;
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        return { groups, duplicateEntryIdsDropped };
}

/** One alternative per contributing source, preferred-first, bounded. */
function buildAlternatives(orderedMembers: Array<Member>): CatalogueGroupAlternative[] {
        const alternatives: CatalogueGroupAlternative[] = [];
        const seenSources = new Set<string>();
        for (const member of orderedMembers) {
                if (alternatives.length >= MAX_CATALOGUE_GROUP_SOURCES) break;
                if (seenSources.has(member.sourceId)) continue; // one per source (its best-ranked member)
                const label = typeof member.sourceName === 'string' ? member.sourceName.trim() : '';
                if (label.length === 0 || label.length > 200) continue; // no usable label — no alternative fabricated
                seenSources.add(member.sourceId);
                alternatives.push({ id: `${ENTRY_SELECTION_PREFIX}${member.id}`, label });
        }
        return alternatives;
}
