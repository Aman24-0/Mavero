import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getPublicStreamingConfig } from '../src/lib/server/streaming/public-config.ts';
import type { Database } from '../src/lib/server/supabase/database.types.ts';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(url && key, 'Supabase public environment is required');
const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const config = await getPublicStreamingConfig(client);
assert.equal(typeof config.version, 'number');
assert.ok(Array.isArray(config.providers));
assert.ok(Array.isArray(config.sources));
assert.ok(Array.isArray(config.categories));
assert.ok(Array.isArray(config.sourceCategories));
for (const provider of config.providers) {
  assert.ok(!('notes' in provider));
  assert.ok(!('adapter_id' in provider));
}
for (const source of config.sources) {
  assert.ok(!('movie_template' in source));
  assert.ok(!('series_template' in source));
  assert.ok(!('anime_template' in source));
  assert.ok(!('notes' in source));
}
console.log('Phase 7A public configuration contract tests passed');
