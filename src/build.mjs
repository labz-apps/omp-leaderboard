#!/usr/bin/env node
/**
 * Build the static leaderboard.
 *
 * Zero dependencies on purpose: the deploy path must work on a stock GitHub
 * Actions runner with `npm ci` unable to fail, and the output must be plain
 * files that any static host can serve.
 *
 * Usage:
 *   node src/build.mjs [--out dist] [--results data/results] [--base /] [--source-repo URL]
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildChangelog, loadResults } from "./results.mjs";
import { assertNoIntegrityConflicts, buildSeries, comparableRuns, findIntegrityConflicts } from "./deltas.mjs";
import { render404, renderChangelog, renderIndex } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[token.slice(2)] = "true";
    } else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

/** Normalize a base path to the form `/` or `/repo/`. */
export function normalizeBase(input) {
  if (!input || input === "/" || input === "true") return "/";
  let value = String(input).trim();
  if (!value.startsWith("/")) value = `/${value}`;
  if (!value.endsWith("/")) value = `${value}/`;
  return value.replace(/\/{2,}/g, "/");
}

/** Deterministic timestamp so repeated builds of the same data are identical. */
export function resolveGeneratedAt(args, env) {
  if (typeof args["generated-at"] === "string") return new Date(args["generated-at"]).toISOString();
  if (env.SOURCE_DATE_EPOCH) return new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  return new Date().toISOString();
}

export async function build(options = {}) {
  const {
    outDir = join(repoRoot, "dist"),
    resultsDir = join(repoRoot, "data", "results"),
    basePath = "/",
    sourceRepo = "https://github.com/labz-apps/oh-my-pi/tree/main",
    generatedAt = new Date().toISOString(),
    preview = false,
  } = options;

  const { runs, skipped, errors } = await loadResults(resultsDir);

  if (errors.length > 0) {
    const details = errors.map((error) => `  ${error.message}`).join("\n");
    throw new Error(`${errors.length} result file(s) failed validation:\n${details}`);
  }

  // Cross-file integrity: an overlapping pair of runs of one benchmark on one
  // machine id cannot be rendered as a comparison, so the build refuses.
  assertNoIntegrityConflicts(runs);
  const { notes: integrityNotes } = findIntegrityConflicts(runs);

  // Deltas are attached here, before rendering, so every consumer (leaderboard
  // rows, charts, changelog) reads the same computed numbers. Only runs that
  // are on a merged PR and had the machine to themselves are eligible.
  const comparable = comparableRuns(runs);
  const series = buildSeries(comparable);
  const changelog = buildChangelog(comparable);

  const meta = { generatedAt, sourceRepo, runCount: runs.length, preview, integrityNotes };

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "assets"), { recursive: true });
  await mkdir(join(outDir, "data"), { recursive: true });

  await writeFile(
    join(outDir, "index.html"),
    renderIndex({ runs, meta, preview }),
    "utf8",
  );
  await writeFile(join(outDir, "changelog.html"), renderChangelog({ changelog, meta, preview }), "utf8");
  await writeFile(join(outDir, "404.html"), render404({ basePath }), "utf8");

  // Machine-readable mirror of everything on the page, for anyone who wants to
  // diff results without scraping HTML.
  await writeFile(
    join(outDir, "data", "leaderboard.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt,
        sourceRepo,
        basePath,
        preview,
        runs: runs.map((run) => ({
          id: run.id,
          benchmark: run.benchmark,
          runId: run.runId,
          publishable: run.publishable,
          contended: run.contended === true,
          comparable: run.comparable === true,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          commit: run.commit,
          pr: run.pr,
          machine: run.machine,
          versions: run.versions,
          harness: run.harness,
          metrics: run.metrics,
          delta: run.delta ?? null,
        })),
        series: [...series.entries()].map(([key, entry]) => ({
          key,
          benchmark: entry.benchmark,
          machine: entry.machine,
          build: entry.build,
          runIds: entry.runs.map((run) => run.id),
        })),
        integrityNotes: integrityNotes.map((note) => ({ kind: note.kind, message: note.message, runIds: note.runIds })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await cp(join(here, "assets"), join(outDir, "assets"), { recursive: true });
  await writeFile(join(outDir, ".nojekyll"), "", "utf8");

  return {
    outDir,
    runCount: runs.length,
    publishableCount: comparable.length,
    changelogEntries: changelog.length,
    seriesCount: series.size,
    integrityNotes,
    skipped,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = resolveGeneratedAt(args, process.env);
  try {
    const summary = await build({
      outDir: resolve(repoRoot, typeof args.out === "string" ? args.out : "dist"),
      resultsDir: resolve(repoRoot, typeof args.results === "string" ? args.results : "data/results"),
      basePath: normalizeBase(typeof args.base === "string" ? args.base : "/"),
      sourceRepo: typeof args["source-repo"] === "string" ? args["source-repo"] : "https://github.com/labz-apps/oh-my-pi/tree/main",
      generatedAt,
      preview: args.preview === "true",
    });
    const skippedNote = summary.skipped.length > 0 ? `, ${summary.skipped.length} not yet on a merged PR` : "";
    const previewNote = args.preview === "true" ? " [PREVIEW: fixture data, banner shown on every page]" : "";
    process.stdout.write(
      `built ${summary.outDir}: ${summary.publishableCount} leaderboard row(s)${skippedNote}, ${summary.changelogEntries} changelog entr(ies)${previewNote}\n`,
    );
  } catch (error) {
    process.stderr.write(`build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
