/**
 * MAV-FOCUSED — Phase 2 verification — live CHECK constraint probe.
 *
 * Verifies that the `media_operations.action` CHECK constraint on the
 * LIVE Supabase instance accepts both 'link' and 'unlink' actions by
 * attempting a safe test-insert + immediate delete. The test row uses
 * NULL FKs (allowed by schema) so it doesn't require any real
 * media_item / media_asset / profile row to exist.
 *
 * This is additive-then-subtractive: no permanent changes remain.
 *
 * Usage:
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY=... \
 *   PUBLIC_SUPABASE_URL=... \
 *   node scripts/mav_phase2_check_constraint_probe.mjs
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing env: PUBLIC_SUPABASE_URL or PRIVATE_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let passed = 0;
let failed = 0;

function ok(cond, label, extra = '') {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}${extra ? ' ' + extra : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${label}${extra ? ' ' + extra : ''}`); }
}

console.log('\n§1 — CHECK constraint accepts action=link');

// Insert a test row with action='link', all FKs NULL.
const linkInsert = await supabase
  .from('media_operations')
  .insert({
    action: 'link',
    status: 'success',
    details: { probe: 'mav_phase2_check_constraint_probe', note: 'temporary test row — will be deleted' },
    error_code: null,
    error_message: null,
  })
  .select('id')
  .single();

if (linkInsert.error) {
  ok(false, '1a. INSERT with action=link succeeded', `(${linkInsert.error.message})`);
  ok(false, '1b. test row insert returned id');
} else {
  ok(true, '1a. INSERT with action=link succeeded');
  ok(!!linkInsert.data?.id, '1b. test row insert returned id', `= ${linkInsert.data.id.slice(0, 8)}…`);

  // Clean up.
  const linkDelete = await supabase
    .from('media_operations')
    .delete()
    .eq('id', linkInsert.data.id);
  ok(!linkDelete.error, '1c. cleanup of link test row succeeded',
    linkDelete.error ? `(${linkDelete.error.message})` : '');
}

console.log('\n§2 — CHECK constraint accepts action=unlink');

const unlinkInsert = await supabase
  .from('media_operations')
  .insert({
    action: 'unlink',
    status: 'success',
    details: { probe: 'mav_phase2_check_constraint_probe', note: 'temporary test row — will be deleted' },
    error_code: null,
    error_message: null,
  })
  .select('id')
  .single();

if (unlinkInsert.error) {
  ok(false, '2a. INSERT with action=unlink succeeded', `(${unlinkInsert.error.message})`);
  ok(false, '2b. test row insert returned id');
  console.log('');
  console.log('  -- WARNING: action=unlink was rejected. This means migration');
  console.log('             20261014000000_add_unlink_action.sql has NOT been applied');
  console.log('             to the live Supabase instance. The manual-link DELETE');
  console.log('             endpoint\'s audit log inserts will fail until the migration');
  console.log('             is applied. The DELETE itself will still succeed (the');
  console.log('             media_assets row deletion happens BEFORE recordOperation),');
  console.log('             but the audit trail will be incomplete.');
} else {
  ok(true, '2a. INSERT with action=unlink succeeded');
  ok(!!unlinkInsert.data?.id, '2b. test row insert returned id', `= ${unlinkInsert.data.id.slice(0, 8)}…`);

  // Clean up.
  const unlinkDelete = await supabase
    .from('media_operations')
    .delete()
    .eq('id', unlinkInsert.data.id);
  ok(!unlinkDelete.error, '2c. cleanup of unlink test row succeeded',
    unlinkDelete.error ? `(${unlinkDelete.error.message})` : '');
}

console.log('\n§3 — CHECK constraint rejects unknown action (negative test)');

const bogusInsert = await supabase
  .from('media_operations')
  .insert({
    action: 'bogus_action_xyz',
    status: 'success',
    details: { probe: 'negative_test' },
  })
  .select('id')
  .single();

// This SHOULD fail with a CHECK violation — confirms the constraint is enforced.
if (bogusInsert.error) {
  ok(true, '3a. bogus action correctly rejected', `(${bogusInsert.error.code}: ${bogusInsert.error.message.slice(0, 100)})`);
} else {
  ok(false, '3a. bogus action incorrectly accepted (CHECK constraint missing or weakened)');
  // Cleanup if somehow it was inserted.
  await supabase.from('media_operations').delete().eq('id', bogusInsert.data.id);
}

console.log(`\nmav_phase2_check_constraint_probe: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
