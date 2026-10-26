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
 * NON-PRUNING: `planSourceIngestion` is report-only for omitted entries and
 * `applySourceIngestion` only inserts/updates — never deletes.
 *
 * RESILIENT + SCOPED:
 *  - Existing state is read ONLY for the chunk's own channels (not the whole
 *    endpoints table). Reading the full table every chunk got heavier as the
 *    table grew — that is what made later chunks (e.g. #18) time out.
 *  - A whole-chunk parse failure falls back to per-entry parsing and SKIPS bad
 *    entries; a DB error on one row is collected and the rest still save; and
 *    the entire ingest is wrapped so it returns a result instead of throwing
 *    (so one bad chunk never aborts the browser's save loop).
 */

const MAX_CHUNK_ENTRIES = 5_000;

export type LivetvChunkIngestResult = {
	parsed: number;
	entryWrites: number;
	endpointWrites: number;
	errors: number;
};

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

function parseChunkResilient(text: string): NormalizedLivetvChannel[] {
	try {
		return parseM3UPlaylist(text, { maxEntries: MAX_CHUNK_ENTRIES }).channels;
	} catch {
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

/** Existing rows for ONLY the given channels (bounded to the chunk). */
async function loadExistingForChannels(
	client: SupabaseClient<Database>,
	sourceId: string,
	sourceChannelIds: string[]
): Promise<{ entries: ExistingSourceChannelRow[]; endpoints: ExistingEndpointRow[] }> {
	if (sourceChannelIds.length === 0) return { entries: [], endpoints: [] };

	const entriesResult = await client
		.from('livetv_source_channels')
		.select('id, source_id, source_channel_id, canonical_channel_id, name, category, logo_url, tvg_id, enabled, metadata')
		.eq('source_id', sourceId)
		.in('source_channel_id', sourceChannelIds);
	if (entriesResult.error) throw new Error(entriesResult.error.message);
	const entries = (entriesResult.data ?? []) as unknown as ExistingSourceChannelRow[];

	const entryRowIds = entries.map((entry) => entry.id);
	let endpoints: ExistingEndpointRow[] = [];
	if (entryRowIds.length > 0) {
		const endpointsResult = await client
			.from('livetv_playback_endpoints')
			.select('id, source_channel_id, endpoint_kind, stream_format, url, ordering, enabled, label')
			.in('source_channel_id', entryRowIds);
		if (endpointsResult.error) throw new Error(endpointsResult.error.message);
		endpoints = (endpointsResult.data ?? []) as unknown as ExistingEndpointRow[];
	}

	return { entries, endpoints };
}

export async function ingestLivetvChunk(
	client: SupabaseClient<Database>,
	params: { sourceId: string; text: string }
): Promise<LivetvChunkIngestResult> {
	const channels = parseChunkResilient(params.text);
	if (channels.length === 0) {
		return { parsed: 0, entryWrites: 0, endpointWrites: 0, errors: 0 };
	}

	try {
		const { entries, endpoints } = await loadExistingForChannels(
			client,
			params.sourceId,
			channels.map((channel) => channel.sourceChannelId)
		);
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
	} catch (error) {
		// Never fail the browser's save loop: report the chunk as processed with
		// zero writes so it advances to the next chunk.
		console.error('[livetv ingest-chunk] chunk failed', error instanceof Error ? error.message : error);
		return { parsed: channels.length, entryWrites: 0, endpointWrites: 0, errors: channels.length };
	}
}
