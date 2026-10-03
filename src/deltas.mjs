/**
 * Comparability and delta computation.
 *
 * Three rules keep the numbers honest:
 *
 * 1. Runs are only ever compared to other runs of the same benchmark, on the
 *    same machine, built the same way. A delta across machines is meaningless
 *    (different CPUs, memory, thermal state) and a delta across build types
 *    measures the packaging rather than the change, so both are part of the
 *    comparison key and cross-key series are rendered separately, never merged.
 * 2. A run that shared its machine with another run of the same benchmark is
 *    never published, and never becomes a baseline. Two numbers from two
 *    overlapping runs of one benchmark on one machine id are a contention
 *    artefact, not a comparison.
 * 3. Deltas are computed here, from two provenanced runs. They are never
 *    stored in, or hand-entered into, a result file.
 */

import { countsTowardSeries } from "./schema.mjs";

/**
 * @typedef {Object} ComparableRun
 * @property {string} benchmark
 * @property {string} runId
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {Record<string, any>} machine
 * @property {Record<string, any>} harness
 * @property {Record<string, any>} metrics
 */

/**
 * Series key: benchmark, machine, and build type. Two runs share a key only
 * when their measurements are comparable.
 * @param {ComparableRun} run
 */
export function seriesKey(run) {
  return `${run.benchmark}::${run.machine.id}::${buildType(run)}`;
}

/** The recorded build type, or `unknown` for a run that predates the field. */
export function buildType(run) {
  return typeof run?.harness?.build === "string" ? run.harness.build : "unknown";
}

/**
 * Runs that may be published and may serve as a baseline. Everything on the
 * site is rendered from this set, so the filter lives here rather than in each
 * consumer.
 * @param {ComparableRun[]} runs
 */
export function comparableRuns(runs) {
  return runs.filter((run) => countsTowardSeries(run));
}

/**
 * Two measurement windows overlap when each started before the other finished.
 * Timestamps are validated before this runs; an unparsable one is treated as no
 * overlap rather than as a conflict, because the schema check already reported
 * the real problem with that file.
 * @param {ComparableRun} a
 * @param {ComparableRun} b
 */
