export type AdminMutationStatus = 'success' | 'failure' | 'unknown';

export type AdminMutationResult =
  | { status: 'success' }
  | { status: 'failure'; message: string }
  | { status: 'unknown'; message: string };

export function classifyAdminMutationError(error: unknown, fallback: string): Exclude<AdminMutationResult, { status: 'success' }> {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /timeout|timed out|network/i.test(error.message)) {
      return { status: 'unknown', message: 'The registry update may still be processing. Refresh to confirm the Supabase state.' };
    }
    return { status: 'failure', message: error.message || fallback };
  }
  return { status: 'unknown', message: 'The registry update result could not be confirmed. Refresh to verify the Supabase state.' };
}
