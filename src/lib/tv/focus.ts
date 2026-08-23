export type FocusDirection = 'up' | 'down' | 'left' | 'right';

type FocusableElement = HTMLElement & { dataset: DOMStringMap };

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !element.hidden;
}

function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

  focusFirst(): boolean {
    const first = this.getFocusables()[0];
    if (!first) return false;
    this.setCurrent(first, true);
    return true;
  }

  focusById(id: string): boolean {
    const target = this.getById(id);
    if (!target) return false;
    this.setCurrent(target, true);
    return true;
  }

  move(direction: FocusDirection): boolean {
    const current = this.getCurrentElement();
    if (!current) return this.focusFirst();

    const target = this.pickCandidate(current, direction);
    if (!target) return false;

    this.setCurrent(target, true);
    return true;
  }

  private getCurrentElement(): FocusableElement | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.isFocusable(active)) {
      this.current = active as FocusableElement;
    }
    return this.current && this.getFocusables().includes(this.current) ? this.current : this.getFocusables()[0] ?? null;
  }

  private getFocusables(): FocusableElement[] {
    return [...this.root.querySelectorAll<FocusableElement>('[data-tv-focusable="true"]')]
      .filter((element) => !element.hasAttribute('aria-disabled') && isVisible(element));
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
    if (shouldFocus) element.focus({ preventScroll: true });
  }

  private pickCandidate(current: FocusableElement, direction: FocusDirection): FocusableElement | null {
    const currentRect = current.getBoundingClientRect();
    const currentCenter = center(currentRect);
    const candidates = this.getFocusables().filter((element) => element !== current);

    const directional = candidates
      .map((element) => ({ element, rect: element.getBoundingClientRect(), center: center(element.getBoundingClientRect()) }))
      .filter(({ rect }) => {
        if (direction === 'left') return rect.right <= currentRect.left + 2;
        if (direction === 'right') return rect.left >= currentRect.right - 2;
        if (direction === 'up') return rect.bottom <= currentRect.top + 2;
        return rect.top >= currentRect.bottom - 2;
      })
      .map(({ element, rect, center: candidateCenter }) => {
        const primary = direction === 'left' || direction === 'right'
          ? Math.abs(candidateCenter.x - currentCenter.x)
          : Math.abs(candidateCenter.y - currentCenter.y);
        const secondary = direction === 'left' || direction === 'right'
          ? Math.abs(candidateCenter.y - currentCenter.y)
          : Math.abs(candidateCenter.x - currentCenter.x);
        const distance = Math.hypot(candidateCenter.x - currentCenter.x, candidateCenter.y - currentCenter.y);
        return { element, rect, score: secondary * 5 + primary + distance * 0.01 };
      })
      .sort((a, b) => a.score - b.score);

    return directional[0]?.element ?? null;
  }
}
