import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { deleteProvider, deleteSource, getAdminOverview, listAdminCategories, listAdminProviders, listAdminSources } from '../src/lib/server/streaming/admin-service.ts';
import type { Database } from '../src/lib/server/supabase/database.types.ts';

const url = process.env.PUBLIC_SUPABASE_URL;
const publishableKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const adminEmail = process.env.MAVERO_ADMIN_EMAIL;
const adminPassword = process.env.MAVERO_ADMIN_PASSWORD;
assert.ok(url && publishableKey && adminEmail && adminPassword, 'Supabase and Admin test environment are required');

const makeClient = () => createClient<Database>(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const anonymous = makeClient();
const normal = makeClient();
const admin = makeClient();

const adminLogin = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
assert.equal(adminLogin.error, null, `Admin sign-in failed: ${adminLogin.error?.message ?? 'unknown error'}`);
assert.equal(adminLogin.data.user?.id, '3e7181a3-3999-4844-92bf-4f0afbc5b70f', 'Admin identity mismatch');
const normalLogin = await normal.auth.signInWithPassword({ email: 'mavero.rls.fixture.b@invalid.example', password: 'MaveroRlsFixture-2026!' });
assert.equal(normalLogin.error, null, `Normal User B sign-in failed: ${normalLogin.error?.message ?? 'unknown error'}`);
assert.equal(normalLogin.data.user?.id, 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11', 'Normal identity mismatch');

const suffix = Date.now().toString(36);
const providerSlug = `phase7a-test-provider-${suffix}`;
const sourceSlug = `phase7a-test-source-${suffix}`;
const categorySlug = `phase7a-test-category-${suffix}`;
let providerId = '';
let sourceId = '';
let categoryId = '';

try {
  const beforeMeta = await anonymous.from('streaming_config_meta').select('version').eq('id', 1).limit(1).maybeSingle();
  assert.equal(beforeMeta.error, null, 'Anonymous users may read the non-sensitive config version');

  const baseAnonymousRead = await anonymous.from('streaming_providers').select('name').limit(10);
  assert.ok(baseAnonymousRead.error, 'Anonymous users must not read provider base tables directly');
  const publicProviderRead = await anonymous.from('streaming_public_providers').select('id,name,slug,description,icon,status,enabled,integration_type,capabilities').limit(10);
  assert.equal(publicProviderRead.error, null, 'Anonymous users may read sanitized provider views');
  assert.ok(!('notes' in (publicProviderRead.data?.[0] ?? {})), 'Public provider view must not expose notes');

  const anonymousProviderMutation = await anonymous.from('streaming_providers').insert({ name: 'Anonymous Fixture', slug: `anonymous-${suffix}` });
  assert.ok(anonymousProviderMutation.error, 'Anonymous users must not mutate providers');
  const normalProviderMutation = await normal.from('streaming_providers').insert({ name: 'Normal Fixture', slug: `normal-${suffix}` });
  assert.ok(normalProviderMutation.error, 'Normal users must not mutate providers');
  const normalCategoryMutation = await normal.from('streaming_categories').insert({ name: 'Normal Category', slug: `normal-category-${suffix}` });
  assert.ok(normalCategoryMutation.error, 'Normal users must not mutate categories');

  const providerInsert = await admin.from('streaming_providers').insert({ name: 'Phase 7A Test Provider', slug: providerSlug, description: 'Public test provider', status: 'experimental', enabled: true, integration_type: 'template', adapter_id: `phase7a-${suffix}`, capabilities: { movies: true }, notes: 'PRIVATE ADMIN NOTE' }).select('id').single();
  assert.equal(providerInsert.error, null, `Admin provider insert failed: ${providerInsert.error?.message ?? ''}`);
  providerId = providerInsert.data.id;

  const duplicateProvider = await admin.from('streaming_providers').insert({ name: 'Duplicate Provider', slug: providerSlug });
  assert.ok(duplicateProvider.error, 'Duplicate provider slugs must fail');

  const invalidForeignKey = await admin.from('streaming_sources').insert({ provider_id: '00000000-0000-0000-0000-000000000000', name: 'Invalid FK Source', slug: `invalid-fk-${suffix}` });
  assert.ok(invalidForeignKey.error, 'Invalid source provider IDs must fail');

  const sourceInsert = await admin.from('streaming_sources').insert({ provider_id: providerId, name: 'Phase 7A Test Source', slug: sourceSlug, enabled: true, visibility: 'public', status: 'experimental', ordering: 0, integration_type: 'template', movie_template: 'configuration-only', series_template: 'configuration-only', anime_template: 'configuration-only', identifier_mode: 'tmdb_id', capabilities: { movies: true }, notes: 'PRIVATE SOURCE NOTE' }).select('id').single();
  assert.equal(sourceInsert.error, null, `Admin source insert failed: ${sourceInsert.error?.message ?? ''}`);
  sourceId = sourceInsert.data.id;

  const categoryInsert = await admin.from('streaming_categories').insert({ name: 'Phase 7A Test Category', slug: categorySlug, enabled: true, ordering: 0 }).select('id').single();
  assert.equal(categoryInsert.error, null, `Admin category insert failed: ${categoryInsert.error?.message ?? ''}`);
  categoryId = categoryInsert.data.id;

  const mappingInsert = await admin.from('streaming_source_categories').insert({ source_id: sourceId, category_id: categoryId, ordering: 0 }).select('source_id').single();
  assert.equal(mappingInsert.error, null, `Admin mapping insert failed: ${mappingInsert.error?.message ?? ''}`);

  const publicProvider = await anonymous.from('streaming_public_providers').select('id,name,slug,description,icon,status,enabled,integration_type,capabilities').eq('id', providerId).limit(1).maybeSingle();
  assert.equal(publicProvider.error, null);
  assert.equal(publicProvider.data?.slug, providerSlug);
  assert.ok(!('notes' in (publicProvider.data ?? {})), 'Sanitized provider view must omit notes');
  const publicSource = await anonymous.from('streaming_public_sources').select('id,provider_id,name,slug,visibility,status,ordering,identifier_mode').eq('id', sourceId).limit(1).maybeSingle();
  assert.equal(publicSource.error, null);
  assert.equal(publicSource.data?.slug, sourceSlug);
  assert.ok(!('movie_template' in (publicSource.data ?? {})), 'Sanitized source view must omit templates');
  const publicMapping = await anonymous.from('streaming_public_source_categories').select('source_id,category_id,ordering').eq('source_id', sourceId).limit(1).maybeSingle();
  assert.equal(publicMapping.error, null);
  assert.equal(publicMapping.data?.category_id, categoryId);

  const normalSourceMutation = await normal.from('streaming_sources').insert({ provider_id: providerId, name: 'Normal Source', slug: `normal-source-${suffix}` });
  assert.ok(normalSourceMutation.error, 'Normal users must not mutate sources');
  const normalMappingMutation = await normal.from('streaming_source_categories').insert({ source_id: sourceId, category_id: categoryId, ordering: 1 });
  assert.ok(normalMappingMutation.error, 'Normal users must not mutate source-category mappings');
  const normalRoleEscalation = await normal.from('profiles').update({ role: 'admin' }).eq('id', 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11').select('id').limit(1);
  assert.ok(normalRoleEscalation.error || (normalRoleEscalation.data?.length ?? 0) === 0, 'Normal users must not promote themselves');
  const normalProfile = await normal.from('profiles').select('id,role').eq('id', 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11').limit(1).single();
  assert.equal(normalProfile.data?.role, 'user', 'Normal User B role must remain user');

  await assert.rejects(() => deleteProvider(admin, providerId), /dependent sources/);
  await assert.rejects(() => deleteSource(admin, sourceId), /category assignments/);

  const beforeOverview = await getAdminOverview(admin);
  const sourceDeleteAfterMapping = await admin.from('streaming_source_categories').delete().eq('source_id', sourceId).eq('category_id', categoryId);
  assert.equal(sourceDeleteAfterMapping.error, null);
  const sourceDelete = await admin.from('streaming_sources').delete().eq('id', sourceId);
  assert.equal(sourceDelete.error, null);
  sourceId = '';
  const categoryDelete = await admin.from('streaming_categories').delete().eq('id', categoryId);
  assert.equal(categoryDelete.error, null);
  categoryId = '';
  const providerDelete = await admin.from('streaming_providers').delete().eq('id', providerId);
  assert.equal(providerDelete.error, null);
  providerId = '';
  const afterMeta = await anonymous.from('streaming_config_meta').select('version').eq('id', 1).limit(1).maybeSingle();
  assert.equal(afterMeta.error, null);
  assert.ok((afterMeta.data?.version ?? 0) > beforeOverview.configVersion, 'Admin mutations must bump configuration version');
  const adminProviders = await listAdminProviders(admin);
  const adminSources = await listAdminSources(admin);
  const adminCategories = await listAdminCategories(admin);
  assert.ok(Array.isArray(adminProviders) && Array.isArray(adminSources) && Array.isArray(adminCategories));
  console.log('Phase 7A security and registry lifecycle tests passed');
} finally {
  if (sourceId && categoryId) await admin.from('streaming_source_categories').delete().eq('source_id', sourceId).eq('category_id', categoryId);
  if (sourceId) await admin.from('streaming_sources').delete().eq('id', sourceId);
  if (categoryId) await admin.from('streaming_categories').delete().eq('id', categoryId);
  if (providerId) await admin.from('streaming_providers').delete().eq('id', providerId);
  await admin.auth.signOut();
  await normal.auth.signOut();
}
