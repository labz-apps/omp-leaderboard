#!/usr/bin/env node
/**
 * End-to-end verification.
 *
 * `npm run verify` is the gate that stands in for "the site serves on GitHub
 * Pages". It proves, without a network and without a GitHub token:
 *
 *   1. unit tests pass
 *   2. a build from committed fixtures renders every section
 *   3. every local asset reference is relative, so the build works under any
 *      base path (this is the project-Pages requirement)
 *   4. the built output actually serves over HTTP under `/omp-leaderboard/`,
 *      including a deep path and the 404 fallback
 *   5. an empty result set still produces a valid, explanatory site
 *   6. a synthetic or malformed result file fails the build instead of
 *      rendering (the "no hand-entered numbers" rule, enforced)
 *
 * Fixture data is built into `.verify/`, never into `dist/`, so the published
 * site can only ever contain harness output.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.mjs";
import { primaryMetricName } from "./deltas.mjs";
import { startStaticServer } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const results = [];
let failures = 0;

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error: error.message });
    process.stdout.write(`  FAIL ${name}\n       ${String(error.message).split("\n").join("\n       ")}\n`);
  }
}

/** @param {string} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every href/src in the document, so relative-path rules can be enforced. */
export function extractReferences(html) {
  /** @type {{attr: string, url: string}[]} */
  const refs = [];
  const re = /\b(href|src)="([^"]*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    refs.push({ attr: match[1], url: match[2] });
  }
  return refs;
}

/**
 * A local reference must be relative. Absolute references are allowed only for
 * links out to GitHub (merged PRs, commits, the harness repo).
 */
