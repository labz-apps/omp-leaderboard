/**
 * Result discovery and validation.
 *
 * `data/results/` is the only source of numbers the site will render. Files
 * are validated on every build; a bad file is a build failure rather than a
 * silently missing row.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ValidationError, isPublishableRun, resultId, shortSha } from "./schema.mjs";
import { sortRuns } from "./deltas.mjs";

/**
 * @param {string} resultsDir
 * @returns {Promise<{runs: Record<string, any>[], skipped: {file: string, reason: string}[], errors: ValidationError[]}>}
 */
export async function loadResults(resultsDir) {
  let files;
  try {
    files = await readdir(resultsDir);
  } catch (error) {
    if (error.code === "ENOENT") return { runs: [], skipped: [], errors: [] };
    throw error;
  }

  /** @type {Record<string, any>[]} */
  const runs = [];
  /** @type {{file: string, reason: string}[]} */
  const skipped = [];
  /** @type {ValidationError[]} */
  const errors = [];

  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const path = join(resultsDir, file);
    const raw = await readFile(path, "utf8");
    /** @type {unknown} */
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      errors.push(new ValidationError(file, [`not valid JSON: ${error.message}`]));
      continue;
    }

    const { validateResultDoc } = await import("./schema.mjs");
    const result = validateResultDoc(doc, file);
    if (!result.ok) {
      errors.push(new ValidationError(file, result.problems));
      continue;
    }

    const doc_ = result.doc;
    doc_.sourceFile = file;
    doc_.id = resultId(doc_);
    doc_.publishable = isPublishableRun(doc_);
    if (!doc_.publishable) {
      skipped.push({ file, reason: "no merged PR yet, so it cannot appear as a leaderboard row" });
    }
    runs.push(doc_);
  }

  // Stable ordering regardless of filesystem order.
  runs.sort((a, b) => {
    const delta = Date.parse(a.finishedAt) - Date.parse(b.finishedAt);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

  return { runs: sortRuns(runs).map((run) => ({ ...run, metrics: run.metrics })), skipped, errors };
}

/**
 * The merged-improvement history: newest first, one entry per merged PR.
 * This is the changelog the site renders, and it is derived purely from
 * provenanced runs rather than maintained by hand.
 *
 * @param {Record<string, any>[]} runs
 */
export function buildChangelog(runs) {
  const publishable = runs.filter((run) => run.publishable);

  // One entry per merged PR, keeping the newest measurement for each metric.
  /** @type {Map<number, any>} */
  const byPr = new Map();
  for (const run of publishable) {
    const number = run.pr.number;
    const existing = byPr.get(number);
    if (!existing) {
      byPr.set(number, {
        pr: run.pr,
        commit: run.commit,
        finishedAt: run.finishedAt,
        machine: run.machine,
        entries: [run],
      });
      continue;
    }
    existing.entries.push(run);
    if (Date.parse(run.finishedAt) > Date.parse(existing.finishedAt)) {
      existing.finishedAt = run.finishedAt;
      existing.commit = run.commit;
    }
  }

  return [...byPr.values()]
    .map((entry) => {
      const measurements = [];
      for (const run of entry.entries) {
        const metricName = pickMetric(run);
        if (!metricName) continue;
        const metric = run.metrics[metricName];
        const d = run.delta?.[metricName];
        measurements.push({
          benchmark: run.benchmark,
          metric: metricName,
          machineId: run.machine.id,
          machine: run.machine,
          p50: metric.p50,
          p95: metric.p95,
          samples: metric.samples,
          delta: d
            ? { p50Pct: d.p50Pct, p50Ms: d.p50Ms, p95Pct: d.p95Pct, p95Ms: d.p95Ms }
            : null,
        });
      }
      return {
        pr: entry.pr,
        commit: entry.commit,
        finishedAt: entry.finishedAt,
        machine: entry.machine,
        measurements: measurements.sort((a, b) => a.benchmark.localeCompare(b.benchmark)),
      };
    })
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
}

/**
 * @param {Record<string, any>} run
 */
function pickMetric(run) {
  const names = Object.keys(run.metrics ?? {}).sort();
  if (names.length === 0) return null;
  return names.find((name) => /first|total|latency|duration/i.test(name)) ?? names[0];
}

export { shortSha };
