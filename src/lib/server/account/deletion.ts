import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

export type AccountDeletionErrorCode = 'ADMIN_ACCOUNT_PROTECTED' | 'DELETE_FAILED' | 'DELETE_CONFIGURATION_ERROR';

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionErrorCode;
  readonly status: 403 | 503;

  constructor(code: AccountDeletionErrorCode, status: 403 | 503) {
    super(code === 'ADMIN_ACCOUNT_PROTECTED' ? 'Administrator accounts cannot be deleted here.' : 'Unable to delete the account right now.');
    this.name = 'AccountDeletionError';
    this.code = code;
    this.status = status;
  }
}

export async function deleteAuthenticatedAccount(userId: string, admin: SupabaseClient<Database>): Promise<void> {
  const profileResult = await admin.from('profiles').select('role').eq('id', userId).limit(1).maybeSingle();
  if (profileResult.error) throw new AccountDeletionError('DELETE_FAILED', 503);
  if (profileResult.data?.role === 'admin') throw new AccountDeletionError('ADMIN_ACCOUNT_PROTECTED', 403);

  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  } catch {
    throw new AccountDeletionError('DELETE_FAILED', 503);
  }
}
