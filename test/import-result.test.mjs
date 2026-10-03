import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const fixturesDir = join(here, "fixtures", "results");

/**
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runImporter(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "bin", "import-result.mjs"), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function fixture(name) {
  return JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
}

/** An empty results directory, so each case starts from a known state. */
async function emptyResults() {
  const root = await mkdtemp(join(tmpdir(), "omp-leaderboard-import-"));
  const results = join(root, "results");
  await mkdir(results, { recursive: true });
  return { root, results };
}

async function importDoc(doc, results) {
  const file = join(results, "..", "candidate.json");
  await writeFile(file, JSON.stringify(doc), "utf8");
  return runImporter(["--file", file, "--results", results]);
}

test("a well-formed result is imported and named after its run", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await importDoc(await fixture("cold-start-merged-pr-42.json"), results);
  assert.equal(result.code, 0, result.stderr);
  const files = await readdir(results);
  assert.equal(files.length, 1);
  assert.match(files[0], /^cold-start-1111111-fixture-cold-start-run-1\.json$/);
  assert.match(result.stdout, /source run/);
  assert.match(result.stdout, /PR #42/);
});

test("a result with no build type is refused before it is written", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = await fixture("cold-start-merged-pr-42.json");
  delete doc.harness.build;
  const result = await importDoc(doc, results);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to import/);
  assert.match(result.stderr, /harness\.build/);
  assert.deepEqual(await readdir(results), []);
});

test("a run whose tree moved during the measurement is refused", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = await fixture("cold-start-merged-pr-42.json");
  doc.commit.shaAtFinish = "9999999999999999999999999999999999999999";
  const result = await importDoc(doc, results);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /differs from commit\.sha/);
  assert.deepEqual(await readdir(results), []);
});

test("a contended run is imported, labelled, and never claimed as a row", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await importDoc(await fixture("cold-start-contended.json"), results);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /CONTESTED \(2 same-benchmark runs active\): recorded, never published/);
});

test("a run overlapping an already-imported run is refused", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await importDoc(await fixture("cold-start-merged-pr-42.json"), results);
  assert.equal(first.code, 0, first.stderr);

  const overlapping = await fixture("cold-start-merged-pr-57.json");
  overlapping.startedAt = "2026-01-05T09:02:00.000Z";
  overlapping.finishedAt = "2026-01-05T09:07:31.000Z";
  const second = await importDoc(overlapping, results);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /overlaps 1 existing cold-start run/);
  assert.match(second.stderr, /neither number is publishable/);
  assert.equal((await readdir(results)).length, 1, "the refused run was written anyway");
});

test("back-to-back runs on one machine import cleanly", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await importDoc(await fixture("cold-start-merged-pr-42.json"), results)).code, 0);
  const second = await importDoc(await fixture("cold-start-merged-pr-57.json"), results);
  assert.equal(second.code, 0, second.stderr);
  assert.equal((await readdir(results)).length, 2);
});

test("a new build type on one machine is imported, and the split is reported", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await importDoc(await fixture("cold-start-merged-pr-42.json"), results)).code, 0);
  const binary = await importDoc(await fixture("cold-start-binary.json"), results);
  assert.equal(binary.code, 0, binary.stderr);
  assert.match(binary.stdout, /starts a new source run -> compiled binary series on fixture-linux-x86/);
  assert.match(binary.stdout, /no delta crosses a build type/);
  assert.equal((await readdir(results)).length, 2);
});

test("runs on a different machine never block each other", async (t) => {
  const { root, results } = await emptyResults();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await fixture("cold-start-merged-pr-42.json");
  assert.equal((await importDoc(first, results)).code, 0);
  const elsewhere = await fixture("cold-start-merged-pr-57.json");
  elsewhere.machine = { ...elsewhere.machine, id: "fixture-mac-arm" };
  const result = await importDoc(elsewhere, results);
  assert.equal(result.code, 0, result.stderr);
});