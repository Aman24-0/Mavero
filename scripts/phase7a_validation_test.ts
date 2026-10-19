import assert from 'node:assert/strict';
import { parseCategoryForm, parseProviderForm, parseSourceCategoryForm, parseSourceForm, StreamingValidationError } from '../src/lib/server/streaming/validation.ts';

function form(values: Record<string, string | boolean>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'boolean') { if (value) data.set(key, 'on'); }
    else data.set(key, value);
  }
  return data;
}

// Phase 2 note (2026-10-19): parseProviderForm/parseSourceForm became ASYNC when
// provider/source icon upload validation landed (icon bytes are normalized before
// becoming a data-URL); the call convention below was re-pinned to that API.
const provider = await parseProviderForm(form({ name: 'Fixture Provider', slug: 'fixture-provider', status: 'experimental', integration_type: 'template', capabilities: '{"movies":true}', enabled: false }));
assert.equal(provider.slug, 'fixture-provider');
assert.deepEqual(provider.capabilities, { movies: true, sandbox_policy: 'required' });
const unrestrictedProvider = await parseProviderForm(form({ name: 'Unrestricted Provider', slug: 'unrestricted-provider', status: 'experimental', integration_type: 'embed', sandbox_policy: 'unrestricted', capabilities: '{"movie":true}' }));
assert.equal(unrestrictedProvider.capabilities.sandbox_policy, 'unrestricted');

await assert.rejects(() => parseProviderForm(form({ name: 'Bad Provider', slug: 'bad_slug', status: 'experimental', integration_type: 'template' })), StreamingValidationError);
await assert.rejects(() => parseProviderForm(form({ name: 'Bad Provider', slug: 'bad-provider', status: 'unknown', integration_type: 'template' })), StreamingValidationError);
await assert.rejects(() => parseProviderForm(form({ name: 'Bad Provider', slug: 'bad-provider', status: 'experimental', integration_type: 'template', capabilities: '[]' })), StreamingValidationError);

const source = await parseSourceForm(form({ provider_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', name: 'Fixture Source', slug: 'fixture-source', identifier_mode: 'tmdb_id', status: 'experimental', visibility: 'internal', ordering: '2', movie_template: 'configured-only', audio_languages: 'English, Hindi' }));
assert.equal(source.ordering, 2);
assert.deepEqual(source.audio_languages, ['English', 'Hindi']);
// Phase 2 re-pin (2026-10-19) to the documented Phase-8 contract: sandbox is
// PROVIDER-LEVEL ONLY — source capabilities parse as-is, any legacy
// sandbox_policy key is stripped, and player_controls_position is always
// emitted ('default' unless the form carries controls_position_json).
assert.deepEqual(source.capabilities, { player_controls_position: { mode: 'default' } });
const sourceWithLegacySandbox = await parseSourceForm(form({ provider_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', name: 'Fixture Source', slug: 'fixture-source', identifier_mode: 'tmdb_id', status: 'experimental', visibility: 'internal', ordering: '2', movie_template: 'configured-only', audio_languages: 'English, Hindi', capabilities: '{"sandbox_policy":"unrestricted","movies":true}' }));
assert.deepEqual(sourceWithLegacySandbox.capabilities, { movies: true, player_controls_position: { mode: 'default' } });
await assert.rejects(() => parseSourceForm(form({ provider_id: 'not-a-uuid', name: 'Bad Source', slug: 'bad-source', identifier_mode: 'custom', status: 'experimental', visibility: 'public' })), StreamingValidationError);
await assert.rejects(() => parseSourceForm(form({ provider_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', name: 'Bad Source', slug: 'bad-source', identifier_mode: 'custom', status: 'experimental', visibility: 'public', ordering: '-1' })), StreamingValidationError);

const category = parseCategoryForm(form({ name: 'Fixture Category', slug: 'fixture-category', ordering: '4', enabled: true }));
assert.equal(category.ordering, 4);
assert.throws(() => parseCategoryForm(form({ name: 'Bad Category', slug: 'bad_category', ordering: '0' })), StreamingValidationError);
assert.deepEqual(parseSourceCategoryForm(form({ source_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', category_id: 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11', ordering: '0' })), { source_id: '3e7181a3-3999-4844-92bf-4f0afbc5b70f', category_id: 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11', ordering: 0 });
assert.throws(() => parseSourceCategoryForm(form({ source_id: 'bad', category_id: 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11', ordering: '0' })), StreamingValidationError);

console.log('Phase 7A validation tests passed');
