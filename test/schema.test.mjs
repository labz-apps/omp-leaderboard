import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BENCHMARKS, assertValidResultDoc, isPublishableRun, validateResultDoc } from "../src/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "results");

async function fixture(name) {
  return JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
}

/** A minimal valid result, so each test can break exactly one field. */
async function validResult() {
  const doc = await fixture("cold-start-merged-pr-42.json");
  return { ...doc };
}

test("accepts a well-formed result", async () => {
  const doc = await validResult();
  assert.doesNotThrow(() => assertValidResultDoc(doc, "test"));
});

test("rejects an unknown schema version", async () => {
  const doc = { ...(await validResult()), schemaVersion: 99 };
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /schemaVersion/);
});

test("rejects synthetic results", async () => {
  const doc = { ...(await validResult()), synthetic: true };
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /synthetic/);
});

test("rejects a result with no commit sha", async () => {
  const doc = await validResult();
  delete doc.commit.sha;
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /commit\.sha/);
});

test("rejects a result with no machine id", async () => {
  const doc = await validResult();
  doc.machine.id = "";
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /machine\.id/);
});

test("rejects a missing harness command", async () => {
  const doc = await validResult();
  delete doc.harness.command;
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /harness\.command/);
});

test("rejects metrics without p50 and p95", async () => {
  const doc = await validResult();
  doc.metrics.firstInteractiveFrameMs = { unit: "ms", samples: 20 };
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /p50/);
});

test("rejects p95 below p50", async () => {
  const doc = await validResult();
  doc.metrics.firstInteractiveFrameMs.p95 = 1;
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /p95 must be greater than or equal to p50/);
});

test("rejects a finishedAt before startedAt", async () => {
  const doc = await validResult();
  doc.finishedAt = "2025-01-01T00:00:00.000Z";
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /finishedAt must not precede startedAt/);
});

test("rejects a non-https PR url", async () => {
  const doc = await validResult();
  doc.pr.url = "http://example.invalid/pull/42";
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /pr\.url/);
});

test("an unknown benchmark name is rejected", async () => {
  const doc = await validResult();
  doc.benchmark = "made-up";
  const result = validateResultDoc(doc, "test");
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /benchmark/);
});

test("both documented benchmarks validate", async () => {
  assert.ok(BENCHMARKS.COLD_START in { [BENCHMARKS.COLD_START]: 1 });
  assert.ok(BENCHMARKS.TIME_TO_RENDER in { [BENCHMARKS.TIME_TO_RENDER]: 1 });
  const ttr = await fixture("time-to-render-merged-pr-61.json");
  const unmerged = await fixture("cold-start-unmerged.json");
  assert.doesNotThrow(() => assertValidResultDoc(ttr, "ttr"));
  assert.doesNotThrow(() => assertValidResultDoc(unmerged, "unmerged"));
});

test("only runs with a merged PR are publishable", async () => {
  assert.equal(isPublishableRun(await fixture("cold-start-merged-pr-42.json")), true);
  assert.equal(isPublishableRun(await fixture("cold-start-unmerged.json")), false);
});
