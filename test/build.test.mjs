import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../src/build.mjs";
import { buildChangelog } from "../src/results.mjs";
import { buildSeries } from "../src/deltas.mjs";
import { BUILD_TYPE_LIST } from "../src/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const fixturesDir = join(here, "fixtures", "results");
const outDir = join(repoRoot, ".verify", "test-dist");

async function buildFixtures() {
  return build({
    outDir,
    resultsDir: fixturesDir,
    basePath: "/omp-leaderboard/",
    sourceRepo: "https://github.com/labz-apps/oh-my-pi/tree/main",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("build writes a complete static site", async () => {
  const summary = await buildFixtures();
  assert.equal(summary.publishableCount, 5);
  assert.equal(summary.changelogEntries, 5);
  assert.equal(summary.runCount, 7, "the unmerged and contended runs are loaded but not publishable");
  assert.equal(summary.seriesCount, 3, "one series per benchmark and build type");
  const index = await readFile(join(outDir, "index.html"), "utf8");
  const changelog = await readFile(join(outDir, "changelog.html"), "utf8");
  assert.match(index, /Leaderboard/);
  assert.match(index, /Cold start/);
  assert.match(index, /Time to render/);
  assert.match(changelog, /Changelog/);
});

test("leaderboard renders one row per merged PR with its provenance", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(index, /href="https:\/\/github\.com\/labz-apps\/oh-my-pi\/pull\/42"/);
  assert.match(index, /href="https:\/\/github\.com\/labz-apps\/oh-my-pi\/pull\/57"/);
  assert.match(index, /href="https:\/\/github\.com\/labz-apps\/oh-my-pi\/pull\/61"/);
  assert.match(index, /href="https:\/\/github\.com\/labz-apps\/oh-my-pi\/pull\/74"/);
  // Short shas, so a row points at the exact commit that was measured.
  assert.match(index, /1111111/);
  assert.match(index, /2222222/);
});

test("machine and version provenance are visible", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(index, /fixture-linux-x86/);
  assert.match(index, /AMD EPYC 7B12 \(fixture\)/);
  assert.match(index, /18\.4\.11/);
  assert.match(index, /bun 1\.2\.21/);
});

test("the unmerged run is shown but not counted as a leaderboard row", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(index, /Awaiting merge/);
  assert.match(index, /5555555/, "the pending run is displayed in its own section");
});

test("changelog is newest first and names the PR", async () => {
  await buildFixtures();
  const changelog = await readFile(join(outDir, "changelog.html"), "utf8");
  const order = ["#74", "#61", "#57", "#42"].map((needle) => changelog.indexOf(needle));
  for (const index of order) assert.ok(index >= 0, "missing changelog entry");
  const sorted = [...order].sort((a, b) => a - b);
  assert.deepEqual(order, sorted, "changelog entries are not newest first");
});

test("changelog shows a measured delta, not a claim", async () => {
  await buildFixtures();
  const changelog = await readFile(join(outDir, "changelog.html"), "utf8");
  assert.match(changelog, /delta-better/);
  assert.match(changelog, /\(−368 ms\)/);
});

test("leaderboard JSON mirrors the page and records the base path", async () => {
  await buildFixtures();
  const json = JSON.parse(await readFile(join(outDir, "data", "leaderboard.json"), "utf8"));
  assert.equal(json.basePath, "/omp-leaderboard/");
  assert.equal(json.runs.filter((run) => run.publishable).length, 6);
  for (const run of json.runs) {
    assert.ok(run.id);
    assert.ok(Number.isFinite(run.metrics.firstInteractiveFrameMs?.p50 ?? run.metrics.inputToPaintMs?.p50));
  }
});

