export type TVRemoteAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'back'
  | 'playPause'
  | 'rewind'
  | 'fastForward'
  | 'next'
  | 'previous';

export type TVRemoteEvent = KeyboardEvent & { keyCode?: number; which?: number };

const actionByKey = new Map<string, TVRemoteAction>([
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['Enter', 'enter'],
  ['Escape', 'back'],
  ['Back', 'back'],
  ['BrowserBack', 'back'],
  ['MediaPlayPause', 'playPause'],
  ['MediaRewind', 'rewind'],
  ['MediaFastForward', 'fastForward'],
  ['MediaTrackNext', 'next'],
  ['MediaTrackPrevious', 'previous']
]);

const actionByKeyCode = new Map<number, TVRemoteAction>([
  [10009, 'back'],
  [10252, 'playPause'],
  [412, 'rewind'],
  [417, 'fastForward'],
  [10233, 'next'],
  [10232, 'previous']
]);

export function getTVRemoteAction(event: TVRemoteEvent): TVRemoteAction | null {
  // Samsung's dedicated Exit key is intentionally not mapped. It must retain
  // the platform's default behavior rather than opening Mavero's dialog.
  if (event.key === 'Exit' || event.key === 'TVExit') return null;

  return actionByKey.get(event.key) ?? actionByKeyCode.get(event.keyCode ?? event.which ?? 0) ?? null;
}

export function isNavigationAction(action: TVRemoteAction | null): boolean {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right';
}

export function isActivationAction(action: TVRemoteAction | null): boolean {
  return action === 'enter';
}

export function isBackAction(action: TVRemoteAction | null): boolean {
  return action === 'back';
}

export function createKeyboardRemote(onAction: (action: TVRemoteAction, event: TVRemoteEvent) => void) {
  const handleKeydown = (event: KeyboardEvent) => {
    const action = getTVRemoteAction(event as TVRemoteEvent);
    if (!action) return;
    onAction(action, event as TVRemoteEvent);
  };

  window.addEventListener('keydown', handleKeydown);
  return () => window.removeEventListener('keydown', handleKeydown);
}
