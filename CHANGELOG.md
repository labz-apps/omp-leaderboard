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

## Reading the generated changelog

Each entry there carries the PR number and link, the exact commit, the machine,
the version, and the measured p50/p95 with the delta against the previous run
on that same machine. An improvement with no measurement does not appear.
