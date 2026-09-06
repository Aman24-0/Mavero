// Phase 7: this module re-exports the capability constants from the shared
// module (`src/lib/shared/player-capabilities.ts`) so both client and server
// code import from the same single source of truth. All existing client
// imports (`import { ProviderPlaybackCapabilities } from '$lib/client/player/capabilities'`)
// continue to work unchanged.

export {
  type ProviderPlaybackCapabilities,
  DIRECT_PLAYBACK_CAPABILITIES,
  EMBED_PLAYBACK_CAPABILITIES,
  defaultCapabilitiesForSource,
  VIDSRC_CAPABILITIES,
  VIDLINK_CAPABILITIES,
  VIDY_CAPABILITIES,
  VIDUKI_CAPABILITIES,
  CINEMAOS_CAPABILITIES,
  CINESRC_CAPABILITIES,
  VIDAPI_QZZ_CAPABILITIES,
  VIDPHANTOM_CAPABILITIES,
  MEGAPLAY_CAPABILITIES,
  YENIME_CAPABILITIES,
  PROVIDER_CAPABILITY_MAP,
  CAPABILITY_FIELDS,
  CAPABILITY_LABELS,
  lookupProviderCapabilities,
} from '$lib/shared/player-capabilities';
