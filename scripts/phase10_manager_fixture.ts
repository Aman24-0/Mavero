import type { PlayerSource } from '$lib/shared/player';
import type { PlaybackManager } from '$lib/client/player/PlaybackManager';

/**
 * Phase 10 fixture: drives the REAL PlaybackManager through a preset-source
 * load (the MAVERO aggregate path — no resolver fetch) and then applies a
 * live merge via `updatePresetSource`. Returns whether the merge applied.
 * Encapsulated here so the test file stays declarative.
 */
export async function updateManagerHelper(manager: PlaybackManager, base: PlayerSource, extended: PlayerSource): Promise<boolean> {
  await manager.loadSource(
    { sourceId: base.sourceId, contentId: 'tt-test', mediaType: base.mediaType, presetSource: base },
    0,
    false,
  );
  if (manager.getState().source?.sourceId !== base.sourceId) return false;
  return manager.updatePresetSource(extended);
}
