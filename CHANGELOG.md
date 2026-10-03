# Changelog

This file records changes to **the leaderboard site itself**.

The performance changelog — what changed in oh-my-pi, the measured delta, and
the merged PR that caused it — is **generated**, not written here. It lives at
[`changelog.html`](changelog.html) (and in `data/leaderboard.json`) and is built
from the harness result files in [`data/results/`](data/results). That is
deliberate: a hand-maintained list of performance numbers drifts from the
measurements within one release, and nobody can tell which entries were real.

## Unreleased

- Initial site: static generator with no runtime dependencies, inline SVG
  history charts, per-machine series, computed deltas, generated changelog,
  graceful empty state, and a Pages deploy workflow.
- `npm run verify` gates the deploy: unit tests, fixture build, relative-asset
  assertions, an HTTP serve check under a project Pages base path, an
  empty-data build, and rejection of synthetic or unprovenanced result files.
- Second publish path: `npm run deploy:gh-pages` publishes the same build to a
  `gh-pages` branch, and `gh-pages.yml` runs it on demand for repositories that
  cannot use the Actions Pages integration. Tested against a throwaway bare
  repository rather than described in prose.
- Workflow tests assert the deploy wiring, permissions, triggers, and that every
  script a workflow calls actually exists — the classic silent failure where a
  workflow calls a renamed script and only fails after merge.
- `npm run verify:live` checks a real URL over HTTP after the deploy, and runs
  as a post-deploy step in `pages.yml`. Added after Pages was found configured
  for branch builds: the deploy job reported success on every run while the live
  site served `README.md` and 404'd every built path.
- **Build type is now recorded and enforced.** `harness.build` is required and is
  one of `source`, `bundle`, `binary`; the schema and the importer refuse a file
  that does not say which program was measured, and it is part of the series key,
  so a source run and a compiled binary on one machine become two series with no
  delta between them instead of one misleading comparison. A machine that changes
  build type reports the split on the page. Measured delta: **none** — this
  touches no code on the startup or render path; it changes what the site is
  willing to claim. Pull request: [#2](https://github.com/labz-apps/omp-leaderboard/pull/2).
- **Run integrity is now recorded and enforced.** `commit.shaAtFinish` records
  the head the harness saw when the run ended and must equal `commit.sha`, so a
  measurement of a tree that moved underneath it (a rebase landing in the shared
  checkout) is refused instead of published under a sha it does not describe.
  `machine.concurrentRuns` records how many same-benchmark runs were active on
  that machine: above `1` the run is imported, kept as evidence, and never
  published or used as a baseline. Two runs of one benchmark on one machine id
  whose measurement windows overlap now fail the build. Measured delta: **none**,
  for the same reason.
- Tests and gate: seven new fixture-driven checks (build-type split, contended
  run, moved tree, overlapping pair, missing build type) plus an end-to-end
  importer test, all run by `npm run verify` and by CI on every pull request.

The matching contract text lives in
[`labz-apps/omp-org-ops`](https://github.com/labz-apps/omp-org-ops/blob/main/docs/measurement-contract.md),
which gained the same two rules and the enforcement table that names them.

## Reading the generated changelog

Each entry there carries the PR number and link, the exact commit, the machine,
the version, and the measured p50/p95 with the delta against the previous run
on that same machine. An improvement with no measurement does not appear.
