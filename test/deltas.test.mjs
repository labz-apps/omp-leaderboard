import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSeries, computeDelta, headline, latestPerSeries, machineFingerprint, percentChange, seriesKey } from "../src/deltas.mjs";
import { deltaDirection, fmtDeltaMs, fmtMs, fmtPct, safeHref } from "../src/html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "results");

async function loadAll() {
  const names = ["cold-start-merged-pr-42.json", "cold-start-merged-pr-57.json", "time-to-render-merged-pr-61.json", "time-to-render-merged-pr-74.json", "cold-start-unmerged.json"];
  const runs = [];
  for (const name of names) {
    const doc = JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
    runs.push({ ...doc, id: name, publishable: doc.pr !== null && doc.pr !== undefined });
  }
  return runs;
}

test("percent change is signed and baseline-relative", () => {
  assert.equal(percentChange(100, 50), -50);
  assert.equal(percentChange(100, 150), 50);
  assert.equal(percentChange(100, 100), 0);
  assert.equal(percentChange(0, 10), null);
});

test("a zero-baseline series yields no percent, not Infinity", () => {
  const delta = computeDelta(null, {
    metrics: { m: { unit: "ms", p50: 5, p95: 9, samples: 1 } },
    machine: { id: "a" },
    benchmark: BENCH,
  });
  assert.equal(delta.m.p50Pct, null);
});

const BENCH = "cold-start";

test("delta compares against the immediately preceding run", () => {
  const before = { metrics: { m: { unit: "ms", p50: 1000, p95: 1500, samples: 20 } }, machine: { id: "a" }, benchmark: BENCH };
  const after = { metrics: { m: { unit: "ms", p50: 500, p95: 900, samples: 20 } }, machine: { id: "a" }, benchmark: BENCH };
  const delta = computeDelta(before, after);
  assert.equal(delta.m.p50, 500);
  assert.equal(delta.m.p50Pct, -50);
  assert.equal(delta.m.p50Ms, -500);
  assert.equal(delta.m.p95Pct, -40);
  assert.equal(delta.m.p95Ms, -600);
});

test("first run in a series has no delta", async () => {
  const runs = (await loadAll()).filter((run) => run.publishable);
  const series = buildSeries(runs);
  const coldStart = [...series.values()].find((entry) => entry.benchmark === BENCH);
  const first = coldStart.runs[0];
  assert.equal(first.delta.firstInteractiveFrameMs.p50Pct, null);
  assert.equal(first.delta.firstInteractiveFrameMs.baselineP50, null);
});

test("improvement renders as a negative delta", async () => {
  const runs = (await loadAll()).filter((run) => run.publishable);
  const series = buildSeries(runs);
  const coldStart = [...series.values()].find((entry) => entry.benchmark === BENCH);
  const second = coldStart.runs[1];
  assert.equal(second.commit.sha.slice(0, 7), "2222222");
  assert.ok(second.delta.firstInteractiveFrameMs.p50Pct < 0);
  assert.equal(deltaDirection(second.delta.firstInteractiveFrameMs.p50Pct), "better");
});

test("runs never share a series across machines", async () => {
  const runs = (await loadAll()).filter((run) => run.publishable);
  const other = { ...runs[0], machine: { ...runs[0].machine, id: "fixture-mac-arm" } };
  const series = buildSeries([...runs, other]);
  const keys = [...series.keys()];
  assert.ok(keys.includes(`${BENCH}::fixture-linux-x86`));
  assert.ok(keys.includes(`${BENCH}::fixture-mac-arm`));
  // The copy on the other machine is its own baseline, so it must have no delta.
  const macSeries = series.get(`${BENCH}::fixture-mac-arm`);
  assert.equal(macSeries.runs[0].delta.firstInteractiveFrameMs.p50Pct, null);
});

test("a regression is reported as a positive delta and labelled worse", () => {
  const before = { metrics: { m: { unit: "ms", p50: 100, p95: 120, samples: 5 } }, machine: { id: "a" }, benchmark: BENCH };
  const after = { metrics: { m: { unit: "ms", p50: 140, p95: 200, samples: 5 } }, machine: { id: "a" }, benchmark: BENCH };
  const delta = computeDelta(before, after);
  assert.equal(delta.m.p50Pct, 40);
  assert.equal(deltaDirection(delta.m.p50Pct), "worse");
});

test("series ordering is chronological and stable", async () => {
  const runs = (await loadAll()).filter((run) => run.publishable);
  const series = buildSeries(runs);
  const coldStart = [...series.values()].find((entry) => entry.benchmark === BENCH);
  const times = coldStart.runs.map((run) => Date.parse(run.finishedAt));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("series key combines benchmark and machine", () => {
  assert.equal(seriesKey({ benchmark: BENCH, machine: { id: "x" } }), `${BENCH}::x`);
});

test("headline picks the fastest machine's latest p50", async () => {
  const runs = (await loadAll()).filter((run) => run.publishable);
  const series = buildSeries(runs);
  const head = headline(series, BENCH);
  assert.ok(head);
  assert.equal(head.metric, "firstInteractiveFrameMs");
  assert.equal(head.value, 812.7);
  assert.equal(head.series.machine.id, "fixture-linux-x86");
});

test("headline is null when a benchmark has not been measured", async () => {
  const series = buildSeries([]);
  assert.equal(headline(series, BENCH), null);
});

test("latest per series excludes runs without a merged PR", async () => {
  const all = await loadAll();
  const series = buildSeries(all.filter((run) => run.publishable));
  const latest = latestPerSeries(series);
  for (const entry of latest) {
    assert.equal(entry.latest.pr !== null, true);
  }
});

test("machine fingerprint states the comparison basis", () => {
  const fingerprint = machineFingerprint({
    id: "x",
    cpuModel: "AMD EPYC 7B12",
    physicalCores: 8,
    memoryGb: 16,
    os: "Ubuntu 24.04",
    arch: "x86_64",
  });
  assert.equal(fingerprint, "AMD EPYC 7B12 · 8c · 16GB · Ubuntu 24.04 · x86_64");
});

test("formatting keeps signs and units readable", () => {
  assert.equal(fmtMs(1180.4), "1.18 s");
  assert.equal(fmtMs(24.6), "24.6 ms");
  assert.equal(fmtPct(-31.2), "-31.2%");
  assert.equal(fmtPct(4), "+4.0%");
  assert.equal(fmtPct(null), "—");
  assert.equal(fmtDeltaMs(-367.7), "−368 ms");
  assert.equal(fmtDeltaMs(0), "±0.0 ms");
});

test("unsafe hrefs are refused", () => {
  assert.equal(safeHref("./index.html"), "./index.html");
  assert.equal(safeHref("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
  assert.equal(safeHref("/index.html"), null);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("http://insecure.example"), null);
});