export function assertRelativeReferences(html, { page }) {
  const violations = [];
  for (const { attr, url } of extractReferences(html)) {
    if (url === "" || url.startsWith("#") || url.startsWith("data:")) continue;
    if (url.startsWith("https://")) {
      const host = new URL(url).hostname;
      if (host === "github.com" || host === "www.github.com") continue;
      violations.push(`${page}: external ${attr}="${url}" (only github.com links are allowed)`);
      continue;
    }
    if (url.startsWith("//") || url.startsWith("/")) {
      violations.push(`${page}: ${attr}="${url}" is root-relative, which breaks a project Pages base path`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`non-relative local references found:\n  - ${violations.join("\n  - ")}`);
  }
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function main() {
  process.stdout.write("omp-leaderboard verification\n\n");

  await check("unit tests", async () => {
    await run(process.execPath, ["--test"]);
  });

  const workDir = await mkdtemp(join(tmpdir(), "omp-leaderboard-verify-"));
  const fixtureResults = join(repoRoot, "test", "fixtures", "results");
  const fixtureOut = join(workDir, "fixture-dist");
  const basePath = "/omp-leaderboard/";

  try {
    let fixtureSummary;
    await check("build from committed fixtures", async () => {
      fixtureSummary = await build({
        outDir: fixtureOut,
        resultsDir: fixtureResults,
        basePath,
        sourceRepo: "https://github.com/labz-apps/oh-my-pi/tree/main",
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert(fixtureSummary.publishableCount > 0, "fixture build produced no leaderboard rows");
      assert(fixtureSummary.changelogEntries > 0, "fixture build produced no changelog entries");
    });

    const indexHtml = await readFile(join(fixtureOut, "index.html"), "utf8");
    const changelogHtml = await readFile(join(fixtureOut, "changelog.html"), "utf8");
    const json = JSON.parse(await readFile(join(fixtureOut, "data", "leaderboard.json"), "utf8"));

    await check("every leaderboard row traces to a merged PR and a run id", () => {
      const publishable = json.runs.filter((run) => run.publishable);
      assert(publishable.length === fixtureSummary.publishableCount, "row count mismatch");
      for (const run of publishable) {
        assert(run.pr && typeof run.pr.url === "string" && run.pr.url.startsWith("https://"), "row without an https PR link");
        assert(Number.isInteger(run.pr.number) && run.pr.number > 0, "row without a PR number");
        assert(typeof run.commit.sha === "string" && run.commit.sha.length >= 7, "row without a commit");
        assert(typeof run.machine.id === "string" && run.machine.id !== "", "row without a machine");
        assert(typeof run.runId === "string" && run.runId !== "", "row without a run id");
        assert(typeof run.harness.command === "string" && run.harness.command !== "", "row without a harness command");
        const metricName = primaryMetricName(run);
        assert(metricName, "row without a metric");
        assert(Number.isFinite(run.metrics[metricName].p50), "row without a p50");
        assert(Number.isFinite(run.metrics[metricName].p95), "row without a p95");
      }
    });

    await check("deltas are computed, not stored in result files", async () => {
      const withDelta = json.runs.filter((run) => run.publishable && run.delta && Object.keys(run.delta).length > 0);
      assert(withDelta.length > 0, "no computed deltas found");
      for (const run of withDelta) {
        for (const [name, delta] of Object.entries(run.delta)) {
          assert(Number.isFinite(delta.p50) && Number.isFinite(delta.p95), `delta for ${name} lost the measured value`);
          assert(delta.p50Pct === null || Number.isFinite(delta.p50Pct), `delta for ${name} is not numeric`);
        }
      }
      const fixtureFiles = (await readdir(fixtureResults)).filter((file) => file.endsWith(".json"));
      assert(fixtureFiles.length > 0, "no fixture result files found");
      for (const file of fixtureFiles) {
        const doc = JSON.parse(await readFile(join(fixtureResults, file), "utf8"));
        assert(!("delta" in doc), `${file} contains a delta field; deltas must be computed at build time`);
      }
    });

    await check("fixture builds are labelled as previews, real builds are not", async () => {
      const previewOut = join(workDir, "preview-dist");
      await build({
        outDir: previewOut,
        resultsDir: fixtureResults,
        basePath,
        preview: true,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      const previewIndex = await readFile(join(previewOut, "index.html"), "utf8");
      const previewChangelog = await readFile(join(previewOut, "changelog.html"), "utf8");
      assert(previewIndex.includes("preview-banner"), "preview index lacks its banner");
      assert(previewChangelog.includes("preview-banner"), "preview changelog lacks its banner");
      assert(previewIndex.includes('name="robots" content="noindex"'), "preview build is not marked noindex");

      const realOut = join(workDir, "real-dist");
      await build({ outDir: realOut, resultsDir: join(repoRoot, "data", "results"), basePath });
      const realIndex = await readFile(join(realOut, "index.html"), "utf8");
      assert(!realIndex.includes("preview-banner"), "a real build is showing a preview banner");
    });

    await check("index page references its assets relatively", () => {
      assert(indexHtml.includes('href="./assets/styles.css"'), "stylesheet is not referenced relatively");
      assert(indexHtml.includes('src="./assets/app.js"'), "script is not referenced relatively");
      assertRelativeReferences(indexHtml, { page: "index.html" });
    });

    await check("changelog page references its assets relatively", () => {
      assert(changelogHtml.includes('href="./assets/styles.css"'), "stylesheet is not referenced relatively");
      assertRelativeReferences(changelogHtml, { page: "changelog.html" });
    });

    await check("built output is self-contained", async () => {
      const files = await readdir(fixtureOut, { recursive: true });
      const normalized = files.map((f) => String(f).replace(/\\/g, "/"));
      for (const required of ["index.html", "changelog.html", "404.html", ".nojekyll", "assets/styles.css", "assets/app.js", "assets/favicon.svg", "data/leaderboard.json"]) {
        assert(normalized.includes(required), `missing ${required} in build output`);
      }
    });

    await check("site serves under a project Pages base path", async () => {
      const server = await startStaticServer({ root: fixtureOut, basePath });
      try {
        // Paths are resolved against the base path, exactly as a browser on
        // https://<owner>.github.io/<repo>/ would request them.
        const targets = [
          ["", 200],
          ["index.html", 200],
          ["changelog.html", 200],
          ["assets/styles.css", 200],
          ["assets/app.js", 200],
          ["assets/favicon.svg", 200],
          ["data/leaderboard.json", 200],
          ["nope", 404],
        ];
        for (const [path, expected] of targets) {
          const res = await fetch(new URL(path, server.url), { redirect: "manual" });
          assert(res.status === expected, `${path || "/"} returned ${res.status}, expected ${expected}`);
          if (expected === 200) {
            const body = await res.text();
            assert(body.length > 0, `${path || "/"} served an empty body`);
          }
        }

        const index = await (await fetch(server.url)).text();
        assert(index.includes("Leaderboard"), "served index is missing its content");
        assert(!index.includes('href="/assets'), "served index contains a root-relative asset path");
      } finally {
        await server.close();
      }
    });

    await check("empty result set degrades gracefully", async () => {
      const emptyResults = join(workDir, "empty-results");
      const emptyOut = join(workDir, "empty-dist");
      await mkdir(emptyResults, { recursive: true });
      const summary = await build({
        outDir: emptyOut,
        resultsDir: emptyResults,
        basePath,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert(summary.publishableCount === 0, "empty data produced rows");
      const html = await readFile(join(emptyOut, "index.html"), "utf8");
      assert(html.includes("No benchmark has landed on a merged PR yet"), "missing empty-state explanation");
      assert(html.includes('href="./assets/styles.css"'), "empty state lost its relative assets");
      assert(!html.includes("<table>"), "empty state rendered an empty table instead of an explanation");
      const changelog = await readFile(join(emptyOut, "changelog.html"), "utf8");
      assert(changelog.includes("No merged improvement has been measured yet"), "missing changelog empty state");
      assertRelativeReferences(changelog, { page: "changelog.html (empty)" });

      const server = await startStaticServer({ root: emptyOut, basePath });
      try {
        const res = await fetch(server.url);
        assert(res.status === 200, "empty-state site did not serve");
        assert((await res.text()).includes("No benchmark has landed on a merged PR yet"), "served empty state lost its explanation");
      } finally {
        await server.close();
      }
    });

    await check("a synthetic result file fails the build", async () => {
      const dir = join(workDir, "synthetic-results");
      await mkdir(dir, { recursive: true });
      const base = JSON.parse(await readFile(join(fixtureResults, "cold-start-merged-pr-42.json"), "utf8"));
      await writeFile(join(dir, "synthetic.json"), JSON.stringify({ ...base, synthetic: true }), "utf8");
      let threw = false;
      try {
        await build({ outDir: join(workDir, "synthetic-dist"), resultsDir: dir, basePath });
      } catch (error) {
        threw = true;
        assert(/synthetic/i.test(error.message), `unexpected failure: ${error.message}`);
      }
      assert(threw, "build accepted a synthetic result");
    });

    await check("an unprovenanced result file fails the build", async () => {
      const dir = join(workDir, "bad-results");
      await mkdir(dir, { recursive: true });
      const base = JSON.parse(await readFile(join(fixtureResults, "cold-start-merged-pr-42.json"), "utf8"));
      const { sha, ...commitWithoutSha } = base.commit;
      void sha;
      await writeFile(join(dir, "bad.json"), JSON.stringify({ ...base, commit: commitWithoutSha }), "utf8");
      let threw = false;
      try {
        await build({ outDir: join(workDir, "bad-dist"), resultsDir: dir, basePath });
      } catch (error) {
        threw = true;
        assert(/commit\.sha/.test(error.message), `unexpected failure: ${error.message}`);
      }
      assert(threw, "build accepted a result with no commit sha");
    });

    await check("the published dist path never contains fixture data", async () => {
      const distDir = join(repoRoot, "dist");
      const files = await readdir(distDir).catch(() => null);
      if (files === null) return; // not built in this process; nothing to leak
      assert(!files.includes("fixtures"), "dist contains a fixtures directory");
      const jsonPath = join(distDir, "data", "leaderboard.json");
      const text = await readFile(jsonPath, "utf8").catch(() => null);
      if (text === null) return;
      assert(!text.includes("fixture"), "dist/data/leaderboard.json references fixture data");
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${results.length - failures}/${results.length} checks passed\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

// verify.mjs runs its checks at module scope; nothing to export beyond the two
// helpers above, which the tests import directly.
await main();
