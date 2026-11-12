// ============================================================================
// CLIENT progress module — public type surface (FAÇADE).
//
// Phase 3 3-A (repository-cleanup roadmap, audit §3.3 #1+#2 / §7 P3-1):
// the record CONTRACT (types, keys, validators, normalizers, the canonical
// resume-target selector) moved VERBATIM to `$lib/shared/progress-records`
// so the server (`supabase/records.ts`, `api/account/*`) and the shared
// merge layer (`shared/progress-merge.ts`) no longer import RUNTIME code
// from client-land (server→client / shared→client layering inversions).
//
// This file re-exports the shared contract so every existing client
// import path (`$lib/client/progress/types`, used by the progress
// service/database, my-list, DetailPage, watch page, and the script
// suites) keeps working UNCHANGED. Client→shared is the CORRECT inward
// direction; client-land keeps only what is genuinely client-local:
// the storage-layer input/status types below.
// ============================================================================

import type { ContentSnapshot, PlaybackContext, SourceRuntimeEntry } from '$lib/shared/progress-records';

export * from '$lib/shared/progress-records';

export type SaveProgressInput = PlaybackContext & {
  currentTime: number;
  duration?: number;
  selectedSourceId?: string;
  sourceRuntimes?: Record<string, SourceRuntimeEntry>;
  snapshot: ContentSnapshot;
  completed?: boolean;
  now?: number;
  // Optional: the position-freshness timestamp to persist. When omitted,
  // saveProgress() computes it: if currentTime advanced, use `now`;
  // otherwise preserve the existing record's positionUpdatedAt (or fall
  // back to `now` for new records). This lets the ProgressWriter control
  // whether a given flush advances the position-freshness clock or not
  // (runtime-only updates must NOT advance it).
  positionUpdatedAt?: number;
};

export type LocalStorageStatus = 'indexeddb' | 'memory' | 'unavailable';

export type LocalProgressState = {
  status: LocalStorageStatus;
  message?: string;
};
