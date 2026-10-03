#!/usr/bin/env node
/**
 * Import a harness result into `data/results/`.
 *
 * The point of this script is that numbers are never typed. It takes the JSON
 * a harness run emits, validates it against the published contract, and writes
 * it into the only directory the build reads. Anything malformed, synthetic, or
 * missing provenance is refused.
 *
 * Usage:
 *   npm run import-result -- --file /path/to/result.json
 *   bun scripts/bench/cold-start.ts --json | npm run import-result -- --stdin --pr 12345
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationError, assertValidResultDoc, shortSha } from "../src/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Attach the merged-PR provenance the harness cannot know by itself. These come
 * from the merged pull request, so they are recorded rather than measured.
 */
function applyPrProvenance(doc, args) {
  const number = args.pr ? Number(args.pr) : NaN;
  if (!Number.isInteger(number) || number <= 0) return doc;
  const repo = args.repo ?? doc.commit.repo;
  return {
    ...doc,
    pr: {
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      title: args["pr-title"] ?? doc.commit.message?.split("\n")[0] ?? `PR #${number}`,
      mergedAt: args["pr-merged-at"] ?? doc.finishedAt,
    },
  };
}

function filenameFor(doc) {
  return `${doc.benchmark}-${shortSha(doc.commit.sha)}-${doc.runId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
}

const args = parseArgs(process.argv.slice(2));
const resultsDir = resolve(repoRoot, typeof args.results === "string" ? args.results : "data/results");

try {
  if (args.file === "true" || args.file === undefined) {
    process.stderr.write("usage: npm run import-result -- --file <result.json> | --stdin [--pr <number>]\n");
    process.exitCode = 2;
  } else {
    const raw =
      args.stdin === "true" || args.file === "-"
        ? await readStdin()
        : await readFile(args.file, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`input is not valid JSON: ${error.message}`);
    }
    const doc = assertValidResultDoc(applyPrProvenance(parsed, args), args.file ?? "<stdin>");

    await mkdir(resultsDir, { recursive: true });
    const target = join(resultsDir, filenameFor(doc));
    await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

    process.stdout.write(`wrote ${target}\n`);
    process.stdout.write(
      doc.pr
        ? `  ${doc.benchmark} · ${doc.machine.id} · PR #${doc.pr.number} · p50 ${Object.values(doc.metrics)[0].p50} ms\n`
        : `  ${doc.benchmark} · ${doc.machine.id} · no merged PR recorded, so it will not be a leaderboard row\n`,
    );
    if (doc.pr === null) {
      process.stdout.write("  next: reopen with --pr <number> once the pull request merges\n");
    }
  }
} catch (error) {
  if (error instanceof ValidationError) {
    process.stderr.write(`refusing to import: ${error.message}\n`);
  } else {
    process.stderr.write(`import failed: ${error.message}\n`);
  }
  process.exitCode = 1;
}
