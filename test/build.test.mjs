import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../src/build.mjs";
import { buildChangelog } from "../src/results.mjs";
import { buildSeries } from "../src/deltas.mjs";

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
  assert.equal(summary.publishableCount, 4);
  assert.equal(summary.changelogEntries, 4);
  assert.equal(summary.runCount, 5, "the unmerged run is loaded but not publishable");
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
  assert.equal(json.runs.filter((run) => run.publishable).length, 4);
  for (const run of json.runs) {
    assert.ok(run.id);
    assert.ok(Number.isFinite(run.metrics.firstInteractiveFrameMs?.p50 ?? run.metrics.inputToPaintMs?.p50));
  }
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
