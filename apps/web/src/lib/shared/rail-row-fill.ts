/**
 * MAV-25 WS2 — Discover rail visible-row fill target (pure math).
 *
 * PROBLEM (verified in the Phase 0 audit): the cross-rail batch targets
 * TARGET_ITEMS=10 per rail (`$lib/server/content/discover-batch.ts`),
 * with bounded continuation up to 3 pages. Rails late in the dedup
 * priority (the genre tail) and language-filtered rails lose most of
 * each upstream page to higher-priority rails, so they land with far
 * fewer than 10 items — on a desktop/TV viewport the visible rail row
 * (8-10 card slots at the 178px/210px card pitch) renders mostly EMPTY
 * and the user must press Show More to fill it.
 *
 * FIX SHAPE: the section component measures its ACTUAL rail container
 * (clientWidth — never the viewport width: the sidebar, page gutters
 * and section padding are already subtracted), the ACTUAL first-card
 * width and the ACTUAL column gap, and derives how many card slots the
 * visible row holds. When the loaded item count is below that target
 * AND the rail has more pages, it fetches additional pages through the
 * EXISTING Show More pipeline (same endpoint, same cross-rail exclude
 * contract, same dedupe, same cache state) — bounded, cancellable, and
 * never manufacturing placeholder cards.
 *
 * END-CAP ACCOUNTING: the terminal "Show More" card occupies ONE rail
 * column. When more pages exist, the fill target reserves that column
 * so the row completes with items + the Show More card (no trailing
 * whitespace). When the dataset is exhausted, the whole row fills with
 * items.
 *
 * This module is pure and Node-testable — no DOM access.
 */

export type RowFillInput = {
  /** The rail's own visible content width (clientWidth), NOT the viewport. */
  containerWidth: number;
  /** The measured first-card width (the grid's auto-column size). */
  cardWidth: number;
  /** The computed column gap between rail columns. */
  gap: number;
  /** Whether the terminal Show More endcap currently renders. */
  hasMore: boolean;
};

/**
 * How many ITEMS the visible row needs so it renders full.
 *
 *   slots = floor((containerWidth + gap) / (cardWidth + gap))
 *   items = hasMore ? slots - 1 (the endcap fills the last slot)
 *                   : slots      (no endcap — all slots are items)
 *
 * Defensive guards: non-finite / non-positive measurements degrade to a
 * target of 1 (the caller treats "items >= target" as already filled —
 * no fetch is ever triggered by degenerate input).
 */
export function rowFillTarget(input: RowFillInput): number {
  const { containerWidth, cardWidth, gap, hasMore } = input;
  if (!Number.isFinite(containerWidth) || !Number.isFinite(cardWidth) || !Number.isFinite(gap)) return 1;
  if (containerWidth <= 0 || cardWidth <= 0) return 1;
  const safeGap = Math.max(0, gap);
  const pitch = cardWidth + safeGap;
  const slots = Math.floor((containerWidth + safeGap) / pitch);
  if (slots < 1) return 1;
  return hasMore ? Math.max(1, slots - 1) : slots;
}

/**
 * Upper bound on the items a rail auto-fills toward. The fill driver
 * never requests "unlimited" content: it stops when the visible row is
 * filled, the rail is exhausted, the request budget is spent, or this
 * cap is reached — whichever comes first. 40 covers the widest
 * supported desktop row (~11 slots at the TV pitch) across repeated
 * resizes within one logical load while staying far below any rate-limit
 * concern (3 bounded Show More fetches × ~13 items per response).
 */
export const ROW_FILL_ITEM_CAP = 40;

/**
 * Upper bound on automatic Show More fetches per logical load. One
 * fetch returns ~10+ items (the rail endpoint's own bounded
 * continuation), so two fetches fill any supported row; three allows
 * one spare for a resize that widens the row mid-load. The budget is
 * per logical load (initial mount / filter change) — a manual Show More
 * press is the user's own action and not counted here.
 */
export const ROW_FILL_FETCH_BUDGET = 3;