test("every published row records a build type and an uncontended machine", async () => {
  await buildFixtures();
  const json = JSON.parse(await readFile(join(outDir, "data", "leaderboard.json"), "utf8"));
  const published = json.runs.filter((run) => run.comparable);
  assert.ok(published.length > 0);
  for (const run of published) {
    assert.ok(BUILD_TYPE_LIST.includes(run.harness.build), `${run.runId} has no recorded build type`);
    assert.equal(run.machine.concurrentRuns, 1, `${run.runId} was measured on a contended machine`);
    assert.equal(
      run.commit.shaAtFinish,
      run.commit.sha,
      `${run.runId} does not prove the tree was still on one commit when it finished`,
    );
  }
});

test("a build type change splits the series instead of folding it in", async () => {
  await buildFixtures();
  const json = JSON.parse(await readFile(join(outDir, "data", "leaderboard.json"), "utf8"));
  const coldStart = json.series.filter((entry) => entry.benchmark === "cold-start");
  assert.deepEqual(
    coldStart.map((entry) => entry.build).sort(),
    ["binary", "source"],
    "a source run and a binary run shared a series",
  );
  const binaryRun = json.runs.find((run) => run.harness.build === "binary");
  assert.equal(
    binaryRun.delta.firstInteractiveFrameMs.p50Pct,
    null,
    "the first run of a new build series must have no delta",
  );
  const sourceRun = json.runs.find((run) => run.runId === "fixture-cold-start-run-2");
  assert.equal(
    sourceRun.delta.firstInteractiveFrameMs.baselineP50,
    json.runs.find((run) => run.runId === "fixture-cold-start-run-1").metrics.firstInteractiveFrameMs.p50,
    "a source run was compared against a binary run",
  );
});

test("a machine that changed build type says so on the page", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(index, /Series integrity/);
  assert.match(index, /no delta crosses a build type/);
  assert.match(index, /source run/);
  assert.match(index, /compiled binary/);
  assert.match(index, /no delta on this page crosses a build type/);
});

test("a contended run is recorded as evidence and never published", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  const changelog = await readFile(join(outDir, "changelog.html"), "utf8");
  assert.match(index, /Recorded, not published/);
  assert.match(index, /6666666/, "the contended run should still be visible as evidence");
  assert.match(index, /concurrentRuns/);

  const json = JSON.parse(await readFile(join(outDir, "data", "leaderboard.json"), "utf8"));
  const contended = json.runs.find((run) => run.contended);
  assert.equal(contended.publishable, true);
  assert.equal(contended.comparable, false);
  assert.equal(contended.delta, null, "a contended run must not be a baseline");
  const seriesRunIds = json.series.flatMap((entry) => entry.runIds);
  assert.ok(!seriesRunIds.includes(contended.id), "a contended run entered a series");
  // The pull request that owns the contended run has no other measurement, so
  // it must not appear in the changelog either: no entry means no measured delta.
  assert.doesNotMatch(changelog, /pull\/81/);
});

test("two overlapping runs of one benchmark on one machine fail the build", async () => {
  const dir = join(repoRoot, ".verify", "overlap-results");
  await mkdir(dir, { recursive: true });
  const a = JSON.parse(await readFile(join(fixturesDir, "cold-start-merged-pr-42.json"), "utf8"));
  const b = JSON.parse(await readFile(join(fixturesDir, "cold-start-merged-pr-57.json"), "utf8"));
  b.startedAt = "2026-01-05T09:02:00.000Z";
  b.finishedAt = "2026-01-05T09:07:31.000Z";
  await writeFile(join(dir, "a.json"), JSON.stringify(a), "utf8");
  await writeFile(join(dir, "b.json"), JSON.stringify(b), "utf8");
  await assert.rejects(
    () => build({ outDir: join(repoRoot, ".verify", "overlap-dist"), resultsDir: dir, basePath: "/" }),
    /run-integrity conflict/,
  );
});

