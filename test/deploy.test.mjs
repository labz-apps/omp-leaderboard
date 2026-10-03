import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { deployGhPages } from "../src/deploy-gh-pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * A bare repository standing in for the GitHub remote, plus a source checkout
 * with `origin` pointing at it. This is the exact topology the real push uses.
 */
async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), "omp-leaderboard-deploy-test-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  git(["init", "--quiet", "--bare", remote], root);
  git(["init", "--quiet", "--initial-branch", "main", source], root);
  git(["config", "user.email", "test@example.invalid"], source);
  git(["config", "user.name", "test"], source);
  git(["remote", "add", "origin", remote], source);
  return { root, remote, source };
}

test("publishes the build to a gh-pages branch on the remote", async () => {
  const { root, remote, source } = await scaffold();
  try {
    const result = await deployGhPages({ repoRoot: source, remote: "origin", branch: "gh-pages" });
    assert.equal(result.dryRun, false);

    const branches = git(["branch", "--list"], remote).stdout;
    assert.match(branches, /gh-pages/, "the remote has no gh-pages branch");

    const tree = git(["ls-tree", "-r", "--name-only", "gh-pages"], remote).stdout.trim().split("\n");
    for (const required of [
      "index.html",
      "changelog.html",
      "404.html",
      ".nojekyll",
      "assets/styles.css",
      "assets/app.js",
      "assets/favicon.svg",
      "data/leaderboard.json",
    ]) {
      assert.ok(tree.includes(required), `gh-pages is missing ${required}`);
    }

    // The published branch is a snapshot: no source code, no history, no git
    // internals leaking into the served tree.
    assert.equal(tree.some((file) => file.startsWith("src/")), false, "source code was published");
    assert.equal(tree.some((file) => file.startsWith(".git")), false, "git internals were published");

    const count = git(["rev-list", "--count", "gh-pages"], remote).stdout.trim();
    assert.equal(count, "1", "the published branch should be a single-commit snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the published index serves a working, relative-asset page", async () => {
  const { root, remote, source } = await scaffold();
  try {
    await deployGhPages({ repoRoot: source, remote: "origin", branch: "gh-pages" });
    const html = git(["show", "gh-pages:index.html"], remote).stdout;
    assert.match(html, /href="\.\/assets\/styles\.css"/);
    assert.match(html, /src="\.\/assets\/app\.js"/);
    assert.match(html, /href="\.\/changelog\.html"/);
    assert.ok(!/href="\/assets/.test(html), "a root-relative asset path would break a project Pages site");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry run builds and lists files but pushes nothing", async () => {
  const { root, remote, source } = await scaffold();
  try {
    const result = await deployGhPages({ repoRoot: source, remote: "origin", branch: "gh-pages", dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.files.includes("index.html"));
    assert.equal(git(["branch", "--list"], remote).stdout.includes("gh-pages"), false, "a dry run pushed a branch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing remote fails before anything is pushed", async () => {
  const { root, source } = await scaffold();
  try {
    await assert.rejects(
      () => deployGhPages({ repoRoot: source, remote: "nowhere", branch: "gh-pages" }),
      /no git remote named "nowhere"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe branch and remote names are refused", async () => {
  const { root, source } = await scaffold();
  try {
    for (const branch of ["main;rm -rf /", "../../etc", "feature/gh-pages", "--force", ""]) {
      await assert.rejects(
        () => deployGhPages({ repoRoot: source, remote: "origin", branch }),
        /branch/,
        `branch "${branch}" was not refused`,
      );
    }
    await assert.rejects(
      () => deployGhPages({ repoRoot: source, remote: "origin;evil", branch: "gh-pages" }),
      /remote/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("republishing replaces the previous build instead of accumulating files", async () => {
  const { root, remote, source } = await scaffold();
  try {
    await deployGhPages({ repoRoot: source, remote: "origin", branch: "gh-pages" });
    // A stale file left by an older build must not survive the next publish.
    await mkdir(join(source, "data", "results"), { recursive: true });
    await deployGhPages({ repoRoot: source, remote: "origin", branch: "gh-pages" });
    const tree = git(["ls-tree", "-r", "--name-only", "gh-pages"], remote).stdout.trim().split("\n");
    assert.equal(tree.some((file) => file.endsWith(".json") && file.startsWith("results/")), false);
    assert.equal(tree.includes("data/leaderboard.json"), true);
    const count = git(["rev-list", "--count", "gh-pages"], remote).stdout.trim();
    assert.equal(count, "1", "a republish must replace the branch, not add to it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deploy entry point exists where the workflow calls it", async () => {
  const script = await readFile(join(repoRoot, "src", "deploy-gh-pages.mjs"), "utf8");
  assert.match(script, /#!/);
  assert.match(script, /export async function deployGhPages/);
});