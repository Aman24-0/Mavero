/**
 * Unified bulk-reposition validation (2026-10-16 round — Issue 5).
 *
 * ONE shared, dependency-free contract for EVERY Admin list that uses the
 * bulk reposition workflow (category-source positions, global source
 * ordering, global category ordering). The UI imports the SAME validators
 * the tests pin, so the interactive behavior can never drift between
 * surfaces.
 *
 * Live-validation rules (the full proposed set is re-validated on EVERY
 * keystroke; the Apply button stays disabled while the set is invalid):
 *   * blank values are invalid;
 *   * zero and negative values are invalid (positions are 1-based in the
 *     UI; the server stores 0-based dense rows for category assignments —
 *     the translation stays server-side, the admin always sees 1..N);
 *   * decimal values are invalid;
 *   * non-numeric values are invalid;
 *   * duplicate values across the PROPOSED SET are invalid;
 *   * when the list's contract is dense 1..N (category-source positions),
 *     values above the list length are invalid;
 *   * lists whose contract permits gaps (global source/category ordering)
 *     accept any distinct positive integer — gaps are PRESERVED, never
 *     silently renumbered.
 *
 * Scope discipline: uniqueness is validated WITHIN ONE list only —
 * category-local positions are unique inside the relevant category, never
 * across every category in the database (each call validates one list).
 */

export type RepositionEntry<T> = {
  /** The list item the draft belongs to (row object, free-form). */
  item?: T;
  /** The CURRENTLY SAVED position for prefill (1-based display value). */
  savedPosition: number;
  /** Stable identity (source id / category id) used for ordering. */
  id: string;
};

export type RepositionDraft = {
  /** Draft text per row, keyed by row id (input bind:value). */
  values: Record<string, string>;
};

export type RepositionValidation = {
  /** True only when EVERY row parses and the whole set is consistent. */
  valid: boolean;
  /** Per-row error message (null = valid), keyed by row id. */
  errors: Record<string, string | null>;
  /** First set-level problem (duplicates/out-of-range) for the inline banner. */
  setError: string | null;
  /**
   * The validated rows sorted by their proposed position (only meaningful
   * when valid) — the bulk Apply payload's intended order.
   */
  orderedIds: string[];
};

/**
 * Validate ONE complete proposed position set.
 *
 * @param entries the list rows with their saved positions (prefill source).
 * @param values  the current draft text per row id.
 * @param options.maxPosition  when the contract is dense 1..N (category
 *   source positions), the inclusive upper bound; null/undefined = gaps
 *   allowed (global orderings).
 * @param options.minPosition  inclusive lower bound — 1 (default, positions
 *   are 1-based) or 0 for global ordering lists whose stored contract
 *   legitimately starts at 0 (the prefill shows the SAVED values verbatim,
 *   so a list stored from 0 stays 0-based — never silently renumbered).
 */
export function validateRepositionSet<T>(
  entries: Array<RepositionEntry<T>>,
  values: Record<string, string>,
  options: { maxPosition?: number | null; minPosition?: number } = {},
): RepositionValidation {
  const errors: Record<string, string | null> = {};
  const parsed: Array<{ id: string; position: number }> = [];
  let setError: string | null = null;
  const max = typeof options.maxPosition === 'number' && Number.isFinite(options.maxPosition) ? options.maxPosition : null;
  const min = typeof options.minPosition === 'number' && Number.isFinite(options.minPosition) ? options.minPosition : 1;

  for (const entry of entries) {
    const raw = String(values[entry.id] ?? '').trim();
    if (!raw) {
      errors[entry.id] = 'Position is required.';
      setError = setError ?? 'Every position is required — blank values are invalid.';
      continue;
    }
    if (!/^\d+$/.test(raw)) {
      errors[entry.id] = /^\d+\.\d+$/.test(raw)
        ? 'Decimal values are invalid.'
        : 'Whole numbers only.';
      setError = setError ?? 'Positions must be positive whole numbers (no decimals or other characters).';
      continue;
    }
    const position = Number(raw);
    if (!Number.isSafeInteger(position)) {
      errors[entry.id] = 'Value is out of range.';
      setError = setError ?? 'A position value is out of range.';
      continue;
    }
    if (position < min) {
      errors[entry.id] = min === 1 ? 'Positions start at 1.' : `Positions start at ${min}.`;
      setError = setError ?? (min === 1 ? 'Zero and negative positions are invalid.' : `Positions below ${min} are invalid.`);
      continue;
    }
    if (max !== null && position > max) {
      errors[entry.id] = `Positions run from 1 to ${max}.`;
      setError = setError ?? `Positions run from 1 to ${max}.`;
      continue;
    }
    errors[entry.id] = null;
    parsed.push({ id: entry.id, position });
  }

  // Duplicate detection runs on the successfully parsed subset — a row with
  // an invalid value cannot collide, but two valid equal values must fail
  // the WHOLE set (never wait for a database error to surface a duplicate).
  if (parsed.length > 1) {
    const byPosition = new Map<number, string[]>();
    for (const row of parsed) {
      const list = byPosition.get(row.position) ?? [];
      list.push(row.id);
      byPosition.set(row.position, list);
    }
    const duplicated = [...byPosition.entries()].filter(([, ids]) => ids.length > 1);
    if (duplicated.length) {
      const duplicatedPositions = duplicated.map(([position]) => position).sort((a, b) => a - b);
      setError = `Duplicate position${duplicatedPositions.length > 1 ? 's' : ''}: ${duplicatedPositions.join(', ')}. Every row needs a distinct position.`;
      for (const [, ids] of duplicated) {
        for (const id of ids) errors[id] = 'Duplicate position.';
      }
    }
  }

  const valid = parsed.length === entries.length && setError === null;
  const orderedIds = valid
    ? parsed.slice().sort((a, b) => a.position - b.position).map((row) => row.id)
    : [];
  return { valid, errors, setError, orderedIds };
}

/**
 * Prefill helper: the draft starts from the SAVED positions verbatim —
 * "Do not start with blank values or renumber everything automatically".
 */
export function repositionDraftFromEntries(entries: Array<{ id: string; savedPosition: number }>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of entries) values[entry.id] = String(entry.savedPosition);
  return values;
}

/** True when a draft differs from the saved positions (enable Apply). */
export function repositionDraftIsDirty(entries: Array<{ id: string; savedPosition: number }>, values: Record<string, string>): boolean {
  return entries.some((entry) => String(values[entry.id] ?? '').trim() !== String(entry.savedPosition));
}
