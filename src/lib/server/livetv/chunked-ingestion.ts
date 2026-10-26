import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { parseM3UPlaylist } from './adapters/m3u';
import type { NormalizedLivetvChannel } from './adapters/types';
import {
	planSourceIngestion,
	applySourceIngestion,
	type ExistingSourceChannelRow,
	type ExistingEndpointRow
} from './ingestion';

/**
 * Chunked Live TV ingestion — the fix for large playlists (e.g. akindi, ~648
 * channels) that exceed the Netlify fetch timeout when ingested in one shot.
 * The BROWSER downloads the playlist (no serverless timeout), splits it into
 * ~50-channel chunks, and POSTs each chunk here.
 *
 * NON-PRUNING BY CONSTRUCTION: `planSourceIngestion` is report-only for entries/
 * endpoints the chunk omits, and `applySourceIngestion` only inserts/updates —
 * it never deletes. Channels outside this chunk are untouched. Identity is
 * content-based (`tvgId ?? hash(url)`), so chunks are idempotent.
 *
 * RESILIENT PARSING: a single malformed entry must NOT fail the whole chunk. If
 * the whole-chunk parse throws, we fall back to parsing each #EXTINF entry in
 * isolation and SKIP the ones that fail — the rest of the chunk still saves.
 */

const MAX_CHUNK_ENTRIES = 5_000;
const MAX_STATE_ROWS = 50_000;

export type LivetvChunkIngestResult = {
	parsed: number;
	entryWrites: number;
	endpointWrites: number;
	errors: number;
};

/** Split a (possibly partial) playlist into per-entry blocks, each starting at #EXTINF. */
function splitEntries(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const entries: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (line.startsWith('#EXTINF')) {
			if (current.length) entries.push(current.join('\n'));
			current = [line];
		} else if (current.length) {
			current.push(line);
		}
	}
	if (current.length) entries.push(current.join('\n'));
	return entries;
}

/** Parse a chunk, isolating bad entries so one cannot fail the batch. */
function parseChunkResilient(text: string): NormalizedLivetvChannel[] {
	try {
		return parseM3UPlaylist(text, { maxEntries: MAX_CHUNK_ENTRIES }).channels;
	} catch {
		// Whole-chunk parse failed (a policy cap or one bad line). Parse each entry
		// on its own and keep the ones that succeed.
		const channels: NormalizedLivetvChannel[] = [];
		for (const block of splitEntries(text)) {
			try {
				const parsed = parseM3UPlaylist(`#EXTM3U\n${block}`, { maxEntries: 4 });
				for (const channel of parsed.channels) channels.push(channel);
			} catch {
				// skip this bad entry, keep going
			}
		}
		return channels;
	}
}

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
	const channels = parseChunkResilient(params.text);
	if (channels.length === 0) {
		// Nothing usable in this chunk (all entries bad) — a no-op, NOT a failure.
		return { parsed: 0, entryWrites: 0, endpointWrites: 0, errors: 0 };
	}
	const { entries, endpoints } = await loadExistingState(client, params.sourceId);
	const plan = planSourceIngestion({
		sourceId: params.sourceId,
		adapterChannels: channels,
		existingEntries: entries,
		existingEndpoints: endpoints
	});
	const result = await applySourceIngestion(client, plan);
	return {
		parsed: channels.length,
		entryWrites: result.appliedEntryWrites,
		endpointWrites: result.appliedEndpointWrites,
		errors: result.errors.length
	};
}
