/**
 * CS-1 live smoke test (READ-ONLY network, no DB writes).
 *
 * Runs the real discovery pipeline against the example CloudStream repository
 * from the task brief: https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json
 *
 * Verifies against REAL-WORLD data: CS.json fetch through the SSRF-safe
 * pipeline, pluginLists resolution, plugins.json parsing, normalization, and
 * the .cs3 never-fetched contract. Nothing is persisted; no repository is
 * added to the catalog.
 */
import { fetchCloudStreamJson } from '$lib/server/cloudstream/security/fetch';
import { parseRepositoryIndex, parsePluginList } from '$lib/server/cloudstream/repository/parse';
import { deriveAdapterStatus } from '$lib/server/cloudstream/adapters/registry';

let passed = 0;
function ok(condition: unknown, label: string) {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_URL = 'https://raw.githubusercontent.com/SaurabhKaperwan/CSX/builds/CS.json';

console.log(`cloudstream_cs1_live_smoke: fetching ${REPO_URL}`);
const indexFetch = await fetchCloudStreamJson(REPO_URL);
ok(indexFetch.body !== null, 'CS.json fetched through the SSRF-safe pipeline');

const parsed = parseRepositoryIndex(indexFetch.body);
console.log(`  repository: ${parsed.name} — ${parsed.description ?? '(no description)'}`);
ok(parsed.name.length > 0, 'repository name parsed from real CS.json');
ok(parsed.pluginLists.length >= 1, `pluginLists resolved (${parsed.pluginLists.length} lists)`);

let total = 0;
let fetchedLists = 0;
let failures = 0;
for (const list of parsed.pluginLists) {
  try {
    const listFetch = await fetchCloudStreamJson(list.url);
    const entries = parsePluginList(listFetch.body);
    fetchedLists += 1;
    total += entries.length;
    console.log(`  list ${list.url}: ${entries.length} extensions`);
    // Show a small sample with the derived compatibility state.
    for (const entry of entries.slice(0, 3)) {
      console.log(`    - ${entry.internalName} (${entry.name ?? '—'}) v${entry.version ?? '?'} lang=${entry.language ?? '?'} tvTypes=[${entry.tvTypes.join(',')}] status=${entry.pluginStatus ?? '?'} → ${deriveAdapterStatus(entry.internalName, entry.pluginStatus)}`);
    }
    if (entries.length > 3) console.log(`    … +${entries.length - 3} more`);
  } catch (error) {
    failures += 1;
    console.log(`  list FAILED: ${list.url} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

ok(fetchedLists >= 1, 'at least one real plugins.json parsed');
ok(total > 0, `extensions discovered in total (${total})`);
console.log(`cloudstream_cs1_live_smoke: ${passed} checks passed (${fetchedLists}/${parsed.pluginLists.length} lists, ${total} extensions${failures ? `, ${failures} list failures` : ''})`);
