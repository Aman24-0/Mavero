// LT-2 — LiveGT V1 client types (Live TV data layer).
//
// ISOLATION CONTRACT (live-tv-plan.md §5/§13, decision D5):
//   These types describe the LiveGT V1 public API ONLY. They are deliberately
//   kept separate from the VOD/provider types (`src/lib/shared/player.ts`
//   PlayerSource, resolver types, TMDB/content types). Live TV must never be
//   forced into the VOD `PlayerSource` shape, and no VOD code may import this
//   module. The future Shaka player (LT-3) consumes these types.
//
// VERIFIED CONTRACT (LT-0 live probes + official docs, 2026-10-07):
//   GET /api/public/channels          → { count, channels: [...] }
//   GET /api/public/channels/{id}     → channel + sources[] + drm
//   GET /api/public/guide/{id}        → { generatedAt, id, nowPlaying,
//                                        upNext, upcoming[], guide[] }
//   Only V1 endpoints. The V2 catalogue is OUT OF SCOPE and must never be
//   called by Mavero V1 code.
//
// TWO KINDS OF TYPES LIVE HERE:
//   1. NORMALIZED models (`LiveTvChannel`, `LiveTvGuide`, ...) — the stable
//      internal shapes every caller consumes. Raw LiveGT response objects are
//      NEVER spread through the UI (plan §8).
//   2. WIRE shapes (`*Response`, `*Wire`) — the UNTRUSTED raw JSON bodies,
//      with every field typed `unknown` because nothing from the network is
//      trusted until `api.ts` normalizers validate it. These exist to
//      document the observed LiveGT field names and to type test fixtures.
//
// FIELD MAPPING (wire → normalized), documented once, applied in api.ts:
//   channel:  id → id, name → name, category → category, logo → logo
//   (embed/watch wire fields are intentionally NOT mapped — Mavero never
//   uses LiveGT embed/watch URLs for playback; plan §3.)
//   programme: title → title, desc → description, category → category,
//     image → image, start → startSeconds, stop → stopSeconds,
//     startTime → startDisplay, stopTime → stopDisplay
//
// TIMESTAMP CONTRACT:
//   LiveGT guide timestamps (`start`, `stop`) are Unix SECONDS. The project
//   has no existing guide/EPG time convention to justify a conversion, so
//   the source semantics are PRESERVED and the unit is made explicit in the
//   field names (`startSeconds`/`stopSeconds`). Provider display strings
//   (`startTime`/`stopTime`) are carried as optional display-only values.

/** Normalized LiveGT V1 channel (catalogue entry). */
export type LiveTvChannel = {
        /** LiveGT channel id — the source identifier used for /channels/{id} and /guide/{id}. */
        id: string;
        /** Channel display name. */
        name: string;
        /** Category exactly as LiveGT provides it (e.g. "Sports"). Omitted when the source has no usable category. */
        category?: string;
        /** Logo URL exactly as LiveGT provides it. Omitted when the source has no usable logo. */
        logo?: string;
        /**
         * LT-18 — the channel's LANGUAGE, derived ONLY from the truthful
         * upstream `category` value when that value is a recognized language
         * name (LiveGT V1 has NO dedicated language field — verified against
         * the live wire payload 2026-10-09: fields are exactly
         * id/name/category/logo/embed/watch). Omitted for genre-classified
         * channels (News, Sports, Movies, …) — never guessed, never
         * fabricated. Normalized in api.ts (liveTvLanguageFromCategory).
         */
        language?: string;
};

/**
 * Raw (untrusted) catalogue / resolution channel object.
 *
 * `embed` and `watch` are documented wire fields. Mavero intentionally never
 * reads them for playback (plan §3: no iframe / external player) — they exist
 * in this shape only so the wire contract is fully documented.
 */
export type LiveTvChannelWire = {
        id?: unknown;
        name?: unknown;
        category?: unknown;
        logo?: unknown;
        sources?: unknown;
        drm?: unknown;
        embed?: unknown;
        watch?: unknown;
};

/** Raw (untrusted) GET /api/public/channels response body. */
export type LiveTvChannelListResponse = {
        count?: unknown;
        channels?: unknown;
};

/** Raw (untrusted) GET /api/public/channels/{id} response body. */
export type LiveTvChannelResponse = LiveTvChannelWire;

/** Raw (untrusted) DRM object from the channel resolution response. */
export type LiveTvDrmWire = {
        type?: unknown;
        keyId?: unknown;
        key?: unknown;
};

