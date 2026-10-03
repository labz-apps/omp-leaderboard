import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertNoIntegrityConflicts,
  buildSeries,
  comparableRuns,
  computeDelta,
  findIntegrityConflicts,
  headline,
  latestPerSeries,
  machineFingerprint,
  percentChange,
  seriesKey,
  windowsOverlap,
} from "../src/deltas.mjs";
import { deltaDirection, fmtDeltaMs, fmtMs, fmtPct, safeHref } from "../src/html.mjs";
import { isContendedRun } from "../src/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "results");

async function loadAll() {
  const names = [
    "cold-start-merged-pr-42.json",
    "cold-start-merged-pr-57.json",
    "time-to-render-merged-pr-61.json",
    "time-to-render-merged-pr-74.json",
    "cold-start-unmerged.json",
    "cold-start-contended.json",
    "cold-start-binary.json",
  ];
  const runs = [];
  for (const name of names) {
    const doc = JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
    const publishable = doc.pr !== null && doc.pr !== undefined;
    runs.push({
      ...doc,
      id: name,
      publishable,
      contended: isContendedRun(doc),
      comparable: publishable && !isContendedRun(doc),
    });
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
  assert.ok(keys.includes(`${BENCH}::fixture-linux-x86::source`));
  assert.ok(keys.includes(`${BENCH}::fixture-mac-arm::source`));
  // The copy on the other machine is its own baseline, so it must have no delta.
  const macSeries = series.get(`${BENCH}::fixture-mac-arm::source`);
  assert.equal(macSeries.runs[0].delta.firstInteractiveFrameMs.p50Pct, null);
});

test("runs from different build types never share a series", async () => {
  const runs = comparableRuns(await loadAll());
  const series = buildSeries(runs);
  const coldStart = [...series.entries()].filter(([key]) => key.startsWith(`${BENCH}::`));
  assert.deepEqual(
    coldStart.map(([key]) => key).sort(),
    [`${BENCH}::fixture-linux-x86::binary`, `${BENCH}::fixture-linux-x86::source`],
  );
  const source = series.get(`${BENCH}::fixture-linux-x86::source`);
  const binary = series.get(`${BENCH}::fixture-linux-x86::binary`);
  assert.ok(source.runs.every((run) => run.harness.build === "source"));
  assert.ok(binary.runs.every((run) => run.harness.build === "binary"));
  // The binary run is the only run in its series, so it has no baseline at all.
  assert.equal(binary.runs[0].delta.firstInteractiveFrameMs.baselineP50, null);
});

test("a contended run is never published and never becomes a baseline", async () => {
  const all = await loadAll();
  const contended = all.find((run) => run.contended);
  assert.ok(contended, "the contended fixture is missing");
  const eligible = comparableRuns(all);
  assert.ok(!eligible.includes(contended), "a contended run was eligible for a series");
  // The source series must not use it as the baseline for the next run.
  const source = buildSeries(eligible).get(`${BENCH}::fixture-linux-x86::source`);
  assert.ok(!source.runs.includes(contended));
  assert.equal(source.runs.at(-1).delta.firstInteractiveFrameMs.baselineP50, source.runs.at(-2).metrics.firstInteractiveFrameMs.p50);
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

test("series key combines benchmark, machine, and build type", () => {
  assert.equal(seriesKey({ benchmark: BENCH, machine: { id: "x" }, harness: { build: "source" } }), `${BENCH}::x::source`);
  assert.equal(seriesKey({ benchmark: BENCH, machine: { id: "x" }, harness: { build: "binary" } }), `${BENCH}::x::binary`);
  // A run that predates the field lands in its own bucket rather than being
  // silently folded into the recorded builds.
  assert.equal(seriesKey({ benchmark: BENCH, machine: { id: "x" } }), `${BENCH}::x::unknown`);
});

test("measurement windows that overlap are detected", () => {
  const run = (startedAt, finishedAt) => ({ startedAt, finishedAt });
  assert.equal(
    windowsOverlap(run("2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z"), run("2026-01-01T10:04:00Z", "2026-01-01T10:09:00Z")),
    true,
  );
  assert.equal(
    windowsOverlap(run("2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z"), run("2026-01-01T10:05:00Z", "2026-01-01T10:09:00Z")),
    false,
    "back-to-back runs share an instant but not an interval",
  );
  assert.equal(windowsOverlap({ startedAt: "nope", finishedAt: "nope" }, run("2026-01-01T10:00:00Z", "2026-01-01T10:05:00Z")), false);
});

test("two overlapping runs of one benchmark on one machine are a fatal conflict", async () => {
  const a = await fixtureRun("cold-start-merged-pr-42.json");
  const b = await fixtureRun("cold-start-merged-pr-57.json");
  b.startedAt = "2026-01-05T09:02:00.000Z";
  b.finishedAt = "2026-01-05T09:07:31.000Z";
  const { fatal, notes } = findIntegrityConflicts([a, b]);
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].kind, "concurrent-runs");
  assert.match(fatal[0].message, /overlapped/);
  assert.deepEqual(notes, []);
  assert.throws(() => assertNoIntegrityConflicts([a, b]), /run-integrity conflict/);
});

test("two different programs measured at once on one machine id name the conflict", async () => {
  const a = await fixtureRun("cold-start-merged-pr-42.json");
  const b = await fixtureRun("cold-start-binary.json");
  b.startedAt = "2026-01-05T09:02:00.000Z";
  b.finishedAt = "2026-01-05T09:07:48.000Z";
  const { fatal } = findIntegrityConflicts([a, b]);
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].kind, "mixed-build-concurrency");
  assert.match(fatal[0].message, /two different programs were measured at the same time/);
});

test("the same window on a different machine is not a conflict", async () => {
  const a = await fixtureRun("cold-start-merged-pr-42.json");
  const b = await fixtureRun("cold-start-merged-pr-57.json");
  b.machine = { ...b.machine, id: "fixture-mac-arm" };
  b.startedAt = a.startedAt;
  b.finishedAt = a.finishedAt;
  const { fatal } = findIntegrityConflicts([a, b]);
  assert.deepEqual(fatal, [], "machine ids collide in the wild, so overlap is scoped to one machine id");
});

test("a build type change is reported as a note, not a failure", async () => {
  const runs = await loadAll();
  const { fatal, notes } = findIntegrityConflicts(runs);
  assert.deepEqual(fatal, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "build-switch");
  assert.match(notes[0].message, /binary, source/);
  assert.doesNotThrow(() => assertNoIntegrityConflicts(runs));
});

async function fixtureRun(name) {
  return JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
}

test("headline picks the fastest machine's latest p50", async () => {
  const runs = comparableRuns(await loadAll());
  const series = buildSeries(runs);
  const head = headline(series, BENCH);
  assert.ok(head);
  assert.equal(head.metric, "firstInteractiveFrameMs");
  assert.equal(head.value, 812.7);
  assert.equal(head.series.machine.id, "fixture-linux-x86");
  assert.equal(head.series.build, "source", "the headline must state which program it measured");
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
