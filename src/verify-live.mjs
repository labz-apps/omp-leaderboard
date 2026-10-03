#!/usr/bin/env node
/**
 * Verify that the *live* site serves the build.
 *
 * This exists because a deploy can succeed and still serve the wrong thing. It
 * did: Pages was configured for branch builds, `actions/deploy-pages` reported
 * success, and the live site served `README.md` from the repository root while
 * `/changelog.html` returned 404. Every build-time check passed, because the
 * artifact was correct — it simply was not what GitHub served.
 *
 * So the check runs against a real URL, over HTTP, after the deploy:
 *
 *   node src/verify-live.mjs --url https://<owner>.github.io/<repo>/
 *
 * Exits non-zero if anything is off, which is what makes it usable as a
 * post-deploy gate in `pages.yml` rather than a suggestion in a runbook.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Every path the site must serve, with what proves it is the real page. */
export const LIVE_CHECKS = [
  { path: "", expect: 200, type: "text/html", markers: ["<title>oh-my-pi leaderboard", "./assets/styles.css"] },
  { path: "index.html", expect: 200, type: "text/html", markers: ['rel="stylesheet"', "./assets/app.js"] },
  { path: "changelog.html", expect: 200, type: "text/html", markers: ["<title>oh-my-pi changelog"] },
  { path: "assets/styles.css", expect: 200, type: "text/css", markers: [".site-header"] },
  { path: "assets/app.js", expect: 200, type: "javascript", markers: ["Scrollable table"] },
  { path: "assets/favicon.svg", expect: 200, type: "image/svg+xml", markers: ["<svg"] },
  { path: "data/leaderboard.json", expect: 200, type: "application/json", markers: ["schemaVersion"] },
  { path: "this-path-should-not-exist", expect: 404, type: null, markers: [] },
];

/**
 * Run every live check once.
 * @param {string} baseUrl site root, with a trailing slash
 * @returns {Promise<{ok: boolean, failures: string[], results: any[]}>}
 */
export async function checkLiveSite(baseUrl) {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  /** @type {string[]} */
  const failures = [];
  /** @type {any[]} */
  const results = [];

  for (const check of LIVE_CHECKS) {
    const url = new URL(check.path, root).href;
    /** @type {any} */
    let result;
    try {
      const response = await fetch(url, { redirect: "manual", headers: { "user-agent": "omp-leaderboard-verify-live" } });
      const body = response.status === 404 ? "" : await response.text();
      const contentType = response.headers.get("content-type") ?? "";

      const problems = [];
      if (response.status !== check.expect) {
        problems.push(`expected HTTP ${check.expect}, got ${response.status}`);
      }
      if (check.type && !contentType.includes(check.type)) {
        problems.push(`expected content-type containing "${check.type}", got "${contentType || "(none)"}"`);
      }
      for (const marker of check.markers) {
        if (!body.includes(marker)) problems.push(`missing ${JSON.stringify(marker)}`);
      }
      // The single most important property of this site, checked against the
      // bytes a browser actually receives: no root-relative asset path, because
      // this is a project Pages site served from /<repo>/.
      if (check.path === "" && /<link[^>]+href="\/|<script[^>]+src="\//.test(body)) {
        problems.push("served HTML contains a root-relative asset path");
      }

      result = { path: check.path, url, status: response.status, contentType, ok: problems.length === 0, problems };
      if (problems.length > 0) failures.push(`${check.path || "/"}: ${problems.join("; ")}`);
    } catch (error) {
      result = { path: check.path, url, ok: false, problems: [error.message] };
      failures.push(`${check.path || "/"}: ${error.message}`);
    }
    results.push(result);
  }

  return { ok: failures.length === 0, failures, results };
}

/**
 * Check the site, retrying while a freshly deployed site is still propagating.
 * A CDN that has not caught up is not the same failure as a site that serves
 * the wrong content, so transient failures are retried and real ones are not
 * hidden by them.
 *
 * @param {string} baseUrl
 * @param {{retries?: number, retryDelayMs?: number, log?: (message: string) => void}} [options]
 */
export async function verifyLive(baseUrl, options = {}) {
  const retries = options.retries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 3000;
  const log = options.log ?? (() => {});

  let attempt = 0;
  /** @type {Awaited<ReturnType<typeof checkLiveSite>> | null} */
  let result = null;
  while (attempt < Math.max(1, retries)) {
    attempt += 1;
    result = await checkLiveSite(baseUrl);
    if (result.ok) {
      log(`live site is serving the build (attempt ${attempt}): ${baseUrl}`);
      return result;
    }
    if (attempt < retries) {
      log(`live check attempt ${attempt} failed, retrying in ${retryDelayMs}ms:\n  ${result.failures.join("\n  ")}`);
      await delay(retryDelayMs);
    }
  }
  log(`live site is not serving the build after ${attempt} attempt(s):\n  ${result?.failures.join("\n  ")}`);
  return result;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[token.slice(2)] = "true";
    else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

const isMain = process.argv[1]?.endsWith("verify-live.mjs");

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const url = typeof args.url === "string" ? args.url : undefined;
  if (!url) {
    process.stderr.write(
      "usage: node src/verify-live.mjs --url https://<owner>.github.io/<repo>/ [--retries 5] [--retry-delay-ms 3000]\n" +
        "  The URL is the Pages site root, with the base path (for a project site, include /<repo>/).\n",
    );
    process.exit(2);
  } else {
    const outcome = await verifyLive(url, {
      retries: args.retries ? Number(args.retries) : undefined,
      retryDelayMs: args["retry-delay-ms"] ? Number(args["retry-delay-ms"]) : undefined,
      log: (message) => process.stdout.write(`${message}\n`),
    });
    if (!outcome?.ok) {
      process.stderr.write(`live verification failed for ${url}\n`);
      process.exit(1);
    }
    process.stdout.write(`verified ${LIVE_CHECKS.length} live paths at ${url}\n`);
  }
}