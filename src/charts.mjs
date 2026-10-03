/**
 * Inline SVG charts, rendered at build time.
 *
 * No client-side charting library and no runtime fetch: the history lines are
 * part of the HTML, so the leaderboard renders with JavaScript disabled and
 * cannot be fed numbers from anywhere but the build.
 */

import { esc, fmtDate, fmtMs } from "./html.mjs";

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };

/**
 * A p50/p95 history line for one metric on one machine.
 *
 * @param {object} options
 * @param {any[]} options.points runs in chronological order
 * @param {string} options.metricName
 * @param {string} options.title
 * @returns {string} SVG markup
 */
export function historyChart({ points, metricName, title }) {
  if (points.length === 0) return "";

  const values = points
    .map((run) => {
      const metric = run.metrics?.[metricName];
      return metric ? [metric.p50, metric.p95] : null;
    })
    .filter((pair) => pair !== null);

  if (values.length === 0) return "";

  const p50s = values.map(([p50]) => p50);
  const p95s = values.map(([, p95]) => p95);
  const rawMax = Math.max(...p95s, ...p50s);
  const rawMin = Math.min(...p50s);
  // A flat series should still get a readable band instead of collapsing to a line.
  const max = rawMax === rawMin ? rawMax * 1.2 + 1 : rawMax * 1.1;
  const min = Math.max(0, rawMin - (rawMax - rawMin) * 0.25 - 1);

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i) =>
    points.length === 1 ? PAD.left + plotW / 2 : PAD.left + (plotW * i) / (points.length - 1);
  const y = (value) => PAD.top + plotH - ((value - min) / (max - min || 1)) * plotH;

  const p50Path = p50s.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const p95Path = p95s.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const bandPath =
    points.length === 1
      ? ""
      : `${p95Path} ${p95s
          .map((v, i) => `L${x(points.length - 1 - i).toFixed(1)} ${y(p50s[points.length - 1 - i]).toFixed(1)}`)
          .join(" ")} Z`;

  const gridLines = [0, 0.5, 1]
    .map((fraction) => {
      const value = min + (max - min) * fraction;
      const yy = y(value);
      return `<line class="chart-grid" x1="${PAD.left}" y1="${yy.toFixed(1)}" x2="${WIDTH - PAD.right}" y2="${yy.toFixed(1)}" />
      <text class="chart-axis" x="${PAD.left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${esc(fmtMs(value))}</text>`;
    })
    .join("\n");

  const firstDate = fmtDate(points[0].finishedAt);
  const lastDate = fmtDate(points[points.length - 1].finishedAt);
  const latestP50 = p50s[p50s.length - 1];
  const latestP95 = p95s[p95s.length - 1];

  const dots = points
    .map((run, i) => {
      const metric = run.metrics?.[metricName];
      if (!metric) return "";
      const label = `${fmtDate(run.finishedAt)} · p50 ${fmtMs(metric.p50)} · p95 ${fmtMs(metric.p95)}`;
      return `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(metric.p50).toFixed(1)}" r="3.5"><title>${esc(label)}</title></circle>`;
    })
    .join("\n");

  return `<svg class="chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(title)}: ${points.length} runs from ${esc(firstDate)} to ${esc(lastDate)}, latest p50 ${esc(fmtMs(latestP50))}, p95 ${esc(fmtMs(latestP95))}" preserveAspectRatio="xMidYMid meet">
  <title>${esc(title)}</title>
  ${gridLines}
  ${bandPath ? `<path class="chart-band" d="${bandPath}" />` : ""}
  <path class="chart-line chart-line-p95" d="${p95Path}" />
  <path class="chart-line chart-line-p50" d="${p50Path}" />
  ${dots}
  <text class="chart-axis" x="${PAD.left}" y="${HEIGHT - 8}" text-anchor="start">${esc(firstDate)}</text>
  <text class="chart-axis" x="${WIDTH - PAD.right}" y="${HEIGHT - 8}" text-anchor="end">${esc(lastDate)}</text>
</svg>`;
}

/** Inline legend so the chart is readable without hovering. */
export function chartLegend() {
  return `<ul class="legend" aria-hidden="true">
  <li><span class="legend-swatch legend-swatch-p50"></span>p50</li>
  <li><span class="legend-swatch legend-swatch-p95"></span>p95</li>
</ul>`;
}

/**
 * A compact inline bar comparing the latest value against the first value in a
 * series, so "over time" is legible even where a chart is overkill.
 * @param {number | null} first
 * @param {number | null} latest
 */
export function sparkBar(first, latest) {
  if (typeof first !== "number" || typeof latest !== "number" || first <= 0) return "";
  const ratio = Math.max(0.04, Math.min(1, latest / first));
  const pct = Math.round((1 - ratio) * 100);
  const direction = latest < first ? "better" : latest > first ? "worse" : "flat";
  return `<span class="spark" role="img" aria-label="${esc(fmtMs(latest))}, ${pct >= 0 ? `${pct}% ` : ""}${direction === "flat" ? "unchanged" : direction === "better" ? "faster" : "slower"} than the first measured run">
  <span class="spark-bar spark-bar-${direction}" style="--spark:${(ratio * 100).toFixed(1)}%"></span>
</span>`;
}