export function windowsOverlap(a, b) {
  const aStart = Date.parse(a?.startedAt ?? "");
  const aEnd = Date.parse(a?.finishedAt ?? "");
  const bStart = Date.parse(b?.startedAt ?? "");
  const bEnd = Date.parse(b?.finishedAt ?? "");
  if ([aStart, aEnd, bStart, bEnd].some((value) => !Number.isFinite(value))) return false;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * @typedef {Object} IntegrityConflict
 * @property {"concurrent-runs"|"mixed-build-concurrency"|"build-switch"} kind
 * @property {boolean} fatal
 * @property {string[]} runIds
 * @property {string} message
 */

/**
 * Cross-file integrity checks, over every run in the repository.
 *
 * These are the checks a single file cannot make about itself. A contended run
 * is only visible as a pair, and a series that quietly changes build type is
 * only visible as a set.
 *
 * Scoping note: overlap is checked per (benchmark, machine id), not per machine
 * id alone. `machine.id` is derived from OS, architecture, and core count, so
 * two different physical boxes can legitimately share an id; two runs of the
 * *same* benchmark on that id overlapping in time is the incoherent case the
 * contract forbids, while cross-benchmark contention is the harness's own
 * `machine.concurrentRuns` count to report.
 *
 * @param {ComparableRun[]} runs
 * @returns {{fatal: IntegrityConflict[], notes: IntegrityConflict[]}}
 */
export function findIntegrityConflicts(runs) {
  /** @type {IntegrityConflict[]} */
  const fatal = [];
  /** @type {IntegrityConflict[]} */
  const notes = [];
  const sorted = sortRuns(runs);

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.machine?.id !== b.machine?.id || a.benchmark !== b.benchmark) continue;
      if (!windowsOverlap(a, b)) continue;
      const mixed = buildType(a) !== buildType(b);
      fatal.push({
        kind: mixed ? "mixed-build-concurrency" : "concurrent-runs",
        fatal: true,
        runIds: [a.runId, b.runId],
        message: mixed
          ? `runs ${a.runId} (${buildType(a)} build) and ${b.runId} (${buildType(b)} build) both measured ${a.benchmark} on machine ${a.machine.id} between ${a.startedAt} and ${b.finishedAt}: two different programs were measured at the same time on one machine id, so neither number is comparable`
          : `runs ${a.runId} and ${b.runId} both measured ${a.benchmark} on machine ${a.machine.id} between ${a.startedAt} and ${b.finishedAt}: the runs overlapped, so each was measured on a contended machine; re-measure back to back`,
      });
    }
  }

  // A machine that changes build type is not an error, but the split has to be
  // visible: one note per benchmark per machine, listing the build types.
  /** @type {Map<string, {benchmark: string, machineId: string, builds: Set<string>, runIds: string[]}>} */
  const byMachine = new Map();
  for (const run of sorted) {
    const key = `${run.benchmark}::${run.machine?.id}`;
    let entry = byMachine.get(key);
    if (!entry) {
      entry = { benchmark: run.benchmark, machineId: run.machine?.id, builds: new Set(), runIds: [] };
      byMachine.set(key, entry);
    }
    entry.builds.add(buildType(run));
    entry.runIds.push(run.runId);
  }
  for (const entry of byMachine.values()) {
    if (entry.builds.size < 2) continue;
    notes.push({
      kind: "build-switch",
      fatal: false,
      runIds: entry.runIds,
      message: `machine ${entry.machineId} has ${entry.benchmark} runs from ${entry.builds.size} build types (${[...entry.builds].sort().join(", ")}): the history is split into separate series and no delta crosses a build type`,
    });
  }

  return { fatal, notes };
}

/**
 * Throwing variant used by the build. Fails closed: an overlapping pair is not
 * something the site can render around, because rendering it would publish a
 * delta computed from contention.
 * @param {ComparableRun[]} runs
 */
export function assertNoIntegrityConflicts(runs) {
  const { fatal } = findIntegrityConflicts(runs);
  if (fatal.length === 0) return;
  const details = fatal.map((conflict) => `  ${conflict.message}`).join("\n");
  throw new Error(
    `${fatal.length} run-integrity conflict(s); the build refuses to publish a comparison measured on a contended machine:\n${details}`,
  );
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
 * Callers pass runs that have already passed `comparableRuns`; this function
 * still groups by the full key, so a source run and a binary run on one machine
 * become two series with no delta between them rather than one series with a
 * meaningless one.
 *
 * @param {ComparableRun[]} runs all runs, publishable or not
 * @returns {Map<string, {benchmark: string, machine: Record<string, any>, build: string, runs: any[]}>}
 */
export function buildSeries(runs) {
  /** @type {Map<string, {benchmark: string, machine: Record<string, any>, build: string, runs: any[]}>} */
  const series = new Map();

  for (const run of sortRuns(runs)) {
    const key = seriesKey(run);
    let entry = series.get(key);
    if (!entry) {
      entry = { benchmark: run.benchmark, machine: run.machine, build: buildType(run), runs: [] };
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
      const byMachine = String(a.machine.id).localeCompare(String(b.machine.id));
      if (byMachine !== 0) return byMachine;
      return String(a.build).localeCompare(String(b.build));
    });
}

/**
 * The single headline number for a benchmark: the p50 of the most recent run
 * on the fastest machine that has data, plus the machine and build type it came
 * from. Comparability note: this is the fastest *recorded* build on the fastest
 * recorded machine, so the build type is carried with it rather than dropped.
 *
 * @param {Map<string, {benchmark: string, machine: Record<string, any>, build: string, runs: any[]}>} series
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