/**
 * Normalized playback source for one channel.
 *
 * `url` is a SHORT-LIVED SIGNED manifest URL (MPEG-DASH MPD for V1). It must
 * only ever exist in runtime memory: never persisted to Supabase, Web Storage
 * or IndexedDB, never logged, never sent to analytics (plan §11).
 */
export type LiveTvPlaybackSource = {
        url: string;
};

/**
 * Normalized LiveGT V1 ClearKey DRM metadata (transport only).
 *
 * LT-2 only VALIDATES and TRANSPORTS this data. Configuring a player (Shaka
 * ClearKey config) is LT-3. `keyId`/`key` values are secrets-in-transit: they
 * must never be logged, persisted or included in error messages.
 */
export type LiveTvDrm = {
        type: 'clearkey';
        keyId: string;
        key: string;
};

/**
 * Normalized playback resolution for one channel — the contract LT-3's Shaka
 * player will consume. Always freshly resolved: this object is produced per
 * `resolveLiveTvPlayback()` call and is never cached by the client layer.
 */
export type LiveTvPlaybackResolution = {
        /** Channel metadata from the resolution response (id is the requested id). */
        channel: LiveTvChannel;
        /** Validated playback sources in source order. At least one entry. */
        sources: LiveTvPlaybackSource[];
        /** ClearKey metadata when the stream is encrypted; null when unencrypted. */
        drm: LiveTvDrm | null;
};

/** Normalized programme guide entry (one show in the schedule). */
export type LiveTvGuideProgramme = {
        title: string;
        /** Wire `desc`. Omitted when absent. */
        description?: string;
        category?: string;
        /** Image URL (observed on schedule entries only). Omitted when absent. */
        image?: string;
        /** Wire `start` — Unix seconds, preserved as-is. */
        startSeconds: number;
        /** Wire `stop` — Unix seconds, preserved as-is. */
        stopSeconds: number;
        /** Wire `startTime` — provider display string. Omitted when absent. */
        startDisplay?: string;
        /** Wire `stopTime` — provider display string. Omitted when absent. */
        stopDisplay?: string;
};

/** Raw (untrusted) programme object from the guide response. */
export type LiveTvGuideProgrammeWire = {
        title?: unknown;
        desc?: unknown;
        category?: unknown;
        image?: unknown;
        start?: unknown;
        stop?: unknown;
        startTime?: unknown;
        stopTime?: unknown;
};

/** Raw (untrusted) GET /api/public/guide/{id} response body. */
export type LiveTvGuideResponse = {
        generatedAt?: unknown;
        id?: unknown;
        nowPlaying?: unknown;
        upNext?: unknown;
        upcoming?: unknown;
        guide?: unknown;
};

/**
 * Normalized programme guide for one channel.
 *
 * An empty guide (`nowPlaying`/`upNext` null, empty `upcoming`/`schedule`) is
 * a VALID state, not an error (plan §12).
 */
export type LiveTvGuide = {
        /** The requested channel id (identity is caller-owned). */
        channelId: string;
        /** Currently playing programme, or null. */
        nowPlaying: LiveTvGuideProgramme | null;
        /** Next programme, or null. */
        upNext: LiveTvGuideProgramme | null;
        /** The next few programmes (wire `upcoming`). */
        upcoming: LiveTvGuideProgramme[];
        /** The full available schedule (wire `guide`). */
        schedule: LiveTvGuideProgramme[];
        /**
         * Wire `generatedAt` — UNDOCUMENTED by LiveGT. Live observations return a
         * display STRING (not Unix seconds), so this field is only populated when
         * a finite number ever arrives; otherwise it is omitted. Do not rely on it.
         */
        generatedAtSeconds?: number;
};

/** Options for catalogue retrieval (`getLiveTvChannels`). */
export type LiveTvChannelsOptions = {
        /** Cancels the request (and any cache read is skipped once aborted). */
        signal?: AbortSignal;
        /** Remote category filter (documented `?category=` param). */
        category?: string;
        /** Bypass the catalogue cache for this call. */
        forceRefetch?: boolean;
};

/** Options for remote search (`searchLiveTvChannels`). */
export type LiveTvSearchOptions = {
        signal?: AbortSignal;
        forceRefetch?: boolean;
};

/** Options for playback resolution (`resolveLiveTvPlayback`). */
export type LiveTvPlaybackOptions = {
        signal?: AbortSignal;
};

/** Options for guide retrieval (`getLiveTvGuide`). */
export type LiveTvGuideOptions = {
        signal?: AbortSignal;
        forceRefetch?: boolean;
};
