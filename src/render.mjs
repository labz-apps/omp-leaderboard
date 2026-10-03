/**
 * Static page rendering.
 *
 * Every asset and cross-page reference on the main pages is relative, so the
 * same build works at a domain root, at a `/repo/` project Pages path, or under
 * any prefix. The only exception is `404.html`, which GitHub Pages serves for
 * arbitrary deep paths and therefore needs the configured base path; that is
 * the single documented reason `--base` exists.
 */

import { BENCHMARKS, BENCHMARK_DESCRIPTIONS, BENCHMARK_LABELS } from "./schema.mjs";
import { buildSeries, headline, latestPerSeries, machineFingerprint, primaryMetricName, sortRuns } from "./deltas.mjs";
import { chartLegend, historyChart, sparkBar } from "./charts.mjs";
import { cx, deltaDirection, esc, fmtDate, fmtDateTime, fmtDeltaMs, fmtMs, fmtPct, safeHref } from "./html.mjs";

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.active "index" | "changelog"
 * @param {string} options.body
 * @param {{generatedAt: string, runCount: number, publishableCount: number, skippedCount: number, sourceRepo: string, basePath: string}} options.meta
 */
export function layout({ title, active, body, meta, preview = false }) {
  const nav = [
    { id: "index", href: "./index.html", label: "Leaderboard" },
    { id: "changelog", href: "./changelog.html", label: "Changelog" },
  ]
    .map(
      (item) =>
        `<a class="nav-link${item.id === active ? " nav-link-active" : ""}" href="${item.href}"${item.id === active ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`,
    )
    .join("\n      ");

  const banner = preview
    ? `<p class="preview-banner" role="alert"><strong>Preview build.</strong> The numbers on this page come from test fixtures, not from a benchmark run. Nothing here is a measurement of oh-my-pi.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${preview ? "\n<meta name=\"robots\" content=\"noindex\">" : ""}
<meta name="description" content="Measured cold start and time-to-render for oh-my-pi, one row per merged PR.">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="./assets/styles.css">
<link rel="icon" href="./assets/favicon.svg" type="image/svg+xml">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${banner}
<header class="site-header">
  <div class="wrap">
    <p class="eyebrow">oh-my-pi performance</p>
    <h1>${esc(active === "changelog" ? "Changelog" : "Leaderboard")}</h1>
    <nav class="nav" aria-label="Sections">
      ${nav}
    </nav>
  </div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${meta.publishableCount} measured run${meta.publishableCount === 1 ? "" : "s"} from merged PRs${meta.runCount > meta.publishableCount ? `, ${meta.runCount - meta.publishableCount} pending` : ""}. Built ${esc(meta.generatedAt)}.</p>
    <p>No number on this site is typed by hand. Every value is read from a harness result file that records the commit, the merged PR, the machine, the versions, and the exact harness command. Deltas are computed at build time from two such files and are never stored.</p>
    <p>Measurements are only comparable within one machine and one benchmark. Deltas never cross machines. <a href="${esc(safeHref(meta.sourceRepo) ?? "#")}">Harness and result files</a></p>
  </div>
</footer>
<script src="./assets/app.js" defer></script>
</body>
</html>
`;
}

/**
 * @param {object} options
 * @param {Record<string, any>[]} options.runs
 * @param {{generatedAt: string, sourceRepo: string}} options.meta
 */
export function renderIndex({ runs, meta, preview = false }) {
  const publishable = runs.filter((run) => run.publishable);
  const series = buildSeries(publishable);

  if (publishable.length === 0) {
    return layout({
      title: "oh-my-pi leaderboard",
      active: "index",
      preview,
      meta: {
        ...meta,
        runCount: runs.length,
        publishableCount: 0,
        skippedCount: runs.length,
      },
      body: emptyState({
        runs,
        title: "No benchmark has landed on a merged PR yet",
        body:
          "This page renders itself from harness result files. Until one exists for a merged pull request, there is nothing to plot — and nothing invented to fill the gap. The first merged PR measured by the harness will appear here with its commit, machine, versions, and measured delta.",
        meta,
      }),
    });
  }

  const sections = Object.values(BENCHMARKS)
    .map((benchmark) => renderBenchmarkSection(benchmark, series))
    .join("\n");

  const pending = runs.filter((run) => !run.publishable);
  const pendingSection =
    pending.length > 0
      ? `<section class="card card-muted">
  <h2>Awaiting merge</h2>
  <p class="muted">These runs are real measurements, but they are not on a merged pull request yet, so they are not leaderboard rows.</p>
  ${runsTable(pending, { caption: "Measurements not yet tied to a merged PR", showDelta: true, emptyNote: null })}
</section>`
      : "";

  return layout({
    title: "oh-my-pi leaderboard",
    active: "index",
    preview,
    meta: {
      ...meta,
      runCount: runs.length,
      publishableCount: publishable.length,
      skippedCount: runs.length - publishable.length,
    },
    body: `<section class="intro">
  <p class="lede">Cold start is process launch to first interactive frame. Time to render is input to painted frame, reported as p50 and p95 over samples. Both are measured on named machines by a pinned harness command; both are compared only against the previous run on the same machine.</p>
</section>
${sections}
${pendingSection}`,
  });
}

