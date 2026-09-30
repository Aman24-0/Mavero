<script lang="ts">
  /**
   * AdminTrendChart — lightweight inline SVG line chart for analytics trends.
   *
   * No charting library dependency — pure SVG with the existing design
   * tokens. Renders a single line series with optional area fill, axis
   * labels, and hover tooltips. Accessible: includes a `role="img"` and
   * a text summary of the data for screen readers.
   *
   * Designed for the Phase 2 Overview dashboard (daily/weekly/monthly
   * unique-user counts). The chart is responsive: the SVG uses
   * viewBox + preserveAspectRatio so it scales to its container width.
   */
  import type { TrendPoint } from '$lib/server/analytics/overview';

  let {
    points,
    label = 'Reach trend',
    emptyMessage = 'No data for this period.'
  }: {
    points: TrendPoint[];
    label?: string;
    emptyMessage?: string;
  } = $props();

  // Chart dimensions (the SVG viewBox; the rendered size is CSS-controlled).
  const WIDTH = 760;
  const HEIGHT = 240;
  const PAD_LEFT = 44;
  const PAD_RIGHT = 16;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 36;
  const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
  const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

  // Compute scales.
  const values = $derived(points.map((p) => p.value));
  const maxValue = $derived(Math.max(1, ...values)); // avoid divide-by-zero
  const pointCount = $derived(points.length);

  // Scale a point to SVG coordinates.
  function x(i: number): number {
    if (pointCount <= 1) return PAD_LEFT + PLOT_W / 2;
    return PAD_LEFT + (i / (pointCount - 1)) * PLOT_W;
  }
  function y(v: number): number {
    return PAD_TOP + PLOT_H - (v / maxValue) * PLOT_H;
  }

  // Build the line path + area path.
  const linePath = $derived(
    points.length === 0
      ? ''
      : points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  );
  const areaPath = $derived(
    points.length === 0
      ? ''
      : `${linePath} L ${x(points.length - 1).toFixed(1)} ${(PAD_TOP + PLOT_H).toFixed(1)} L ${x(0).toFixed(1)} ${(PAD_TOP + PLOT_H).toFixed(1)} Z`
  );

  // Y-axis ticks (4 ticks: 0, max/4, max/2, max).
  const yTicks = $derived([0, Math.round(maxValue * 0.25), Math.round(maxValue * 0.5), Math.round(maxValue * 0.75), maxValue]);

  // X-axis labels — show ~6 evenly spaced labels to avoid crowding.
  const xLabelIndices = $derived(() => {
    if (pointCount <= 6) return points.map((_, i) => i);
    const step = Math.ceil(pointCount / 6);
    const indices: number[] = [];
    for (let i = 0; i < pointCount; i += step) indices.push(i);
    if (indices[indices.length - 1] !== pointCount - 1) indices.push(pointCount - 1);
    return indices;
  });

  // Shorten a date label for the x-axis.
  function shortLabel(label: string): string {
    // YYYY-MM-DD → "M/D"
    // YYYY-MM → "Mon YYYY"
    if (label.length === 10) {
      const [y, m, d] = label.split('-');
      return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
    }
    if (label.length === 7) {
      const [y, m] = label.split('-');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[parseInt(m, 10) - 1] ?? m} ${y}`;
    }
    return label;
  }

  // Hover state.
  let hoverIndex = $state<number | null>(null);

  function onMove(event: MouseEvent) {
    if (pointCount === 0) return;
    const svg = event.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    // Convert mouse X to SVG viewBox X.
    const mouseX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    // Find the nearest point.
    const plotX = mouseX - PAD_LEFT;
    if (plotX < 0 || plotX > PLOT_W) {
      hoverIndex = null;
      return;
    }
    const idx = Math.round((plotX / PLOT_W) * (pointCount - 1));
    hoverIndex = Math.max(0, Math.min(pointCount - 1, idx));
  }
  function onLeave() {
    hoverIndex = null;
  }

  // Accessible text summary.
  const summary = $derived(
    points.length === 0
      ? emptyMessage
      : `${label}: ${points.length} points from ${points[0].label} to ${points[points.length - 1].label}. ` +
        `Values range from ${Math.min(...values)} to ${Math.max(...values)}.`
  );
</script>

{#if points.length === 0}
  <div class="chart-empty" role="img" aria-label={summary}>
    <span class="chart-empty-text">{emptyMessage}</span>
  </div>
{:else}
  <div class="chart-wrapper">
    <svg
      class="trend-chart"
      viewBox="0 0 {WIDTH} {HEIGHT}"
      preserveAspectRatio="none"
      role="img"
      aria-label={summary}
      onmousemove={onMove}
      onmouseleave={onLeave}
    >
      <!-- Y-axis grid lines + labels -->
      {#each yTicks as tick}
        <line
          x1={PAD_LEFT}
          y1={y(tick)}
          x2={WIDTH - PAD_RIGHT}
          y2={y(tick)}
          class="grid-line"
        />
        <text
          x={PAD_LEFT - 8}
          y={y(tick) + 3}
          class="axis-label"
          text-anchor="end"
        >{tick}</text>
      {/each}

      <!-- Area fill -->
      <path d={areaPath} class="area-fill" />

      <!-- Line -->
      <path d={linePath} class="line" />

      <!-- Points -->
      {#each points as p, i}
        <circle
          cx={x(i)}
          cy={y(p.value)}
          r={hoverIndex === i ? 4 : 2.5}
          class="point"
          class:hover={hoverIndex === i}
        />
      {/each}

      <!-- X-axis labels -->
      {#each xLabelIndices() as i}
        <text
          x={x(i)}
          y={HEIGHT - PAD_BOTTOM + 16}
          class="axis-label"
          text-anchor="middle"
        >{shortLabel(points[i].label)}</text>
      {/each}

      <!-- Hover tooltip -->
      {#if hoverIndex !== null}
        <g class="tooltip">
          <rect
            x={Math.min(x(hoverIndex) - 60, WIDTH - PAD_RIGHT - 120)}
            y={y(points[hoverIndex].value) - 36}
            width="120"
            height="28"
            rx="6"
            class="tooltip-bg"
          />
          <text
            x={Math.min(x(hoverIndex) - 60, WIDTH - PAD_RIGHT - 120) + 60}
            y={y(points[hoverIndex].value) - 18}
            class="tooltip-label"
            text-anchor="middle"
          >{points[hoverIndex].label}: {points[hoverIndex].value}</text>
        </g>
      {/if}
    </svg>
  </div>
{/if}

<style>
  .chart-wrapper {
    width: 100%;
    overflow: hidden;
  }
  .trend-chart {
    display: block;
    width: 100%;
    height: 240px;
  }
  .grid-line {
    stroke: rgba(0, 255, 156, .06);
    stroke-width: 1;
  }
  .axis-label {
    fill: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 9px;
    font-weight: 500;
  }
  .area-fill {
    fill: rgba(0, 255, 156, .08);
    stroke: none;
  }
  .line {
    fill: none;
    stroke: var(--color-primary);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .point {
    fill: var(--color-primary);
    stroke: var(--color-surface);
    stroke-width: 1.5;
    transition: r var(--motion-fast) var(--ease-out);
  }
  .point.hover {
    fill: var(--color-text);
  }
  .tooltip-bg {
    fill: var(--color-surface-elevated);
    stroke: var(--color-primary-border);
    stroke-width: 1;
  }
  .tooltip-label {
    fill: var(--color-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px;
    font-weight: 600;
  }
  .chart-empty {
    display: grid;
    place-items: center;
    min-height: 200px;
    padding: 32px 16px;
    text-align: center;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-md);
    background: rgba(0, 255, 156, .012);
  }
  .chart-empty-text {
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.6;
  }

  @media (max-width: 640px) {
    .trend-chart {
      height: 180px;
    }
  }
</style>
