# Coverage — what is measured, and what is (not) proven

This note documents how the §7.7 suites (NFR-028) produce a coverage number,
which number is the *application* number, and — plainly — what this delivery
does and does not prove about CI execution. It is referenced from
`.github/workflows/ci.yml`.

## Two coverage artifacts, two very different meanings

The §7.7 suites (`task-046` unit/integration, `task-047` end-to-end) are
**black-box**: every assertion drives the *running application* over HTTP and
almost nothing is imported from `src/` into the test process. That single fact
determines what each coverage artifact can possibly measure.

| Artifact | Produced by | What it actually covers |
|----------|-------------|-------------------------|
| `coverage/lcov.info` | `npm run test:coverage` — Node in-process `--experimental-test-coverage` over the test process | **The test harness only** (`task-046/helpers/*.ts`). Node's in-process coverage instruments modules the *test* process imports; a black-box HTTP suite imports the harness, not `src/`. This file legitimately contains ~3 `SF:` records, all `task-046/helpers/*` — and **zero `src/` records**. It is a real report of the wrong thing for measuring the app. |
| `coverage/src-lcov.info` | `npm run coverage:src` — `scripts/coverage-report.mjs`, from the server-side V8 profile | **The application (`src/`).** This is the real application coverage number. |

The delivered `coverage/lcov.info` only ever reflected the harness, for the
reason above. It is retained (it is a truthful node:test report), but it is
**not** the application coverage number and must never be cited as one.

## How real `src/` coverage is measured

The application code executes in the **server process**, not the test process.
CI starts that server under Node's `NODE_V8_COVERAGE`:

```
NODE_V8_COVERAGE=coverage/server-v8 npm run start
```

While the black-box §7.7 suites exercise the running app over HTTP, V8 records
which byte ranges of the server's modules executed, and writes raw
`coverage/server-v8/coverage-*.json` on graceful shutdown (hence CI stops the
server with SIGINT and waits — a hard kill loses the profile).

`scripts/coverage-report.mjs` renders that raw profile into a human-readable,
`src/`-scoped report:

```
npm run coverage:src
# -> reads coverage/server-v8/*.json
# -> writes coverage/src-lcov.info  (+ prints a line/function summary)
```

It is **dependency-free** (Node builtins only — the delivery dependency tree
stays frozen; no `c8`/`monocart` added). It converts each V8 block range
(byte offsets into the tsx/Next-transpiled JS) to generated `(line, col)` via
the `source-map-cache` `lineLengths`, then remaps to the original `src/` line
through the v3 source map (VLQ-decoded in-script), and accumulates per-line and
per-function coverage.

### Method and its limits (stated honestly)

- **Line coverage** is a faithful *covered-or-not* model: a `src/` line is
  executable if any source-map mapping lands on it, and hit if the innermost V8
  range over that mapping's generated offset has `count > 0`. It is **not**
  statement/branch-accurate the way istanbul is. Treat the line percentage as a
  sound "was this line exercised" signal, not a branch metric.
- **Function coverage** uses V8's per-function entry counts. Transpile-emitted
  export-binding wrappers (esbuild's `() => fn` getters, which V8 names after
  the real function) are discarded by keeping the widest-range record and its
  own count, so a getter that runs during import cannot masquerade as the real
  function executing.

## What is PROVEN vs. what is a DELIVERY LIMITATION

**Proven on the delivery machine.** The configuration is *capable* of producing
real `src/` coverage. Demonstrated by capturing a small server-style V8 profile
(a script importing the pure `src/lib/pure/*` modules under
`NODE_V8_COVERAGE`) and rendering it with the delivered
`scripts/coverage-report.mjs`: the output contains real `SF:src/lib/...`
records with non-zero line and function coverage (e.g. `workflow.ts`,
`public-tools.ts`, `qualification.ts`, `urla-validation.ts`, and their
transitive imports). The rendering path works.

**NOT proven — documented delivery limitations, not closed items:**

1. **CI now executes (public repo), and the `src/` coverage number is still not
   produced by it.** UPDATE 2026-09-06: the build was published to the public
   `brightmeld-org/mortmortgage-rebuilt` repo and GitHub Actions now runs this
   workflow on every push. The §7.7 e2e suite passes there (87/87). The
   server-side V8 profile is now captured (the stop step flushes it via a
   process-group SIGINT to a directly-started `next start`). **But the coverage
   *render* still produces no `src/` number**, because a production `next build`
   emits no server source maps: the profile has 1000+ scripts with zero source
   maps to remap through (`scripts considered: N, with src map: 0`). The
   render step is therefore **non-blocking** (`continue-on-error`) — it runs and
   prints this finding but does not gate the suite. Closing it requires emitting
   server source maps in the production build, a separate build-config decision
   (weighed against build size and source exposure) — not yet taken.

2. **The full `src/` coverage percentage is not yet a measured number.** As
   above: even with a complete §7.7 + e2e run against the running app, the
   production build's lack of server source maps means the render yields no
   whole-application figure. The proof earlier in this doc establishes the
   *mechanism* on a small maps-bearing profile; the whole-app number awaits a
   maps-emitting production build.

In short: CI execution is now real and the suite is green; the coverage
*number* remains unproduced, blocked on server source maps in the production
build, and its render step is explicitly non-blocking until that decision.
