# Agastya Kukudala — interactive systems portfolio

A fully static site: `npm run build` produces `dist/`, which any static host can
serve (it is set up for Cloudflare Pages, free tier). There is no server, no
database, no API key, and no scheduled job. Both project demos run entirely in
the visitor's browser:

- **InsiderPulse** loads a bundled historical dataset of real SEC Form 4
  filings and re-runs the original purchase filter, clustering and scoring
  (ported from Python to JavaScript) in a Web Worker.
- **AsterKV** is an interactive Raft simulation: three nodes, each in its own
  Web Worker, exchanging messages the page routes between them.

The original Python and Go engines stay in `vendor/` as project source and
optional local tooling. The website never calls them.

The portfolio is a light, off-white interface with a single icy-blue accent. The header carries six links — Home, Projects, Fluid Dynamics, Resume, GitHub (outbound) and Contact — and mobile uses a collapsible menu. The two interactive labs are reached from Projects rather than from the header. Experience describes verified project work, not invented employment.

Resume content lives in `src/content/resume.js` as structured data; editing that file is the only step needed to update the Resume page. Identity, navigation and outbound links live in `src/content/site.js`.

### Frontend structure

```
src/
  main.js                bootstrap: builds the nav, starts the router
  nav.js                 header nav + accessible Projects dropdown
  router.js              hash router with render/mount/destroy per view
  data.js                pure helpers: filtering, sorting, formatting, URL allowlist, escaping
  content/site.js        identity, nav links, lab metadata and explanations
  content/resume.js      structured resume content
  components/explainer.js  plain-English / technical pair shown on each lab
  fx/index.js            picks the water backend
  fx/water-gl.js         WebGL2 fluid simulation (primary)
  fx/water.js            Canvas 2D approximation (fallback)
  insider/analysis.js    InsiderPulse filter, cluster and score rules, ported from Python
  insider/worker.js      loads a dataset and runs the analysis off the main thread
  sim/raft-core.js       Raft node + key-value state machine, ported from AsterKV's Go
  sim/node-host.js       runs one node for a host (worker or test harness)
  sim/node-worker.js     the Web Worker entry: one per simulated node
  sim/cluster.js         page-side network, per-node saved state, retrying client
  views/                 one module per route (the two labs are lazy-loaded)
  styles/                tokens, base, layout, pages, labs
```

### Navigation

`Projects` is a dropdown listing both labs. It is a disclosure button with
`aria-expanded` controlling a list of links — operable with Enter/Space,
Arrow keys, Home/End and Escape, closed by clicking away or moving focus out.
On mobile it expands inline inside the existing header panel rather than
floating. Every lab route marks `Projects` as the current section.

### Explaining each lab

Each entry in `labs` (`src/content/site.js`) carries a `plain` and a
`technical` sentence. Both labs and the Projects page render them together, so
the plain-English version is never buried under the architecture summary. The
detailed caveats (where the SEC data came from and how old it is, what the
simulation is and is not) live in disclosures beside the status line rather
than in it.

`src/styles/tokens.css` holds every colour in the design system; nothing below it hard-codes one. The canvas reads its two colours from the same tokens (`--fx-accent`, `--fx-ice`). Body-copy text/background pairs meet WCAG AA.

### Home-page water

`src/fx/water-gl.js` is a GPU fluid simulation: a damped 2D wave equation solved
on a float texture ping-ponged between two framebuffers, shaded from normals
derived from the resulting heightfield. Dragging presses the surface down along
the pointer's path with a lift behind it (the wake); ripples then expand,
interfere and decay because the equation says so. Specular highlights are
Blinn-Phong on the crests; caustics come from the Laplacian, which the physics
pass already computes.

The canvas is fixed behind the whole Home page with `pointer-events: none`, so
it reads the pointer from the document and links above it stay clickable.

