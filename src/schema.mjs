/**
 * Data contract for benchmark results.
 *
 * Every row the leaderboard renders comes from a file in `data/results/` that
 * satisfies this contract. The build fails closed: a file that is malformed,
 * unprovenanced, or marked synthetic never reaches the site.
 *
 * The contract is the shared boundary between the harness (OHM-3, which
 * produces measurements inside the oh-my-pi fork) and this site (which only
 * consumes them). Nothing in this site may invent, edit, or interpolate a
 * measurement: deltas are computed here from two provenanced runs.
 */

export const SCHEMA_VERSION = 1;

export const BENCHMARKS = /** @type {const} */ ({
  COLD_START: "cold-start",
  TIME_TO_RENDER: "time-to-render",
});

/**
 * The build type a run measured: what program was launched.
 *
 * The contract holds build type constant inside a series, so it has to be a
 * recorded field. A source run (`bun scripts/bench/...`), the published npm
 * bundle, and a compiled binary are three different programs; a series key that
 * omits this field can fold all three into one comparison.
 */
export const BUILD_TYPES = /** @type {const} */ ({
  SOURCE: "source",
  BUNDLE: "bundle",
  BINARY: "binary",
});

export const BUILD_TYPE_LIST = Object.values(BUILD_TYPES);

export const BUILD_TYPE_LABELS = {
  [BUILD_TYPES.SOURCE]: "source run",
  [BUILD_TYPES.BUNDLE]: "npm bundle",
  [BUILD_TYPES.BINARY]: "compiled binary",
};

export const BENCHMARK_LABELS = {
  [BENCHMARKS.COLD_START]: "Cold start",
  [BENCHMARKS.TIME_TO_RENDER]: "Time to render",
};

export const BENCHMARK_DESCRIPTIONS = {
  [BENCHMARKS.COLD_START]:
    "Process launch to first interactive frame: spawn the binary, wait for the TUI to accept input and paint a frame that responds to it.",
  [BENCHMARKS.TIME_TO_RENDER]:
    "Input to painted frame: submit an input event in a live TUI session and time until the resulting frame is painted. Reported as p50/p95 over samples.",
};

