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

## Reading the generated changelog

Each entry there carries the PR number and link, the exact commit, the machine,
the version, and the measured p50/p95 with the delta against the previous run
on that same machine. An improvement with no measurement does not appear.