Performance: a fixed 1/120 s timestep (max 3 substeps) decoupled from frame
rate, a simulation grid sized by device tier, and a render-resolution ladder
that steps down under sustained slow frames and back up when they recover, with
hysteresis to prevent oscillation. Waves are bounded by damping and swallowed by an absorbing
boundary, so they never reflect off the viewport edges. The loop releases
entirely four seconds after the last disturbance. Measured 60 FPS at full quality on an Apple M5; under
SwiftShader (software, no GPU) the ladder settles around 40 FPS.

`src/fx/water.js` is the fallback for browsers without WebGL2 or float render
targets — a Canvas 2D spring-chain wake with shed wavelets, same pointer
behaviour and the same teardown contract. `src/fx/index.js` chooses between
them. The **Fluid Dynamics** page documents both with the actual constants.

The water runs on every page except the two labs, where `src/main.js` tears it
down (framebuffers, programs, listeners) so it does not compete with the demos'
workers. It needs only static assets.

## Running locally

```sh
npm ci
npm run dev          # http://127.0.0.1:5173
```

Node 20.19+ or 22.12+ (Vite 7). `.node-version` pins 22 for Cloudflare Pages.
No Python, Go or Docker is needed to run or build the site.

## Tests

```sh
npm test             # analysis equivalence, Raft simulation, helpers (node --test)
npm run build
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist &   # any static server
npm run check:browser                                             # Playwright, against dist/
```

- `tests/insider-analysis.test.mjs` runs the JavaScript analysis over the full
  bundled dataset and requires every signal (cluster size, score, score text,
  related filings, float totals) to equal what the Python engine exported, and
  checks the aggregate statistics against values printed by the original pandas
  code.
- `tests/raft.test.mjs` drives the real simulation code (node, host and
  controller) on a virtual clock with in-process stand-ins for workers, so every
  run is deterministic. It covers election, commit, follower catch-up, leader
  failover, loss of majority, an isolated stale leader, conflicting-entry
  truncation, vote refusal, CAS, request dedup, reset/destroy cleanup, and a
  seeded randomized fault run that checks one-leader-per-term, agreement on
  committed prefixes and that no acknowledged write is ever lost.
- `scripts/browser-check.mjs` loads the production build from a plain static
  server and exercises both labs, navigation, mobile layout, reduced motion,
  worker cleanup on route changes, and asserts that no backend, SEC or
  market-data request is made. Screenshots land in `docs/screenshots/`.

## InsiderPulse in the browser

`public/insider-cache.json` (historical) and `public/insider-sample.json`
(synthetic, from the parser tests) are static files. The page fetches the
selected one only when the lab is opened; a Web Worker parses it and runs
`src/insider/analysis.js` over **all** rows, then compares its signals with the
ones the Python engine exported and reports the result in the status line
("47 signals re-scored in your browser · all 47 match"). Explorer filters
(company, dates, code, "qualifying only", "clusters only", sort) change only
which rows are listed, never the analysis.

The port follows `filters.py`, `clusters.py` and `scoring.py` rule for rule,
including Python details that change output: CPython 3.12+ `sum()` uses
compensated summation (a naive JS sum differs in the last bit on real filings),
and `f"{x:,.0f}"` rounds exact halves to even.

Backtests are **shown, not recomputed.** The 135 stored results come from the
Python backtester and Yahoo Finance adjusted closes. The raw price series are
not bundled (redistributing provider data needs a terms review), so the browser
cannot run new backtests; the UI says so. The page never contacts the SEC or a
market-data provider.

### Updating the dataset

Data refreshes happen on your machine, then you redeploy:

```sh
python3 -m venv .venv && .venv/bin/pip install -r vendor/insiderpulse/requirements.txt
cd vendor/insiderpulse
export INSIDERPULSE_USER_AGENT='Your Name you@example.com'   # SEC requires a real contact
../../.venv/bin/python main.py run                           # original CLI: collect, score, backtest, report
cd ../..
.venv/bin/python scripts/export_cache.py vendor/insiderpulse/data/insiderpulse.db
npm test && npm run build                                    # equivalence test must pass
git commit -am "Update InsiderPulse dataset" && git push     # Pages rebuilds on push
```