export class ValidationError extends Error {
  /**
   * @param {string} source
   * @param {string[]} problems
   */
  constructor(source, problems) {
    super(`${source}: ${problems.length} schema problem(s)\n  - ${problems.join("\n  - ")}`);
    this.name = "ValidationError";
    this.source = source;
    this.problems = problems;
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && ISO_RE.test(value);
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} doc
 * @param {string} [source] label used in error messages
 * @returns {{ok: true, doc: Record<string, any>} | {ok: false, problems: string[]}}
 */
export function validateResultDoc(doc, source = "result") {
  /** @type {string[]} */
  const problems = [];
  const push = (message) => problems.push(message);

  if (!isPlainObject(doc)) {
    return { ok: false, problems: ["result must be a JSON object"] };
  }

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    push(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(doc.schemaVersion)})`);
  }

  if (doc.synthetic === true) {
    push("synthetic results are not publishable; regenerate with the real harness");
  }

  if (typeof doc.runId !== "string" || doc.runId.trim() === "") {
    push("runId must be a non-empty string (harness run identifier)");
  }

  if (typeof doc.benchmark !== "string" || !(doc.benchmark in BENCHMARK_LABELS)) {
    push(`benchmark must be one of ${Object.keys(BENCHMARK_LABELS).join(", ")}`);
  }

  if (!isIsoTimestamp(doc.finishedAt)) {
    push("finishedAt must be an ISO-8601 timestamp");
  }
  if (!isIsoTimestamp(doc.startedAt)) {
    push("startedAt must be an ISO-8601 timestamp");
  }
  if (isIsoTimestamp(doc.startedAt) && isIsoTimestamp(doc.finishedAt)) {
    if (Date.parse(doc.finishedAt) < Date.parse(doc.startedAt)) {
      push("finishedAt must not precede startedAt");
    }
  }

  // --- commit provenance -------------------------------------------------
  if (!isPlainObject(doc.commit)) {
    push("commit is required (sha, repo)");
  } else {
    if (typeof doc.commit.sha !== "string" || !SHA_RE.test(doc.commit.sha)) {
      push("commit.sha must be a 7-40 character lowercase hex sha");
    }
    if (typeof doc.commit.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(doc.commit.repo)) {
      push("commit.repo must be an owner/name slug");
    }
    if (doc.commit.message !== undefined && typeof doc.commit.message !== "string") {
      push("commit.message must be a string when present");
    }
    // The tree the harness measured can move underneath it: a rebase landing in
    // the shared checkout, a branch switch, a `git pull`. `sha` alone records
    // what was true when the run started, so the harness also records the head
    // it saw at the end and the two must agree. A file that says otherwise is
    // two builds wearing one sha, and it fails rather than publishing a delta
    // against whichever half of it happens to be true.
    if (typeof doc.commit.shaAtFinish !== "string" || !SHA_RE.test(doc.commit.shaAtFinish)) {
      push(
        "commit.shaAtFinish is required (7-40 character lowercase hex): the head the harness saw when the run finished",
      );
    } else if (typeof doc.commit.sha === "string" && doc.commit.shaAtFinish !== doc.commit.sha) {
      push(
        `commit.shaAtFinish (${doc.commit.shaAtFinish}) differs from commit.sha (${doc.commit.sha}): the working tree moved during the run, so the measurement does not belong to one commit`,
      );
    }
  }

  // --- merged PR provenance ---------------------------------------------
  // `pr: null` is legal (a candidate measurement that has not merged yet) but
  // such runs are never rendered as leaderboard rows.
  if (doc.pr !== null && doc.pr !== undefined) {
    if (!isPlainObject(doc.pr)) {
      push("pr must be null or an object");
    } else {
      if (!Number.isInteger(doc.pr.number) || doc.pr.number <= 0) {
        push("pr.number must be a positive integer");
      }
      if (!isHttpsUrl(doc.pr.url)) {
        push("pr.url must be an https URL");
      }
      if (!isIsoTimestamp(doc.pr.mergedAt)) {
        push("pr.mergedAt must be an ISO-8601 timestamp");
      }
      if (typeof doc.pr.title !== "string" || doc.pr.title.trim() === "") {
        push("pr.title must be a non-empty string so the changelog can describe the change");
      }
    }
  }

  // --- machine provenance ------------------------------------------------
  if (!isPlainObject(doc.machine)) {
    push("machine is required (id, cpuModel, physicalCores, memoryGb, os, arch)");
  } else {
    if (typeof doc.machine.id !== "string" || doc.machine.id.trim() === "") {
      push("machine.id must be a non-empty stable identifier (results are never compared across machines)");
    }
    if (typeof doc.machine.cpuModel !== "string" || doc.machine.cpuModel.trim() === "") {
      push("machine.cpuModel is required");
    }
    if (!Number.isInteger(doc.machine.physicalCores) || doc.machine.physicalCores <= 0) {
      push("machine.physicalCores must be a positive integer");
    }
    if (!isFiniteNumber(doc.machine.memoryGb) || doc.machine.memoryGb <= 0) {
      push("machine.memoryGb must be a positive number");
    }
    if (typeof doc.machine.os !== "string" || doc.machine.os.trim() === "") {
      push("machine.os is required");
    }
    if (typeof doc.machine.arch !== "string" || doc.machine.arch.trim() === "") {
      push("machine.arch is required");
    }
    // The programme shares one checkout, and one machine, across agents. Two
    // runs of the same benchmark on the same machine that overlap in time share
    // CPU, so both numbers are worse and neither is comparable to anything. The
    // harness leases the machine for the duration of a run and records how many
    // same-benchmark runs it found active; 1 means it had the machine to itself.
    if (!Number.isInteger(doc.machine.concurrentRuns) || doc.machine.concurrentRuns < 1) {
      push(
        "machine.concurrentRuns is required (integer >= 1): same-benchmark runs active on this machine during this run, including this one",
      );
    }
  }

  // --- versions ----------------------------------------------------------
  if (!isPlainObject(doc.versions)) {
    push("versions is required (ohMyPi, runtime, runtimeVersion)");
  } else {
    if (typeof doc.versions.ohMyPi !== "string" || doc.versions.ohMyPi.trim() === "") {
      push("versions.ohMyPi is required");
    }
    if (typeof doc.versions.runtime !== "string" || doc.versions.runtime.trim() === "") {
      push("versions.runtime is required (node or bun)");
    }
    if (typeof doc.versions.runtimeVersion !== "string" || doc.versions.runtimeVersion.trim() === "") {
      push("versions.runtimeVersion is required");
    }
  }

  // --- harness provenance ------------------------------------------------
  if (!isPlainObject(doc.harness)) {
    push("harness is required (version, command)");
  } else {
    if (typeof doc.harness.version !== "string" || doc.harness.version.trim() === "") {
      push("harness.version is required (bump it when the harness changes measurement semantics)");
    }
    if (typeof doc.harness.command !== "string" || doc.harness.command.trim() === "") {
      push("harness.command must be the exact command that produced these numbers");
    }
    // Which program was launched. Held constant inside a series, so it is part
    // of the series key rather than a note: a source run, the npm bundle, and a
    // compiled binary are three different programs, and a delta between two of
    // them measures the packaging rather than the change.
    if (!BUILD_TYPE_LIST.includes(doc.harness.build)) {
      push(
        `harness.build is required and must be one of ${BUILD_TYPE_LIST.join(", ")} (got ${JSON.stringify(doc.harness.build ?? null)})`,
      );
    }
  }

  // --- metrics -----------------------------------------------------------
  if (!isPlainObject(doc.metrics) || Object.keys(doc.metrics).length === 0) {
    push("metrics must be a non-empty object of measurements");
  } else {
    for (const [name, metric] of Object.entries(doc.metrics)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
        push(`metrics.${name}: metric names must be camelCase identifiers`);
        continue;
      }
      if (!isPlainObject(metric)) {
        push(`metrics.${name} must be an object`);
        continue;
      }
      if (metric.unit !== "ms") {
        push(`metrics.${name}.unit must be "ms"`);
      }
      for (const stat of ["p50", "p95"]) {
        if (!isFiniteNumber(metric[stat]) || metric[stat] < 0) {
          push(`metrics.${name}.${stat} must be a non-negative finite number`);
        }
      }
      if (!Number.isInteger(metric.samples) || metric.samples <= 0) {
        push(`metrics.${name}.samples must be a positive integer`);
      }
      if (isFiniteNumber(metric.p50) && isFiniteNumber(metric.p95) && metric.p95 < metric.p50) {
        push(`metrics.${name}: p95 must be greater than or equal to p50`);
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, doc };
}

/**
 * Throwing variant used by the build and the importer.
 * @param {unknown} doc
 * @param {string} [source]
 */
export function assertValidResultDoc(doc, source = "result") {
  const result = validateResultDoc(doc, source);
  if (!result.ok) throw new ValidationError(source, result.problems);
  return /** @type {Record<string, any>} */ (result.doc);
}

/**
 * A run only becomes a leaderboard row when it traces to a merged PR.
 * @param {Record<string, any>} doc
 */
export function isPublishableRun(doc) {
  return isPlainObject(doc.pr) && typeof doc.pr.url === "string" && isIsoTimestamp(doc.pr.mergedAt);
}

/**
 * A run that shared its machine with another run of the same benchmark.
 *
 * The contract's answer to a noisy run is "record it, do not publish it", so a
 * contended run stays in `data/results/` as evidence and is excluded from the
 * leaderboard, the charts, the deltas, and the changelog. It must not become a
 * baseline either: the next run on that machine would be compared against a
 * number inflated by whoever was competing for the CPU.
 * @param {Record<string, any>} doc
 */
export function isContendedRun(doc) {
  return Number.isInteger(doc?.machine?.concurrentRuns) && doc.machine.concurrentRuns > 1;
}

/**
 * A run that may appear as a row and may serve as the next run's baseline:
 * merged PR recorded, and measured on a machine it had to itself.
 * @param {Record<string, any>} doc
 */
export function countsTowardSeries(doc) {
  return isPublishableRun(doc) && !isContendedRun(doc);
}

/** Human-readable reason a validated run is not a leaderboard row. */
export function unpublishableReason(doc) {
  if (isContendedRun(doc)) {
    return `measured on a contended machine (${doc.machine.concurrentRuns} same-benchmark runs were active), so it is recorded but never published`;
  }
  if (!isPublishableRun(doc)) {
    return "no merged PR yet, so it cannot appear as a leaderboard row";
  }
  return null;
}

/** Stable, human-readable short sha for display. */
export function shortSha(sha) {
  return typeof sha === "string" ? sha.slice(0, 7) : "";
}

/** Stable id used for DOM anchors and dedupe. */
export function resultId(doc) {
  return `${doc.benchmark}@${doc.machine.id}@${shortSha(doc.commit.sha)}@${doc.runId}`;
}