/**
 * @param {string} benchmark
 * @param {Map<string, {benchmark: string, machine: Record<string, any>, runs: any[]}>} series
 */
function renderBenchmarkSection(benchmark, series) {
  const head = headline(series, benchmark);
  const entries = latestPerSeries(series).filter((entry) => entry.benchmark === benchmark);

  const stat = head
    ? `<div class="stat">
  <p class="stat-label">Best measured ${esc(BENCHMARK_LABELS[benchmark].toLowerCase())} (p50)</p>
  <p class="stat-value">${esc(fmtMs(head.value))}</p>
  <p class="stat-sub">${esc(head.metric)} on ${esc(head.series.machine.id)} · ${esc(fmtDate(head.series.latest.finishedAt))}</p>
</div>`
    : `<div class="stat stat-empty">
  <p class="stat-label">${esc(BENCHMARK_LABELS[benchmark])}</p>
  <p class="stat-value stat-value-empty">not yet measured</p>
  <p class="stat-sub">No merged PR has been measured for this benchmark.</p>
</div>`;

  const machines =
    entries.length === 0
      ? `<p class="empty-note">No machine has reported this benchmark from a merged PR yet.</p>`
      : entries.map((entry) => renderSeriesCard(entry)).join("\n");

  return `<section class="benchmark" id="${esc(benchmark)}">
  <div class="benchmark-head">
    <div>
      <h2>${esc(BENCHMARK_LABELS[benchmark])}</h2>
      <p class="muted">${esc(BENCHMARK_DESCRIPTIONS[benchmark])}</p>
    </div>
    ${stat}
  </div>
  ${machines}
</section>`;
}

/**
 * @param {{benchmark: string, machine: Record<string, any>, runs: any[], latest: any}} entry
 */