`export_cache.py` opens the source database read-only, backs it up to
`data/insiderpulse/` (git-ignored), and writes `public/insider-cache.json` with
retrieval timestamps and the source SHA-256, which the page shows under "Where
this data came from". Tests that pin values from the current file skip
automatically after a re-export; the engine-equivalence test always runs.
The re-export was checked on 2026-09-21 in a scratch copy: identical
transactions, signals and backtests to the committed file.

## AsterKV in the browser

The lab is labelled **Browser simulation** and links to the Go repository. It
is a JavaScript re-implementation of AsterKV's `internal/raft` (election, vote
rules, AppendEntries log matching, the current-term commit rule, leader no-op
entry) and `internal/state` (PUT/GET/DELETE/CAS with request dedup). It does not
run the Go code.

- **Ownership.** Each node's term, vote, log, commit index and applied key-value
  map live only inside its worker. The page routes messages and keeps each
  node's *saved record* (what the node asked to persist), which it hands back
  only to that node on restart. Persist messages are posted before the messages
  they cover, mirroring Go's "save the vote before granting it".
- **Stop / restart** terminates the worker (a crash: volatile state is lost)
  and boots a new one from the saved record; it replays committed entries and
  catches up from the leader.
- **Isolate** drops node-to-node messages for that node; the browser client can
  still reach it, which is how you see a stale leader fail to confirm writes.
- **Message delay** (0–500 ms) applies to every message.
- **Reads** go through the log, as in the Go server, so a read reflects every
  write committed before it and a leader without a majority cannot answer.
- **Client** retries like `internal/client.Client.Do`: one request ID for all
  attempts, follows leader hints, 8-second deadline. A timeout is reported as
  "outcome unknown", never as success; "Retry the same request" reuses the ID.
- **Reset** terminates all workers, cancels every timer and clears saved state.
  Leaving the page does the same. Saved state is in-memory only; nothing
  survives a reload and the page does not claim otherwise.

Differences from the Go engine: `postMessage` instead of gRPC, no snapshots or
log compaction, no disk, timers about 6× slower (300 ms heartbeat, 1.5–3 s
election timeout) so they can be watched, and a `deduplicated` flag on replayed
results for display.

## Deploying to Cloudflare Pages

Nothing has been deployed. When you are ready:

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**,
   choose `AgiKukudala/portfolio`.
3. Build settings:
   - Framework preset: **None** (or Vite)
   - Root directory: *(repository root, leave empty)*
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variable (optional, `.node-version` already pins it): `NODE_VERSION` = `22`
4. **Save and Deploy.** Every push to the production branch redeploys.

No environment secrets are required. Routing is hash-based (`/#asterkv`), so no
SPA rewrite rules are needed and direct links and reloads work.
`public/_headers` gives hashed assets a one-year immutable cache. The largest
file is the 2.3 MB dataset, well under Pages' 25 MiB per-file limit. The only
third-party request is Google Fonts.

## Optional local tooling (not used by the website)

The original engines and the HTTP adapters from the earlier version remain for
local research: `vendor/insiderpulse` (Python CLI, `lab_api.py`),
`vendor/asterkv` (Go nodes, `cmd/gateway`), `scripts/local_stack.py`,
`scripts/run-local.sh`, `compose.yaml`, `nginx.conf` and `Dockerfile`. The site
no longer calls `/insider-api` or `/aster-api`, and the Vite dev proxy for them
was removed. Their own tests:

```sh
.venv/bin/python -m pytest vendor/insiderpulse/tests tests/test_adapter.py -q
.venv/bin/python scripts/verify_cached_analysis.py
(cd vendor/asterkv && go test -race -count=1 ./...)
```

Pinned upstream revisions are in [docs/sources.json](docs/sources.json);
verification results in [docs/verification.md](docs/verification.md).
