export type TVScreen = 'home' | 'search' | 'my-list' | 'settings';

export type TVNavigationSnapshot = {
  screen: TVScreen;
  focusId: string | null;
};

export function createTVNavigation() {
  let current: TVNavigationSnapshot = { screen: 'home', focusId: 'tv-nav-home' };
  let previous: TVNavigationSnapshot | null = null;

  return {
    get current() {
      return current;
    },

    open(screen: TVScreen, focusId: string | null = null) {
      previous = current;
      current = { screen, focusId };
      return current;
    },

    rememberFocus(focusId: string | null) {
      current = { ...current, focusId };
    },

    goBack(): TVNavigationSnapshot | null {
      if (!previous) return null;
      current = previous;
      previous = null;
      return current;
    },

    reset() {
      current = { screen: 'home', focusId: 'tv-nav-home' };
      previous = null;
    }
  };
}
