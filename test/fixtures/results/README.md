/**
 * Fixture results are NOT measurements.
 *
 * These files exist so `npm run verify` can prove the generator renders every
 * section (charts, deltas, changelog, empty state, 404) without a live
 * benchmark machine. They are built into `.verify/`, never into `dist/`, and
 * `data/results/` — the only directory the published build reads — stays empty
 * until the real harness writes into it.
 *
 * Fixture files are named `fixture-*` and every machine label says "(fixture)"
 * so a fixture can never be mistaken for a measurement, on screen or in a diff.
 */

Test files here:

| file | what it exercises |
| --- | --- |
| `cold-start-merged-pr-42.json` | first row in a series: baseline, no delta, p50/p95 chart |
| `cold-start-merged-pr-57.json` | an improvement, so a negative delta renders |
| `time-to-render-merged-pr-61.json` | a second benchmark on the same machine |
| `time-to-render-merged-pr-74.json` | a second improvement in the same series |
| `cold-start-unmerged.json` | `pr: null`, so it is excluded from leaderboard rows |

When you add a fixture, keep the shape identical to a real result file (see
`src/schema.mjs`) and add a row to the table above.
