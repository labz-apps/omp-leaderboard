# oh-my-pi leaderboard

Public record of oh-my-pi's cold start and time-to-render performance, and of
every merged improvement that was measured to produce it.

- **No server.** The site is plain HTML, CSS, and one small script. No
  framework, no bundler, no runtime data fetching, no dependencies.
- **No hand-entered numbers.** Every value on the page is read from a harness
  result file in [`data/results/`](data/results). Deltas are computed at build
  time from two provenanced runs and are never stored anywhere.
- **Every row traces to a merged PR**, a commit, a named machine, the versions
  involved, and the exact harness command that produced the measurement.
- **Comparability is enforced, not assumed.** Runs are only ever compared to
  other runs of the same benchmark on the same machine. Deltas never cross
  machines, and the machine spec is printed next to every series.

## Pages

| page | what it shows |
| --- | --- |
| `index.html` | Leaderboard: per machine, a p50/p95 history chart plus a row per merged PR |
| `changelog.html` | Every measured improvement, newest first: what changed, the measured delta, the PR link |
| `404.html` | Fallback with working links (the only page that uses the configured base path) |
| `data/leaderboard.json` | The same data, machine-readable, for diffing results without scraping HTML |

Both main pages reference their assets relatively (`./assets/styles.css`), so
the same build works at a domain root, at `https://<owner>.github.io/<repo>/`,
or under any other prefix. `npm run verify` fails the build if that ever stops
being true.

## Commands

There is no install step: nothing to fetch, nothing to build.

```bash
npm run build     # generate dist/ from data/results/
npm run verify    # the full gate (see below)
npm test          # unit tests only
npm run serve     # serve dist/ locally at http://127.0.0.1:4321/
```

### `npm run verify`

This is the local stand-in for "the Pages site serves". It runs, in order:

1. unit tests;
2. a build from the committed fixtures, so every code path (charts, deltas,
   changelog, empty state, 404) is exercised without a benchmark machine;
3. an assertion that every row traces to a merged PR, a commit, a machine, a
   run id, and a harness command;
4. an assertion that no result file carries a hand-written `delta`;
5. an assertion that every local asset reference on both pages is relative;
6. a real HTTP server mounted at `/omp-leaderboard/` serving the build,
   checking `/`, both pages, every asset, the JSON, and the 404 fallback;
7. a build from an empty result set, proving the site degrades gracefully;
8. builds from a synthetic result and an unprovenanced result, both of which
   must fail;
9. a check that fixture data can never reach `dist/`.

Fixtures build into `.verify/`, never into `dist/`.

## Deploying to GitHub Pages

One-time setup, in the repository settings: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. Nothing else is required; the workflow
supplies the artifact.

`main` → `.github/workflows/pages.yml`:

```
push to main  →  npm run verify  →  node src/build.mjs --base "$BASE_PATH"  →  upload-pages-artifact  →  deploy-pages
```

`BASE_PATH` comes from `actions/configure-pages`, so a project site at
`https://<owner>.github.io/<repo>/` works with no configuration. Pushes to
`main` and manual `workflow_dispatch` runs both publish. Pull requests do not
publish: `.github/workflows/validate.yml` runs the identical verification and
fails the PR if a result file is malformed or the site would break.

Pages serves `dist/` verbatim. `dist/.nojekyll` is written so Jekyll does not
strip any path, and there is no 404 redirect trick — every real page is a real
file.

## Adding a measurement

The loop, end to end:

1. In the oh-my-pi fork, measure the commit with the harness (one documented
   command, see the harness repo) and let it emit JSON.
2. Import the JSON here. It is validated on the way in and again on every build:

   ```bash
   bun scripts/bench/cold-start.ts --json | npm run import-result -- --stdin --pr 1234
   ```

   or, for a merged PR whose measurement you already have as a file:

   ```bash
   npm run import-result -- --file ~/cold-start-1234.json --pr 1234
   ```

