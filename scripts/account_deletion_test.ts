import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteAuthenticatedAccount, AccountDeletionError } from '../src/lib/server/account/deletion.ts';

type AdminClient = Parameters<typeof deleteAuthenticatedAccount>[1];

type FakeOptions = {
  role?: 'user' | 'admin' | null;
  profileError?: { code?: string } | null;
  deleteError?: { code?: string } | null;
};

function fakeAdmin(options: FakeOptions = {}) {
  const deletedUserIds: string[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, 'profiles', 'account deletion should inspect only the authenticated profile role');
      return {
        select(columns: string) {
          assert.equal(columns, 'role');
          return {
            eq(column: string, value: string) {
              assert.equal(column, 'id');
              assert.equal(value, 'test-user-id');
              return {
                limit(count: number) {
                  assert.equal(count, 1);
                  return {
                    async maybeSingle() {
                      return {
                        data: options.role ? { role: options.role } : null,
                        error: options.profileError ?? null
                      };
                    }
                  };
                }
              };
            }
          };
        }
      };
    },
    auth: {
      admin: {
        async deleteUser(userId: string) {
          deletedUserIds.push(userId);
          return { error: options.deleteError ?? null };
        }
      }
    }
  } as unknown as AdminClient;
  return { client, deletedUserIds };
}

const successful = fakeAdmin({ role: 'user' });
await deleteAuthenticatedAccount('test-user-id', successful.client);
assert.deepEqual(successful.deletedUserIds, ['test-user-id'], 'the server must delete the verified session user');

const protectedAdmin = fakeAdmin({ role: 'admin' });
await assert.rejects(
  () => deleteAuthenticatedAccount('test-user-id', protectedAdmin.client),
  (error: unknown) => error instanceof AccountDeletionError && error.code === 'ADMIN_ACCOUNT_PROTECTED' && error.status === 403
);
assert.deepEqual(protectedAdmin.deletedUserIds, [], 'admin accounts must not reach auth.admin.deleteUser');

const profileFailure = fakeAdmin({ profileError: { code: 'PROFILE_LOOKUP_FAILED' } });
await assert.rejects(
  () => deleteAuthenticatedAccount('test-user-id', profileFailure.client),
  (error: unknown) => error instanceof AccountDeletionError && error.code === 'DELETE_FAILED' && error.status === 503
);
assert.deepEqual(profileFailure.deletedUserIds, [], 'profile lookup failure must fail closed');

const authFailure = fakeAdmin({ role: 'user', deleteError: { code: 'AUTH_DELETE_FAILED' } });
await assert.rejects(
  () => deleteAuthenticatedAccount('test-user-id', authFailure.client),
  (error: unknown) => error instanceof AccountDeletionError && error.code === 'DELETE_FAILED' && error.status === 503
);
assert.deepEqual(authFailure.deletedUserIds, ['test-user-id'], 'auth deletion failures must normalize to a safe server error');

const endpoint = await readFile(new URL('../src/routes/api/account/delete/+server.ts', import.meta.url), 'utf8');
const settings = await readFile(new URL('../src/routes/settings/+page.svelte', import.meta.url), 'utf8');
const profile = await readFile(new URL('../src/routes/profile/+page.svelte', import.meta.url), 'utf8');
const dialog = await readFile(new URL('../src/lib/components/ConfirmDialog.svelte', import.meta.url), 'utf8');
assert.match(endpoint, /safeGetSession/);
assert.match(endpoint, /confirmation !== 'DELETE'/);
assert.match(endpoint, /deletionInFlight/);
assert.doesNotMatch(endpoint, /user_id\s*:/);
assert.match(settings, /Danger zone/);
assert.match(settings, /deleteConfirmation !== 'DELETE'/);
assert.match(settings, /clearLocalData/);
assert.match(profile, /title="Sign out\?"/);
assert.match(profile, /fetch\('\/auth\/sign-out'/);
assert.match(dialog, /role="alertdialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /event\.key === 'Escape'/);
assert.match(dialog, /event\.key !== 'Tab'/);
assert.doesNotMatch(dialog, /sheet-backdrop.*onclick/);

console.log('Account deletion and sign-out confirmation regression tests passed');
