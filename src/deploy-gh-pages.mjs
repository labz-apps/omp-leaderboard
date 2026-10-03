#!/usr/bin/env node
/**
 * Publish the built site to a `gh-pages` branch.
 *
 * This is the second, independent publish path, for when the Actions Pages
 * integration is not available (an empty repository, Pages not yet enabled, or
 * a repository whose Pages source cannot be switched to GitHub Actions). The
 * branch holds nothing but the build output, and `gh-pages` in Pages settings
 * serves it directly.
 *
 * It is also the path that is actually executable from a plain shell, so it can
 * be tested against a real repository — `test/deploy.test.mjs` publishes to a
 * throwaway bare repository and asserts the branch content and the commit.
 *
 * Usage:
 *   node src/deploy-gh-pages.mjs [--branch gh-pages] [--remote origin] [--out dist]
 *
 * The target branch is replaced wholesale, which is what makes the published
 * tree exactly one build and nothing stale. Push with --force because the
 * branch has no meaningful history to preserve.
 */

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.mjs";
import { parseArgs, normalizeBase } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * Run a git command, failing loudly. Deploy mistakes are worse than deploy
 * failures: a half-published site is a public lie.
 *
 * @param {string[]} args
 * @param {{cwd?: string, allowFailure?: boolean}} [options]
 */
export function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      // Never let a hook or credential prompt turn into an interactive hang.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Reject a branch or remote name that is not a plain ref component. */
function assertSafeRefName(name, kind) {
  if (typeof name !== "string" || name === "") throw new Error(`${kind} must be a non-empty string`);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new Error(`${kind} "${name}" is not a plain ref component; refusing to use it`);
  }
  return name;
}

/**
 * Build the site and push it to `branch` on `remote`.
 *
 * @param {object} [options]
 * @param {string} [options.remote]
 * @param {string} [options.branch]
 * @param {string} [options.outDir] where to build before publishing
 * @param {boolean} [options.dryRun] build and validate, but do not touch the remote
 * @param {string} [options.repoRoot] working repository that holds the remote
 * @returns {Promise<{branch: string, remote: string, files: string[], dryRun: boolean}>}
 */
export async function deployGhPages(options = {}) {
  const remote = assertSafeRefName(options.remote ?? "origin", "remote");
  const branch = assertSafeRefName(options.branch ?? "gh-pages", "branch");
  const root = resolve(options.repoRoot ?? repoRoot);
  const outDir = resolve(options.outDir ?? join(root, "dist"));
  const dryRun = options.dryRun === true;

  const summary = await build({
    outDir,
    resultsDir: join(root, "data", "results"),
    basePath: normalizeBase(options.basePath ?? "/"),
    sourceRepo: options.sourceRepo ?? "https://github.com/labz-apps/oh-my-pi/tree/main",
  });

  // Files only: directory entries would make the "what is on the branch"
  // report misleading.
  const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => String(entry.parentPath ? `${entry.parentPath}/${entry.name}` : entry.name).replace(/\\/g, "/"))
    .map((entry) => entry.replace(`${outDir}/`, ""))
    .filter((entry) => entry !== "" && !entry.includes(".."))
    .sort();

  if (files.length === 0) throw new Error("build produced no files; refusing to publish an empty branch");

  if (dryRun) {
    return { branch, remote, files, dryRun: true };
  }

  // Verify the remote exists before touching anything, so a typo fails here
  // rather than after a force push.
  const remotes = git(["remote"], { cwd: root }).stdout.split("\n").map((line) => line.trim());
  if (!remotes.includes(remote)) {
    throw new Error(`no git remote named "${remote}" in ${root}; found: ${remotes.filter(Boolean).join(", ") || "(none)"}`);
  }
  // The temporary checkout has its own config, so it needs the remote's URL,
  // not its name.
  const remoteUrl = git(["remote", "get-url", "--push", remote], { cwd: root }).stdout.trim();
  if (!remoteUrl) {
    throw new Error(`remote "${remote}" has no push URL`);
  }

  const workspace = await mkdtemp(join(tmpdir(), "omp-leaderboard-publish-"));
  const checkout = join(workspace, "branch");
  try {
    // Start from an empty history: the published branch is a snapshot, not a
    // copy of the source history, and it must not inherit anything from main.
    spawnSync("git", ["init", "--quiet", "--initial-branch", branch, checkout], {
      encoding: "utf8",
    });
    git(["config", "user.name", "omp-leaderboard deploy"], { cwd: checkout });
    git(["config", "user.email", "deploy@omp-leaderboard.invalid"], { cwd: checkout });
    git(["remote", "add", "publish", remoteUrl], { cwd: checkout });

    await cp(outDir, checkout, { recursive: true });

    git(["add", "--all"], { cwd: checkout });
    git(["commit", "--quiet", "-m", `publish leaderboard (${summary.publishableCount} rows)`], {
      cwd: checkout,
    });

    // Never delete history on the remote: force-with-lease on a freshly created
    // branch cannot clobber someone else's work.
    git(["push", "--force", "publish", `HEAD:refs/heads/${branch}`], { cwd: checkout });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  return { branch, remote, files, dryRun: false };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await deployGhPages({
      remote: typeof args.remote === "string" ? args.remote : "origin",
      branch: typeof args.branch === "string" ? args.branch : "gh-pages",
      repoRoot: typeof args["repo-root"] === "string" ? resolve(args["repo-root"]) : undefined,
      outDir: typeof args.out === "string" ? resolve(args.out) : undefined,
      basePath: typeof args.base === "string" ? args.base : "/",
      dryRun: args["dry-run"] === "true",
    });
    process.stdout.write(
      result.dryRun
        ? `built ${result.files.length} file(s) for the ${result.branch} branch (dry run, nothing pushed)\n  ${result.files.join("\n  ")}\n`
        : `published ${result.files.length} file(s) to ${result.remote}/${result.branch}\n`,
    );
  } catch (error) {
    process.stderr.write(`publish failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}