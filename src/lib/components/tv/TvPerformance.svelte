<script lang="ts">
  import { onMount } from 'svelte';

  type MemorySnapshot = {
    available: boolean;
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };

  type TVPerformanceSample = {
    at: number;
    screen: string;
    domNodes: number;
    memory: MemorySnapshot;
  };

  type TVPerformanceState = {
    marks: string[];
    measures: Array<{ name: string; duration: number }>;
    samples: TVPerformanceSample[];
    startedAt: number;
    longSessionEnabled: boolean;
  };

  let { screen, enabled = false }: { screen: string; enabled?: boolean } = $props();
  let intervalId: number | undefined;
  let performanceState: TVPerformanceState | undefined;

  const getMemory = (): MemorySnapshot => {
    const memory = (performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    }).memory;
    if (!memory) return { available: false };
    return {
      available: true,
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit
    };
  };

  const ensureState = () => {
    if (!performanceState) {
      performanceState = {
        marks: [],
        measures: [],
        samples: [],
        startedAt: performance.timeOrigin + performance.now(),
        longSessionEnabled: enabled
      };
    }
    return performanceState;
  };

  const mark = (name: string) => {
    performance.mark(name);
    const current = ensureState();
    if (!current.marks.includes(name)) current.marks.push(name);
  };

  const measure = (name: string, start: string, end: string) => {
    try {
      const entry = performance.measure(name, start, end);
      ensureState().measures.push({ name, duration: entry.duration });
    } catch {
      // A missing mark should not affect TV navigation or rendering.
    }
  };

  const sample = (sampleScreen: string) => {
    const current = ensureState();
    current.samples.push({
      at: performance.timeOrigin + performance.now(),
      screen: sampleScreen,
      domNodes: document.querySelectorAll('.tv-page *').length,
      memory: getMemory()
    });
    if (current.samples.length > 64) current.samples.shift();
  };

  const publish = () => {
    const current = ensureState();
    current.longSessionEnabled = enabled;
    (window as Window & { __MAVERO_TV_PERFORMANCE__?: TVPerformanceState }).__MAVERO_TV_PERFORMANCE__ = current;
  };

  function startLongSessionMonitor() {
    if (!enabled || intervalId !== undefined) return;
    intervalId = window.setInterval(() => {
      mark(`mavero-tv-session-${Math.floor((performance.now()) / 60000)}m`);
      sample(screen);
      publish();
    }, 60_000);
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    mark(`mavero-tv-screen-${screen}`);
    sample(screen);
    publish();
  });

  $effect(() => {
    if (typeof window !== 'undefined') {
      startLongSessionMonitor();
      publish();
    }
  });

  onMount(() => {
    mark('mavero-tv-js-loaded');
    const markDomContentLoaded = () => {
      mark('mavero-tv-dom-content-loaded');
      publish();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markDomContentLoaded, { once: true });
    else markDomContentLoaded();
    sample(screen);

    requestAnimationFrame(() => {
      mark('mavero-tv-first-paint');
      measure('mavero-tv-js-to-dom', 'mavero-tv-js-loaded', 'mavero-tv-dom-content-loaded');
      measure('mavero-tv-dom-to-first-paint', 'mavero-tv-dom-content-loaded', 'mavero-tv-first-paint');
      publish();
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        mark('mavero-tv-first-interactive-paint');
        measure('mavero-tv-js-to-first-interactive-paint', 'mavero-tv-js-loaded', 'mavero-tv-first-interactive-paint');
        publish();
      });
    });

    startLongSessionMonitor();
    publish();

    return () => {
      document.removeEventListener('DOMContentLoaded', markDomContentLoaded);
      if (intervalId !== undefined) window.clearInterval(intervalId);
      intervalId = undefined;
      publish();
    };
  });
</script>
