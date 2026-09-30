<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminAssetStatus
   *
   * Per-asset status pill that maps the asset lifecycle states
   * ('queued' / 'uploading' / 'processing' / 'ready' / 'failed' /
   * 'deleted') + mavero_status ('available' / 'missing' / 'disabled' /
   * 'stale') to the Admin 2.0 semantic color system.
   *
   * Tone mapping:
   *   ready + available           → green  (Operational)
   *   processing / uploading      → amber  (In Progress)
   *   queued / uploaded           → cyan   (Queued)
   *   failed                      → red    (Failed)
   *   deleted                     → red    (Deleted)
   *   ready + missing (detached)  → amber  (Detached)
   *   ready + disabled            → red    (Disabled)
   *   ready + stale               → amber  (Stale)
   *   no asset                    → amber  (Not Linked)
   */
  import AdminStatus from './AdminStatus.svelte';
  import type { AssetStatus, MaveroStatus } from '$lib/server/hosting/library/service';

  let {
    status = null as AssetStatus | null,
    maveroStatus = null as MaveroStatus | null,
    label = '' as string | null,
  }: {
    status?: AssetStatus | null;
    maveroStatus?: MaveroStatus | null;
    label?: string | null;
  } = $props();

  type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'cyan' | 'blue';

  const { tone, text } = $derived.by(() => {
    // No asset at all — represents "not linked" in the library.
    if (!status) {
      return { tone: 'amber' as Tone, text: label ?? 'Not Linked' };
    }

    // Detached / disabled / stale states override provider status.
    if (maveroStatus === 'disabled') return { tone: 'red' as Tone, text: 'Disabled' };
    if (maveroStatus === 'stale') return { tone: 'amber' as Tone, text: 'Stale' };

    if (status === 'ready' && maveroStatus === 'missing') {
      return { tone: 'amber' as Tone, text: 'Detached' };
    }
    if (status === 'ready' && maveroStatus === 'failed') {
      return { tone: 'red' as Tone, text: 'Failed' };
    }

    // Provider lifecycle.
    switch (status) {
      case 'ready':     return { tone: 'green' as Tone, text: 'Ready' };
      case 'processing': return { tone: 'amber' as Tone, text: 'Processing' };
      case 'uploading':  return { tone: 'amber' as Tone, text: 'Uploading' };
      case 'queued':     return { tone: 'cyan' as Tone, text: 'Queued' };
      case 'uploaded':   return { tone: 'cyan' as Tone, text: 'Uploaded' };
      case 'failed':     return { tone: 'red' as Tone, text: 'Failed' };
      case 'deleted':    return { tone: 'red' as Tone, text: 'Deleted' };
      default:           return { tone: 'neutral' as Tone, text: label ?? 'Unknown' };
    }
  });
</script>

<AdminStatus label={text} tone={tone} />