test("two different programs measured at once on one machine id fail the build", async () => {
  const dir = join(repoRoot, ".verify", "mixed-overlap-results");
  await mkdir(dir, { recursive: true });
  const a = JSON.parse(await readFile(join(fixturesDir, "cold-start-merged-pr-42.json"), "utf8"));
  const b = JSON.parse(await readFile(join(fixturesDir, "cold-start-binary.json"), "utf8"));
  b.startedAt = "2026-01-05T09:02:00.000Z";
  b.finishedAt = "2026-01-05T09:07:48.000Z";
  await writeFile(join(dir, "a.json"), JSON.stringify(a), "utf8");
  await writeFile(join(dir, "b.json"), JSON.stringify(b), "utf8");
  await assert.rejects(
    () => build({ outDir: join(repoRoot, ".verify", "mixed-overlap-dist"), resultsDir: dir, basePath: "/" }),
    /two different programs were measured at the same time/,
  );
});

test("a run whose working tree moved during the measurement fails the build", async () => {
  const dir = join(repoRoot, ".verify", "moved-tree-results");
  await mkdir(dir, { recursive: true });
  const base = JSON.parse(await readFile(join(fixturesDir, "cold-start-merged-pr-42.json"), "utf8"));
  base.commit.shaAtFinish = "9999999999999999999999999999999999999999";
  await writeFile(join(dir, "moved.json"), JSON.stringify(base), "utf8");
  await assert.rejects(
    () => build({ outDir: join(repoRoot, ".verify", "moved-tree-dist"), resultsDir: dir, basePath: "/" }),
    /shaAtFinish/,
  );
});

test("a result file with no build type fails the build", async () => {
  const dir = join(repoRoot, ".verify", "no-build-results");
  await mkdir(dir, { recursive: true });
  const base = JSON.parse(await readFile(join(fixturesDir, "cold-start-merged-pr-42.json"), "utf8"));
  delete base.harness.build;
  await writeFile(join(dir, "no-build.json"), JSON.stringify(base), "utf8");
  await assert.rejects(
    () => build({ outDir: join(repoRoot, ".verify", "no-build-dist"), resultsDir: dir, basePath: "/" }),
    /harness\.build/,
  );
});

test("charts render as inline SVG with an accessible label", async () => {
  await buildFixtures();
  const index = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(index, /<svg class="chart"/);
  assert.match(index, /role="img"/);
  assert.match(index, /chart-line-p50/);
  assert.match(index, /chart-line-p95/);
});

test("changelog collapses repeat measurements of one PR into one entry", async () => {
  const names = ["cold-start-merged-pr-42.json", "cold-start-merged-pr-57.json", "time-to-render-merged-pr-61.json", "time-to-render-merged-pr-74.json"];
  const runs = [];
  for (const name of names) {
    runs.push({ ...JSON.parse(await readFile(join(fixturesDir, name), "utf8")), publishable: true });
  }
  buildSeries(runs);
  const changelog = buildChangelog(runs);
  const prNumbers = changelog.map((entry) => entry.pr.number);
  assert.equal(new Set(prNumbers).size, prNumbers.length, "a PR produced more than one changelog entry");
  assert.equal(changelog.length, 4);
});

test("build output is deterministic for identical input", async () => {
  const options = {
    resultsDir: fixturesDir,
    basePath: "/omp-leaderboard/",
    sourceRepo: "https://github.com/labz-apps/oh-my-pi/tree/main",
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  await build({ ...options, outDir: join(repoRoot, ".verify", "det-a") });
  await build({ ...options, outDir: join(repoRoot, ".verify", "det-b") });
  const a = await readFile(join(repoRoot, ".verify", "det-a", "index.html"), "utf8");
  const b = await readFile(join(repoRoot, ".verify", "det-b", "index.html"), "utf8");
  assert.equal(a, b);
});

test("the real build refuses a bad result file instead of skipping it", async () => {
  await assert.rejects(
    () =>
      build({
        outDir: join(repoRoot, ".verify", "bad-dist"),
        resultsDir: join(here, "fixtures", "broken"),
        basePath: "/",
      }),
    /failed validation/,
  );
});
