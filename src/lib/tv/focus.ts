export type FocusDirection = 'up' | 'down' | 'left' | 'right';

type FocusableElement = HTMLElement & { dataset: DOMStringMap };

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !element.hidden && !element.matches(':disabled');
}

type FocusRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

function center(rect: FocusRect) {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function horizontalGap(currentRect: FocusRect, candidateRect: FocusRect) {
  if (candidateRect.right < currentRect.left) return currentRect.left - candidateRect.right;
  if (candidateRect.left > currentRect.right) return candidateRect.left - currentRect.right;
  return 0;
}

const VERTICAL_ROW_TOLERANCE = 48;

export function pickVerticalCandidate<T>(
  currentRect: FocusRect,
  direction: 'up' | 'down',
  candidates: T[],
  getRect: (candidate: T) => FocusRect
): T | null {
  const directional = candidates
    .map((candidate) => ({ candidate, rect: getRect(candidate) }))
    .map(({ candidate, rect }) => ({
      candidate,
      rect,
      gap: direction === 'up' ? currentRect.top - rect.bottom : rect.top - currentRect.bottom
    }))
    .filter(({ gap }) => gap >= -2);

  if (!directional.length) return null;

  // First select the nearest vertical row. This prevents a well-aligned control
  // in an earlier section from winning over the immediately preceding rail.
  const nearestGap = Math.min(...directional.map(({ gap }) => Math.max(0, gap)));
  const row = directional.filter(({ gap }) => gap <= nearestGap + VERTICAL_ROW_TOLERANCE);
  const currentCenterX = center(currentRect).x;

  return row.sort((a, b) => {
    const horizontal = horizontalGap(currentRect, a.rect) - horizontalGap(currentRect, b.rect);
    if (horizontal !== 0) return horizontal;

    const centerDistance = Math.abs(center(a.rect).x - currentCenterX) - Math.abs(center(b.rect).x - currentCenterX);
    if (centerDistance !== 0) return centerDistance;

    return a.gap - b.gap;
  })[0]?.candidate ?? null;
}

export class TVFocusCoordinator {
  private current: FocusableElement | null = null;
  private readonly onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && this.isFocusable(target)) {
      this.setCurrent(target as FocusableElement, false);
    }
  };

  constructor(private readonly root: HTMLElement) {
    root.addEventListener('focusin', this.onFocusIn);
  }

  destroy() {
    this.root.removeEventListener('focusin', this.onFocusIn);
    this.current = null;
  }

  initialize(initialId?: string) {
    const focusables = this.getFocusables();
    focusables.forEach((element) => {
      element.tabIndex = -1;
    });

    const initial = (initialId ? this.getById(initialId) : null) ?? focusables[0];
    if (initial) this.setCurrent(initial, true);
  }

  get currentId(): string | null {
    return this.current?.dataset.tvFocusId ?? null;
  }

  isCurrentInGroup(group: string): boolean {
    const current = this.getCurrentElement();
    return Boolean(current && this.belongsToGroup(current, group));
  }

  rememberFocus(): string | null {
    return this.currentId;
  }

  restore(id: string | null): boolean {
    if (!id) return false;
    const target = this.getById(id);
    if (!target) return false;
    this.setCurrent(target, true);
    return true;
  }

  restoreFirst(ids: Array<string | null>): boolean {
    return ids.some((id) => this.restore(id));
  }

  focusFirst(): boolean {
    const first = this.getFocusables()[0];
    if (!first) return false;
    this.setCurrent(first, true);
    return true;
  }

  focusFirstInGroup(group: string): boolean {
    const first = this.getFocusablesInGroup(group)[0];
    if (!first) return false;
    this.setCurrent(first, true);
    return true;
  }

  focusLastInGroup(group: string): boolean {
    const focusables = this.getFocusablesInGroup(group);
    const last = focusables[focusables.length - 1];
    if (!last) return false;
    this.setCurrent(last, true);
    return true;
  }

  moveFocusToGroup(currentGroup: string, targetGroup: string): boolean {
    const current = this.getCurrentElement();
    if (current && !this.belongsToGroup(current, currentGroup)) return false;
    return this.focusFirstInGroup(targetGroup);
  }

  focusById(id: string): boolean {
    const target = this.getById(id);
    if (!target) return false;
    this.setCurrent(target, true);
    return true;
  }

  move(direction: FocusDirection, scope?: string): boolean {
    const current = this.getCurrentElement();
    if (!current) return scope ? this.focusFirstInGroup(scope) : this.focusFirst();

    const target = this.pickCandidate(current, direction, scope);
    if (!target) return false;

    this.setCurrent(target, true);
    return true;
  }

  private getCurrentElement(): FocusableElement | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.isFocusable(active)) {
      this.current = active as FocusableElement;
    }

    const focusables = this.getFocusables();
    return this.current && focusables.includes(this.current) ? this.current : focusables[0] ?? null;
  }

  private getFocusables(): FocusableElement[] {
    return [...this.root.querySelectorAll<FocusableElement>('[data-tv-focusable="true"]')]
      .filter((element) => !element.hasAttribute('aria-disabled') && isVisible(element));
  }

  private getFocusablesInGroup(group: string): FocusableElement[] {
    const roots = [...this.root.querySelectorAll<HTMLElement>('[data-tv-focus-group]')]
      .filter((element) => element.dataset.tvFocusGroup === group);
    const focusables = roots.flatMap((root) => {
      const descendants = [...root.querySelectorAll<FocusableElement>('[data-tv-focusable="true"]')];
      return this.isFocusable(root) ? [root as FocusableElement, ...descendants] : descendants;
    });
    return [...new Set(focusables)].filter((element) => !element.hasAttribute('aria-disabled') && isVisible(element));
  }

  private belongsToGroup(element: FocusableElement, group: string): boolean {
    if (element.dataset.tvFocusGroup === group) return true;
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== this.root) {
      if (ancestor.dataset.tvFocusGroup === group) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  private getById(id: string): FocusableElement | null {
    return this.getFocusables().find((element) => element.dataset.tvFocusId === id) ?? null;
  }

  private isFocusable(element: HTMLElement): boolean {
    return element.dataset.tvFocusable === 'true' && this.root.contains(element) && isVisible(element);
  }

  private setCurrent(element: FocusableElement, shouldFocus: boolean) {
    if (this.current && this.current !== element) this.current.tabIndex = -1;
    element.tabIndex = 0;
    this.current = element;

    if (shouldFocus) {
      try {
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      } catch {
        element.scrollIntoView();
      }
      element.focus({ preventScroll: true });
    }
  }

  private pickCandidate(current: FocusableElement, direction: FocusDirection, scope?: string): FocusableElement | null {
    const currentRect = current.getBoundingClientRect();
    const currentCenter = center(currentRect);
    const group = current.dataset.tvFocusGroup;
    const isHorizontal = direction === 'left' || direction === 'right';
    const candidates = this.getFocusables()
      .filter((element) => element !== current)
      .filter((element) => !scope || this.belongsToGroup(element, scope))
      .filter((element) => !isHorizontal || !group || element.dataset.tvFocusGroup === group);

    const directional = candidates
      .map((element) => ({ element, rect: element.getBoundingClientRect(), center: center(element.getBoundingClientRect()) }))
      .filter(({ rect }) => {
        if (direction === 'left') return rect.right <= currentRect.left + 2;
        if (direction === 'right') return rect.left >= currentRect.right - 2;
        if (direction === 'up') return rect.bottom <= currentRect.top + 2;
        return rect.top >= currentRect.bottom - 2;
      });

    if (!isHorizontal) {
      return pickVerticalCandidate(currentRect, direction, directional, (candidate) => candidate.rect)?.element ?? null;
    }

    return directional
      .map(({ element, rect, center: candidateCenter }) => {
        const primary = Math.abs(candidateCenter.x - currentCenter.x);
        const secondary = Math.abs(candidateCenter.y - currentCenter.y);
        const distance = Math.hypot(candidateCenter.x - currentCenter.x, candidateCenter.y - currentCenter.y);
        return { element, score: secondary * 5 + primary + distance * 0.01 };
      })
      .sort((a, b) => a.score - b.score)[0]?.element ?? null;
  }
}
