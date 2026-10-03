# The only source of numbers this site will render.

Every file here is a harness result that satisfies the contract in
[`src/schema.mjs`](../src/schema.mjs): the commit that was measured, the merged
pull request it belongs to, the machine, the versions, the exact harness
command, and the samples.

This directory is empty until the harness (OHM-3, in the oh-my-pi fork) has run
against a merged pull request. Until then the site builds, serves, and explains
that there is nothing to show yet — it does not fill the gap with an estimate,
a target, or a number from a README.

## Adding a file

Do not write one by hand. Pipe the harness output into the importer:

```bash
bun scripts/bench/cold-start.ts --json | npm run import-result -- --stdin --pr 1234
```

Or let CI do it: run the **record-result** workflow with the ref and merged PR
number, and it opens the pull request for you.

## What gets rejected

The importer and the build both validate, and both fail rather than skip:

- a missing commit sha, machine id, harness version, or harness command
- a missing `commit.shaAtFinish`, or one that differs from `commit.sha` — the
  tree moved while the run measured it, so the numbers belong to no single commit
- a missing `harness.build`, or one outside `source` / `bundle` / `binary`
- a missing `machine.concurrentRuns`, or one below `1`
- a run that overlaps another run of the same benchmark on the same machine —
  both were measured on a contended machine, so neither is comparable
- metrics without `p50`, `p95`, and `samples`, or with `p95 < p50`
- a non-https pull request URL
- `"synthetic": true`
- a `delta` field — deltas are computed at build time, never stored

A run whose `pr` is `null` is accepted but is not a leaderboard row. It shows up
under "Awaiting merge" until a merged PR is recorded for it.

A run whose `machine.concurrentRuns` is above `1` is also kept rather than
deleted, and is also never a leaderboard row: it shows under "Recorded, not
published" as evidence of a noisy run, and it is never used as the baseline for
the run after it.

Two build types on one machine are two series. The second one starts its own
history, the build prints the split, and no delta is computed across it.
