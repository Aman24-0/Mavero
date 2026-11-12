export type HapticKind = 'light' | 'success' | 'destructive';

const patterns: Record<HapticKind, number | number[]> = {
  light: 8,
  success: [10, 18, 10],
  destructive: [16, 28, 16],
};

export function haptic(kind: HapticKind = 'light'): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    return navigator.vibrate(patterns[kind]);
  } catch {
    return false;
  }
}
