import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { parseM3UPlaylist } from './adapters/m3u';
import {
	planSourceIngestion,
	applySourceIngestion,
	type ExistingSourceChannelRow,
	type ExistingEndpointRow
} from './ingestion';

/**
 * Chunked Live TV ingestion — the fix for large playlists (e.g. akindi, ~648
 * channels) that exceed the Netlify function FETCH timeout when ingested in one
 * shot. The BROWSER downloads the playlist (no serverless timeout), splits it
 * into ~50-channel chunks, and POSTs each chunk here.
 *
 * NON-PRUNING BY CONSTRUCTION: `planSourceIngestion` is report-only for entries/
 * endpoints the chunk omits, and `applySourceIngestion` only inserts/updates —
 * it never deletes. So ingesting chunk N leaves every channel in chunks 1..N-1
 * and the not-yet-sent chunks untouched. Identity is content-based
 * (`tvgId ?? hash(url)`), so a channel keeps the same source_channel_id no
 * matter which chunk carries it — repeated/overlapping chunks are idempotent.
 */

const MAX_CHUNK_ENTRIES = 1_000;
const MAX_STATE_ROWS = 50_000;

export type LivetvChunkIngestResult = {
	parsed: number;
	entryWrites: number;
	endpointWrites: number;
	errors: number;
};

async function loadExistingState(client: SupabaseClient<Database>, sourceId: string) {
	const entriesResult = await client
		.from('livetv_source_channels')
		.select('id, source_id, source_channel_id, canonical_channel_id, name, category, logo_url, tvg_id, enabled, metadata')
		.eq('source_id', sourceId)
		.limit(MAX_STATE_ROWS);
	if (entriesResult.error) throw new Error(entriesResult.error.message);
	const entries = (entriesResult.data ?? []) as unknown as ExistingSourceChannelRow[];

	const endpointsResult = await client
		.from('livetv_playback_endpoints')
		.select('id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label')
		.limit(MAX_STATE_ROWS);
	if (endpointsResult.error) throw new Error(endpointsResult.error.message);
	const endpointRows = (endpointsResult.data ?? []) as unknown as ExistingEndpointRow[];
	const entryRowIds = new Set(entries.map((entry) => entry.id));
	const endpoints = endpointRows.filter((endpoint) => entryRowIds.has(endpoint.source_channel_id));

	return { entries, endpoints };
}

export async function ingestLivetvChunk(
	client: SupabaseClient<Database>,
	params: { sourceId: string; text: string }
): Promise<LivetvChunkIngestResult> {
	const parsed = parseM3UPlaylist(params.text, { maxEntries: MAX_CHUNK_ENTRIES });
	if (parsed.channels.length === 0) {
		return { parsed: 0, entryWrites: 0, endpointWrites: 0, errors: 0 };
	}
	const { entries, endpoints } = await loadExistingState(client, params.sourceId);
	const plan = planSourceIngestion({
		sourceId: params.sourceId,
		adapterChannels: parsed.channels,
		existingEntries: entries,
		existingEndpoints: endpoints
	});
	const result = await applySourceIngestion(client, plan);
	return {
		parsed: parsed.channels.length,
		entryWrites: result.appliedEntryWrites,
		endpointWrites: result.appliedEndpointWrites,
		errors: result.errors.length
	};
}
