export type TVScreen = 'home' | 'search' | 'my-list' | 'settings' | 'detail' | 'player';

export type TVNavigationSnapshot = {
  screen: TVScreen;
  focusId: string | null;
};

export function createTVNavigation(initial: TVNavigationSnapshot = { screen: 'home', focusId: 'tv-nav-home' }) {
  let current: TVNavigationSnapshot = { ...initial };
  const history: TVNavigationSnapshot[] = [];

  return {
    get current() {
      return current;
    },

    get depth() {
      return history.length;
    },

    open(screen: TVScreen, focusId: string | null = null) {
      if (screen === current.screen) {
        current = { screen, focusId: focusId ?? current.focusId };
        return current;
      }

      history.push(current);
      current = { screen, focusId };
      return current;
    },

    rememberFocus(focusId: string | null) {
      current = { ...current, focusId };
    },

    goBack(): TVNavigationSnapshot | null {
      const previous = history.pop();
      if (!previous) return null;
      current = previous;
      return current;
    },

    reset(next: TVNavigationSnapshot = initial) {
      current = { ...next };
      history.length = 0;
    }
  };
}