3. Open a pull request. `validate.yml` re-checks it; merging publishes it.

Or skip the local steps entirely and let CI do it: run the
**record-result** workflow with the fork, ref, benchmark, merged PR number and
PR title. It runs the harness in CI, pipes the output into the importer, and
opens the pull request for you.

A run with no `pr` is imported but never rendered as a leaderboard row. It
appears in an "Awaiting merge" section instead, and becomes a row once a PR is
recorded. Re-run the import with `--pr <number>` after the merge.

## The result file contract

The contract lives in [`src/schema.mjs`](src/schema.mjs) and is enforced at
import time and at build time. A file that violates it fails the build; it is
never skipped silently.

```jsonc
{
  "schemaVersion": 1,
  "runId": "cold-start-2026-01-05T090412Z-3f9a1c",   // harness run identifier
  "benchmark": "cold-start",                          // or "time-to-render"
  "startedAt": "2026-01-05T09:00:00.000Z",
  "finishedAt": "2026-01-05T09:04:12.000Z",
  "commit": {
    "sha": "1111111...",                               // what was measured
    "repo": "labz-apps/oh-my-pi",
    "message": "perf(coding-agent): drop the startup animation"
  },
  "pr": {                                             // null until it is merged
    "number": 42,
    "url": "https://github.com/labz-apps/oh-my-pi/pull/42",
    "title": "perf(coding-agent): drop the startup animation",
    "mergedAt": "2026-01-05T09:03:00.000Z"
  },
  "machine": {                                        // the comparison basis
    "id": "linux-x86-8c",                             // stable; series never mix machines
    "cpuModel": "AMD EPYC 7B12",
    "physicalCores": 8,
    "memoryGb": 16,
    "os": "Ubuntu 24.04",
    "arch": "x86_64"
  },
  "versions": { "ohMyPi": "18.4.9", "runtime": "bun", "runtimeVersion": "1.2.21" },
  "harness": {
    "version": "1",                                   // bump when measurement semantics change
    "command": "bun scripts/bench/cold-start.ts --runs 20",
    "config": { "runs": 20, "warmupRuns": 2, "coldCache": true }
  },
  "metrics": {
    "firstInteractiveFrameMs": {
      "unit": "ms",
      "p50": 1180.4,
      "p95": 1642.9,
      "samples": 20,
      "min": 1042.1,
      "max": 1701.6
    }
  }
}
```

Rules the build enforces:

| rule | what happens if it is broken |
| --- | --- |
| commit sha, repo, machine id, versions, harness version and command are present | build fails |
| metrics carry `p50`, `p95`, `samples`, and `p95 >= p50` | build fails |
| `pr.url` is https and `pr.mergedAt` is a timestamp | run is accepted but is not a leaderboard row |
| `synthetic: true` | build fails |
| a `delta` field in a result file | build fails (deltas are computed, not stored) |
| `finishedAt` before `startedAt` | build fails |

## How deltas are computed

Within a series (one benchmark, one machine), sorted by finish time, each run's
delta is measured against **the immediately preceding run in that series**.
Positive means slower; negative means faster. The first run in a series has no
baseline and shows no delta rather than comparing against itself.

This is a deliberate constraint: the site claims exactly one comparison per
row, and that comparison is always between two runs of the same benchmark on
the same machine. It does not claim a percentage against some unrelated
default.

## Repository layout

```
data/results/        the only source of numbers the site will render
src/schema.mjs       the result contract, enforced at import and at build
src/deltas.mjs       comparability rules and delta computation
src/build.mjs        static generator (the deploy entry point)
src/render.mjs       page rendering, including every empty state
src/verify.mjs       the gate described above
src/serve.mjs        a static server that mimics the GitHub Pages behaviour we rely on
bin/import-result.mjs  validate-and-write importer
test/fixtures/       fixture results, built into .verify/ and never into dist/
```

## License

MIT. See [LICENSE](LICENSE).
