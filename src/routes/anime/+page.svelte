<script lang="ts">
  import ExplorerPage from '$components/ExplorerPage.svelte';
  import type { ExplorerFeedSnapshotHandlers } from '$components/ExplorerPage.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // MAV-20 Phase D — route-level SvelteKit snapshot delegating to the
  // ExplorerPage component's feed capture/restore handlers (the
  // Upcoming/Search page architecture). The handlers are registered in
  // the component's onMount, which runs during render — always before
  // SvelteKit restores snapshots on a popstate navigation. The closure
  // reads the current handlers at call time, so a remount after
  // back-navigation re-registers fresh handlers before restore fires.
  let feedSnapshot: ExplorerFeedSnapshotHandlers | undefined;

  export const snapshot = {
    capture: () => feedSnapshot?.capture() ?? null,
    restore: (value: unknown) => feedSnapshot?.restore(value)
  };
</script>

<ExplorerPage
  type="anime"
  spotlight={data.spotlight}
  sections={data.sections}
  filteredItems={data.filteredItems}
  currentPage={data.page}
  hasNextPage={data.hasNextPage}
  totalPages={data.totalPages}
  filters={data.filters}
  errorMessage={data.errorMessage}
  registerFeedSnapshot={(handlers) => (feedSnapshot = handlers)}
/>