function renderSeriesCard(entry) {
  const metricName = primaryMetricName(entry.latest);
  if (!metricName) return "";
  const first = entry.runs[0];
  const firstValue = first.metrics[metricName]?.p50 ?? null;

  const rows = [...entry.runs]
    .reverse()
    .map((run) => {
      const metric = run.metrics[metricName];
      const delta = run.delta?.[metricName];
      const p50Pct = delta?.p50Pct ?? null;
      const direction = deltaDirection(p50Pct);
      const prUrl = safeHref(run.pr?.url);
      return `<tr>
  <td>${esc(fmtDate(run.finishedAt))}</td>
  <td>${
    prUrl
      ? `<a href="${esc(prUrl)}" rel="noopener noreferrer">#${esc(run.pr.number)}</a>`
      : `<span class="muted">—</span>`
  }</td>
  <td><code title="${esc(run.commit.sha)}">${esc(run.commit.sha.slice(0, 7))}</code></td>
  <td class="num">${esc(fmtMs(metric.p50))}</td>
  <td class="num">${esc(fmtMs(metric.p95))}</td>
  <td class="num">${esc(metric.samples)}</td>
  <td class="num ${cx("delta", `delta-${direction}`)}">${esc(fmtPct(p50Pct))} <span class="delta-abs">${esc(fmtDeltaMs(delta?.p50Ms ?? null))}</span></td>
  <td>${esc(run.versions.ohMyPi)}</td>
</tr>`;
    })
    .join("\n");

  return `<article class="card">
  <div class="card-head">
    <div>
      <h3>${esc(entry.machine.id)}</h3>
      <p class="muted">${esc(machineFingerprint(entry.machine))}</p>
    </div>
    ${sparkBar(firstValue, entry.latest.metrics[metricName]?.p50 ?? null)}
  </div>
  <figure class="chart-figure">
    ${historyChart({ points: entry.runs, metricName, title: `${BENCHMARK_LABELS[entry.benchmark]} ${metricName} on ${entry.machine.id}` })}
    ${chartLegend()}
  </figure>
  <div class="table-scroll">
  <table>
    <caption class="visually-hidden">${esc(BENCHMARK_LABELS[entry.benchmark])} ${esc(metricName)} history on ${esc(entry.machine.id)}, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Date</th>
        <th scope="col">PR</th>
        <th scope="col">Commit</th>
        <th scope="col" class="num">p50</th>
        <th scope="col" class="num">p95</th>
        <th scope="col" class="num">Samples</th>
        <th scope="col" class="num">Δ p50</th>
        <th scope="col">Version</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  </div>
  <p class="provenance">Harness ${esc(entry.latest.harness.version)} · <code>${esc(entry.latest.harness.command)}</code> · ${esc(entry.latest.versions.runtime)} ${esc(entry.latest.versions.runtimeVersion)} · run <code>${esc(entry.latest.runId)}</code></p>
</article>`;
}

/**
 * @param {Record<string, any>[]} runs
 * @param {{caption: string, showDelta: boolean, emptyNote: string | null}} options
 */
function runsTable(runs, { caption, showDelta, emptyNote }) {
  if (runs.length === 0) {
    return emptyNote ? `<p class="empty-note">${esc(emptyNote)}</p>` : "";
  }
  const rows = runs
    .slice()
    .reverse()
    .map((run) => {
      const metricName = primaryMetricName(run);
      const metric = metricName ? run.metrics[metricName] : null;
      const delta = metricName ? run.delta?.[metricName] : null;
      const p50Pct = delta?.p50Pct ?? null;
      const prUrl = safeHref(run.pr?.url);
      return `<tr>
  <td>${esc(fmtDate(run.finishedAt))}</td>
  <td>${prUrl ? `<a href="${esc(prUrl)}" rel="noopener noreferrer">#${esc(run.pr.number)}</a>` : `<span class="muted">—</span>`}</td>
  <td><code title="${esc(run.commit.sha)}">${esc(run.commit.sha.slice(0, 7))}</code></td>
  <td class="num">${esc(fmtMs(metric?.p50 ?? null))}</td>
  <td class="num">${esc(fmtMs(metric?.p95 ?? null))}</td>
  <td class="num">${esc(metric?.samples ?? "—")}</td>
  ${showDelta ? `<td class="num ${cx("delta", `delta-${deltaDirection(p50Pct)}`)}">${esc(fmtPct(p50Pct))}</td>` : ""}
</tr>`;
    })
    .join("\n");

  return `<div class="table-scroll">
<table>
  <caption>${esc(caption)}</caption>
  <thead>
    <tr>
      <th scope="col">Date</th>
      <th scope="col">PR</th>
      <th scope="col">Commit</th>
      <th scope="col" class="num">p50</th>
      <th scope="col" class="num">p95</th>
      <th scope="col" class="num">Samples</th>
      ${showDelta ? '<th scope="col" class="num">Δ p50</th>' : ""}
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
}

/**
 * The graceful-degradation path: a first visit before any benchmark has run.
 * @param {{runs: Record<string, any>[], title: string, body: string, meta: {sourceRepo: string}}} options
 */
export function emptyState({ runs, title, body, meta }) {
  const pending = runs.filter((run) => !run.publishable);
  const pendingTable = pending.length > 0
    ? `<div class="table-scroll">
<table>
  <caption>Measured, but not yet on a merged PR</caption>
  <thead><tr><th scope="col">Date</th><th scope="col">Benchmark</th><th scope="col">Machine</th><th scope="col" class="num">p50</th><th scope="col" class="num">p95</th></tr></thead>
  <tbody>
  ${sortRuns(pending)
    .reverse()
    .map((run) => {
      const metricName = primaryMetricName(run);
      const metric = metricName ? run.metrics[metricName] : null;
      return `<tr>
  <td>${esc(fmtDate(run.finishedAt))}</td>
  <td>${esc(BENCHMARK_LABELS[run.benchmark] ?? run.benchmark)}</td>
  <td>${esc(run.machine.id)}</td>
  <td class="num">${esc(fmtMs(metric?.p50 ?? null))}</td>
  <td class="num">${esc(fmtMs(metric?.p95 ?? null))}</td>
</tr>`;
    })
    .join("\n")}
  </tbody>
</table>
</div>`
    : "";

  return `<section class="card empty">
  <h2>${esc(title)}</h2>
  <p>${esc(body)}</p>
  <ol class="steps">
    <li>Run the harness in the oh-my-pi fork at the commit you want to measure.</li>
    <li>Merge the improvement as a pull request, and record the PR number in the result file.</li>
    <li>Import the result file here — <code>npm run import-result -- --file &lt;result.json&gt;</code> — and open a pull request.</li>
    <li>CI builds this site and publishes it to GitHub Pages.</li>
  </ol>
  <p class="muted">Result files live in <code>data/results/</code> and are validated at build time. A file that is malformed, unprovenanced, or marked synthetic fails the build instead of rendering. See <a href="${esc(safeHref(meta.sourceRepo) ?? "#")}">the harness repository</a> for the measurement definitions and the harness command.</p>
  ${pendingTable}
</section>`;
}

/**
 * @param {object} options
 * @param {import('./results.mjs').buildChangelog extends (...a: any) => infer R ? R : never} options.changelog
 * @param {{generatedAt: string, sourceRepo: string, runCount: number, publishableCount: number}} options.meta
 */
export function renderChangelog({ changelog, meta, preview = false }) {
  if (changelog.length === 0) {
    return layout({
      title: "oh-my-pi changelog",
      active: "changelog",
      preview,
      meta: { ...meta, runCount: meta.runCount ?? 0, publishableCount: 0, skippedCount: meta.runCount ?? 0 },
      body: `<section class="intro"><p class="lede">Every merged improvement that was measured, newest first, with the delta the measurement showed.</p></section>` +
        emptyState({
          runs: [],
          title: "No merged improvement has been measured yet",
          body: "This changelog is generated from measurement files, not written by hand, so an entry only exists once a merged pull request has a before-and-after number on a named machine. Nothing is listed here that the harness did not measure.",
          meta,
        }),
    });
  }

  const entries = changelog
    .map((entry) => {
      const prUrl = safeHref(entry.pr.url);
      const rows = entry.measurements
        .map((m) => {
          const direction = deltaDirection(m.delta?.p50Pct ?? null);
          return `<tr>
  <td>${esc(BENCHMARK_LABELS[m.benchmark] ?? m.benchmark)}</td>
  <td class="num">${esc(fmtMs(m.p50))}${m.delta?.p50Ms !== null && m.delta?.p50Ms !== undefined ? ` <span class="delta-abs">(${esc(fmtDeltaMs(m.delta.p50Ms))})</span>` : ""}</td>
  <td class="num ${cx("delta", `delta-${direction}`)}">${esc(fmtPct(m.delta?.p50Pct ?? null))}</td>
  <td class="num">${esc(fmtMs(m.p95))}${m.delta?.p95Ms !== null && m.delta?.p95Ms !== undefined ? ` <span class="delta-abs">(${esc(fmtDeltaMs(m.delta.p95Ms))})</span>` : ""}</td>
  <td class="num">${esc(m.samples)}</td>
  <td>${esc(m.machineId)}</td>
</tr>`;
        })
        .join("\n");

      return `<article class="entry">
  <div class="entry-head">
    <h2>${prUrl ? `<a href="${esc(prUrl)}" rel="noopener noreferrer">${esc(entry.pr.title)}</a>` : esc(entry.pr.title)}</h2>
    <p class="entry-meta">
      ${prUrl ? `<a href="${esc(prUrl)}" rel="noopener noreferrer">#${esc(entry.pr.number)}</a> · ` : `#${esc(entry.pr.number)} · `}
      merged ${esc(fmtDate(entry.pr.mergedAt))} · measured ${esc(fmtDateTime(entry.finishedAt))} ·
      commit <code><a href="https://github.com/${esc(entry.commit.repo)}/commit/${esc(entry.commit.sha)}" rel="noopener noreferrer">${esc(entry.commit.sha.slice(0, 7))}</a></code>
    </p>
  </div>
  ${
    entry.commit.message
      ? `<p class="entry-message">${esc(firstLine(entry.commit.message))}</p>`
      : ""
  }
  <div class="table-scroll">
  <table>
    <caption class="visually-hidden">Measured effect of this merge</caption>
    <thead><tr><th scope="col">Benchmark</th><th scope="col" class="num">p50</th><th scope="col" class="num">Δ p50</th><th scope="col" class="num">p95</th><th scope="col" class="num">Samples</th><th scope="col">Machine</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</article>`;
    })
    .join("\n");

  return layout({
    title: "oh-my-pi changelog",
    active: "changelog",
    preview,
    meta: { ...meta, runCount: meta.runCount ?? 0, publishableCount: changelog.length, skippedCount: 0 },
    body: `<section class="intro"><p class="lede">Every merged improvement that was measured, newest first, with the delta the measurement showed. Entries are generated from result files; a change with no measurement does not appear.</p></section>
${entries}`,
  });
}

function firstLine(message) {
  const line = String(message).split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "").replace(/^[\s#*-]+/, "").trim();
}

/** GitHub Pages serves this for unknown paths, so it uses the configured base path. */
export function render404({ basePath }) {
  const asset = `${basePath.replace(/\/$/, "")}/assets/styles.css`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · oh-my-pi leaderboard</title>
<link rel="stylesheet" href="${esc(asset)}">
</head>
<body>
<main class="wrap">
  <section class="card empty">
    <h1>Not found</h1>
    <p>That path is not part of the leaderboard. The two pages are:</p>
    <ul>
      <li><a href="${esc(basePath)}">Leaderboard</a></li>
      <li><a href="${esc(`${basePath.replace(/\/$/, "")}/changelog.html`)}">Changelog</a></li>
    </ul>
  </section>
</main>
</body>
</html>
`;
}
