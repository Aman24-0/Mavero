export function safeRedirectPath(value: string | null | undefined, fallback = '/profile') {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('://')) return fallback;
  return value;
}

export function friendlyAuthMessage(message: string | undefined, mode: 'sign-in' | 'sign-up' = 'sign-in') {
  const normalized = (message ?? '').toLowerCase();
  if (normalized.includes('invalid login credentials') || normalized.includes('invalid credentials')) return 'Those sign-in details were not recognized.';
  if (normalized.includes('user already registered')) return 'An account with that email already exists. Try signing in instead.';
  if (normalized.includes('password')) return mode === 'sign-up' ? 'Choose a password with at least six characters.' : 'Please check your password and try again.';
  if (normalized.includes('email')) return 'Please enter a valid email address.';
  if (normalized.includes('rate limit') || normalized.includes('too many')) return 'Please wait a moment before trying again.';
  return mode === 'sign-up' ? 'We could not create the account right now. Please try again.' : 'We could not complete sign-in right now. Please try again.';
}
