/**
 * Task 3 (2026-10-15) — Admin dialog stack (overlay ownership).
 *
 * Problem being fixed: opening the Add File wizard / update-link wizard /
 * delete confirmation FROM the episode sheet rendered the child dialog
 * BEHIND the sheet (z-index), and Escape closed BOTH dialogs because the
 * sheet and the wizard each listen for keydown at the window level.
 *
 * This module gives every admin overlay a deterministic ownership order:
 *   - dialogOpened(id)/dialogClosed(id) maintain a global open-stack.
 *   - isTopDialog(id) lets a dialog decide whether IT owns the current
 *     Escape/backdrop interaction. Non-topmost dialogs ignore Escape —
 *     only the topmost dialog closes (the episode sheet stays open
 *     underneath a wizard opened from it).
 *
 * The stack is global (module scope) so dialogs from different component
 * trees (AdminMediaList, AdminEpisodeSheet, AdminAddFileWizard, the
 * Missing Media page) share ONE ordering. Ids are stable strings owned
 * by each dialog component.
 *
 * Z-index ladder (documented in one place):
 *   episode sheet overlay  92   (AdminEpisodeSheet)
 *   bulk-delete confirm    93   (AdminEpisodeSheet — above its sheet)
 *   wizard / delete / filter 94 (AdminAddFileWizard + AdminMediaList)
 *   portaled action menu  1000  (AdminMediaList — closes before dialogs)
 */

const stack: string[] = [];

/** Register a dialog as open (call when the overlay mounts/appears). */
export function dialogOpened(id: string): void {
  stack.push(id);
}

/** Unregister a dialog (call when the overlay closes/destroys). Idempotent. */
export function dialogClosed(id: string): void {
  const index = stack.lastIndexOf(id);
  if (index >= 0) stack.splice(index, 1);
}

/** True when `id` is the TOPMOST open dialog (owns Escape/backdrop). */
export function isTopDialog(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Number of currently open dialogs (test/debug helper). */
export function openDialogCount(): number {
  return stack.length;
}

/** Test helper — clear the stack between cases. */
export function resetDialogStack(): void {
  stack.length = 0;
}
