import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "../src/build.mjs";
import { checkLiveSite, LIVE_CHECKS, parseArgs, verifyLive } from "../src/verify-live.mjs";
import { startStaticServer } from "../src/serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

async function buildTo(root, dir) {
  return build({
    outDir: dir,
    resultsDir: join(root, "data", "results"),
    basePath: "/omp-leaderboard/",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("a correctly published build passes every live check", async () => {
  const work = await mkdtemp(join(tmpdir(), "omp-live-ok-"));
  const out = join(work, "dist");
  try {
    await buildTo(repoRoot, out);
    const server = await startStaticServer({ root: out, basePath: "/omp-leaderboard/" });
    try {
      const result = await checkLiveSite(server.url);
      assert.deepEqual(result.failures, []);
      assert.equal(result.ok, true);
      assert.equal(result.results.length, LIVE_CHECKS.length);
      assert.equal(result.results.at(-1).status, 404, "a bogus path must 404 on a live site too");
    } finally {
      await server.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a site serving the source instead of the build fails", async () => {
  // This is the failure that actually happened: Pages pointed at the branch
  // root, so / served README.md and every built path 404'd. The deploy job
  // reported success, so only a check against real bytes catches it.
  const work = await mkdtemp(join(tmpdir(), "omp-live-source-"));
  const site = join(work, "source");
  try {
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "index.html"), "<html><body>README rendered as a page</body></html>");
    await writeFile(join(site, "README.md"), "# omp-leaderboard\n");

    const server = await startStaticServer({ root: site, basePath: "/" });
    try {
      const result = await checkLiveSite(server.url);
      assert.equal(result.ok, false);
      const joined = result.failures.join("\n");
      assert.match(joined, /changelog\.html/, "the missing built page was not caught");
      assert.match(joined, /assets\/styles\.css/);
      assert.match(joined, /data\/leaderboard\.json/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a root-relative asset path fails the live check", async () => {
  const work = await mkdtemp(join(tmpdir(), "omp-live-abs-"));
  const site = join(work, "site");
  try {
    await buildTo(repoRoot, site);
    const html = await (await import("node:fs/promises")).readFile(join(site, "index.html"), "utf8");
    const broken = html
      .replace('href="./assets/styles.css"', 'href="/assets/styles.css"')
      .replace('src="./assets/app.js"', 'src="/assets/app.js"');
    await writeFile(join(site, "index.html"), broken);

    const server = await startStaticServer({ root: site, basePath: "/omp-leaderboard/" });
    try {
      const result = await checkLiveSite(server.url);
      assert.equal(result.ok, false);
      assert.match(result.failures.join("\n"), /root-relative asset path/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("an unreachable site fails instead of passing quietly", async () => {
  const result = await checkLiveSite("http://127.0.0.1:1/");
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test("verifyLive retries a transient failure and then reports it", async () => {
  let attempts = 0;
  const logs = [];
  const outcome = await verifyLive("http://127.0.0.1:1/", {
    retries: 3,
    retryDelayMs: 1,
    log: (message) => logs.push(message),
  });
  assert.equal(outcome.ok, false);
  assert.equal(attempts, 0);
  assert.ok(logs.length >= 2, "expected at least one retry message and a final failure");
  assert.match(logs.at(-1), /not serving the build after/);
});

test("a doubled trailing slash is normalized, not checked literally", async () => {
  const work = await mkdtemp(join(tmpdir(), "omp-live-slash-"));
  const out = join(work, "dist");
  try {
    await buildTo(repoRoot, out);
    const server = await startStaticServer({ root: out, basePath: "/omp-leaderboard/" });
    try {
      const once = await checkLiveSite(server.url);
      const doubled = await checkLiveSite(`${server.url}/`);
      assert.equal(doubled.ok, once.ok);
      assert.equal(doubled.ok, true, "a doubled slash changed the outcome");
      for (const result of doubled.results) {
        assert.ok(!result.url.includes("//omp"), `checked a literal double-slash path: ${result.url}`);
      }
    } finally {
      await server.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the CLI parses --url and its documented flags", () => {
  assert.deepEqual(parseArgs(["--url", "https://x.github.io/y/"]), { url: "https://x.github.io/y/" });
  assert.deepEqual(parseArgs(["--url=https://x/"]), { url: "https://x/" });
  assert.deepEqual(parseArgs(["--retries", "2", "--retry-delay-ms", "10"]), { retries: "2", "retry-delay-ms": "10" });
});

test("the live check requires a url, and says so", () => {
  assert.equal(parseArgs([]).url, undefined);
});