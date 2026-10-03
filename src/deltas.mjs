/**
 * Comparability and delta computation.
 *
 * Two rules keep the numbers honest:
 *
 * 1. Runs are only ever compared to other runs of the same benchmark on the
 *    same machine. A delta across machines is meaningless (different CPUs,
 *    memory, thermal state), so the machine id is part of the comparison key
 *    and cross-machine series are rendered separately, never merged.
 * 2. Deltas are computed here, from two provenanced runs. They are never
 *    stored in, or hand-entered into, a result file.
 */

/**
 * @typedef {Object} ComparableRun
 * @property {string} benchmark
 * @property {string} runId
 * @property {string} finishedAt
 * @property {Record<string, any>} machine
 * @property {Record<string, any>} metrics
 */

/**
 * Series key: benchmark plus machine. Two runs share a key only when their
 * measurements are comparable.
 * @param {ComparableRun} run
 */
export function seriesKey(run) {
  return `${run.benchmark}::${run.machine.id}`;
}

/** Machine fingerprint, shown next to every series so a reader can sanity-check comparability. */
export function machineFingerprint(machine) {
  return [
    machine.cpuModel,
    `${machine.physicalCores}c`,
    `${machine.memoryGb}GB`,
    machine.os,
    machine.arch,
  ].join(" · ");
}

/**
 * Order runs the way the benchmark happened: by finish time, with runId as a
 * stable tiebreak so repeated builds produce byte-identical output.
 * @param {ComparableRun[]} runs
 */
export function sortRuns(runs) {
  return [...runs].sort((a, b) => {
    const delta = Date.parse(a.finishedAt) - Date.parse(b.finishedAt);
    if (delta !== 0) return delta;
    return a.runId.localeCompare(b.runId);
  });
}

/**
 * Build per-series histories with computed deltas.
 *
 * @param {ComparableRun[]} runs all runs, publishable or not
 * @returns {Map<string, {benchmark: string, machine: Record<string, any>, runs: any[]}>}
 */
export function buildSeries(runs) {
  /** @type {Map<string, {benchmark: string, machine: Record<string, any>, runs: any[]}>} */
  const series = new Map();

  for (const run of sortRuns(runs)) {
    const key = seriesKey(run);
    let entry = series.get(key);
    if (!entry) {
      entry = { benchmark: run.benchmark, machine: run.machine, runs: [] };
      series.set(key, entry);
    }
    entry.runs.push(run);
  }

  for (const entry of series.values()) {
    let previous = null;
    for (const run of entry.runs) {
      run.delta = computeDelta(previous, run);
      previous = run;
    }
  }

  return series;
}

/**
 * Percent change per metric, plus the absolute difference. `baseline` is the
 * immediately preceding run in the same series, which is the only comparison
 * the leaderboard claims.
 *
 * @param {ComparableRun | null} baseline
 * @param {ComparableRun} run
 */
export function computeDelta(baseline, run) {
  /** @type {Record<string, {baselineP50: number, p50: number, p50Pct: number, p50Ms: number, baselineP95: number, p95: number, p95Pct: number, p95Ms: number}>} */
  const delta = {};
  for (const [name, metric] of Object.entries(run.metrics)) {
    if (!baseline || !(name in baseline.metrics)) {
      delta[name] = {
        baselineP50: null,
        p50: metric.p50,
        p50Pct: null,
        p50Ms: null,
        baselineP95: null,
        p95: metric.p95,
        p95Pct: null,
        p95Ms: null,
      };
      continue;
    }
    const base = baseline.metrics[name];
    delta[name] = {
      baselineP50: base.p50,
      p50: metric.p50,
      p50Pct: percentChange(base.p50, metric.p50),
      p50Ms: round(metric.p50 - base.p50),
      baselineP95: base.p95,
      p95: metric.p95,
      p95Pct: percentChange(base.p95, metric.p95),
      p95Ms: round(metric.p95 - base.p95),
    };
  }
  return delta;
}

/**
 * Percent change from baseline to current. Negative means faster (this is a
 * latency benchmark, so improvement is a reduction).
 * @param {number} baseline
 * @param {number} current
 */
export function percentChange(baseline, current) {
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return null;
  if (baseline === 0) return null;
  return round(((current - baseline) / baseline) * 100, 2);
}

/** @param {number} value @param {number} [places] */
export function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Latest publishable run per series: the current best-known numbers per
 * machine. This is the actual leaderboard.
 *
 * @param {Map<string, {benchmark: string, machine: Record<string, any>, runs: any[]}>} series
 */
export function latestPerSeries(series) {
  return [...series.values()]
    .map((entry) => ({ ...entry, latest: entry.runs[entry.runs.length - 1] }))
    .filter((entry) => entry.latest)
    .sort((a, b) => {
      if (a.benchmark !== b.benchmark) return a.benchmark.localeCompare(b.benchmark);
      return String(a.machine.id).localeCompare(String(b.machine.id));
    });
}

/**
 * The single headline number for a benchmark: the p50 of the most recent run
 * on the fastest machine that has data, plus the machine it came from.
 *
 * @param {Map<string, {benchmark: string, machine: Record<string, any>, runs: any[]}>} series
 */
export function headline(series, benchmark) {
  const candidates = latestPerSeries(series).filter((entry) => entry.benchmark === benchmark);
  if (candidates.length === 0) return null;
  const metricName = primaryMetricName(candidates[0].latest);
  if (!metricName) return null;
  const best = candidates.reduce((acc, entry) =>
    entry.latest.metrics[metricName].p50 < acc.latest.metrics[metricName].p50 ? entry : acc,
  );
  return { series: best, metric: metricName, value: best.latest.metrics[metricName].p50 };
}

/**
 * A benchmark's headline metric name: the single time-to-first-event style
 * metric when present, else the alphabetically first metric so the site still
 * renders something coherent.
 * @param {Record<string, any>} run
 */
export function primaryMetricName(run) {
  const names = Object.keys(run?.metrics ?? {}).sort();
  if (names.length === 0) return null;
  const preferred = names.find((name) => /first|total|latency|duration|p50/i.test(name));
  return preferred ?? names[0];
}
