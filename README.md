# Agastya Kukudala — interactive systems portfolio

Local-only implementation in the previously empty `AgiKukudala/website` checkout. Nothing was pushed, provisioned, or published. The earlier portfolio/AsterKV brief was not present in this conversation; this implementation covers the supplied requirements and verified engine capabilities. `WebsiteDraft1` was inspected and is an unrelated calendar application.

The portfolio is a light, off-white interface with a single icy-blue accent. The header carries six links — Home, Projects, Fluid Dynamics, Resume, GitHub (outbound) and Contact — and mobile uses a collapsible menu. The two interactive labs are reached from Projects rather than from the header. Experience describes verified project work, not invented employment.

Resume content lives in `src/content/resume.js` as structured data; editing that file is the only step needed to update the Resume page. Identity, navigation and outbound links live in `src/content/site.js`.

### Frontend structure

```
src/
  main.js                bootstrap: builds the nav, starts the router
  nav.js                 header nav + accessible Projects dropdown
  router.js              hash router with render/mount/destroy per view
  api.js                 shared fetch wrapper (timeout, JSON, error shaping)
  data.js                pure helpers: filtering, formatting, URL allowlist, escaping
  content/site.js        identity, nav links, lab metadata and explanations
  content/resume.js      structured resume content
  components/explainer.js  plain-English / technical pair shown on each lab
  fx/index.js            picks the water backend
  fx/water-gl.js         WebGL2 fluid simulation (primary)
  fx/water.js            Canvas 2D approximation (fallback)
  views/                 one module per route
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
detailed caveats each lab used to print inline — what a reachability check does
and does not prove, where the SEC data came from and how stale it is — now live
in disclosures beside the status line rather than in it. They were shortened,
not dropped: the labs still refuse to imply more than the engines report.

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

## Running locally

```sh
./scripts/run-local.sh     # starts the AsterKV cluster + InsiderPulse adapter
npm run dev                # frontend at http://127.0.0.1:5173
```

`./scripts/run-local.sh stop` stops the backends. It reuses the prebuilt AsterKV
binaries in `data/`, so Go is not required, and starts each service
independently — unlike `scripts/local_stack.py`, which rebuilds with `go build`
and terminates every service when any one of them exits.

InsiderPulse needs its dependencies once:

```sh
python3 -m venv .venv && .venv/bin/pip install -r vendor/insiderpulse/requirements.txt
```

## Quick start (this machine)

```sh
cd /Users/agikukudala/projects/portfolio
npm ci --cache /private/tmp/portfolio-npm-cache
npm run dev
```

Open **http://127.0.0.1:5173**. Frontend alone includes authentic historical SEC records and an explicitly synthetic parser fixture. It makes no scheduled SEC requests. Offline lab services do not prevent browsing the portfolio.

In another terminal, choose one:

```sh
cd /Users/agikukudala/projects/portfolio
# AsterKV: gateway + three real, separately running Go nodes
GO_BIN=/Users/agikukudala/asterkv/.tools/go/bin/go ../../insiderpulse/.venv/bin/python scripts/local_stack.py asterkv
# InsiderPulse: original Python engine wrapped by the HTTP service
../../insiderpulse/.venv/bin/python scripts/local_stack.py insiderpulse
# Both labs
GO_BIN=/Users/agikukudala/asterkv/.tools/go/bin/go ../../insiderpulse/.venv/bin/python scripts/local_stack.py full
```

Ctrl-C stops the launcher’s children. It does not erase data. Dedicated lab directories avoid modifying the user's original research database or original cluster data. Frontend Vite proxies `/aster-api` to `127.0.0.1:8010` and `/insider-api` to `127.0.0.1:8011`. Nodes use loopback ports 5101–5103. Do not launch a second stack against the same ports/data.

For a fresh machine, install Node 22.12+ or 24, Go 1.26+, and Python 3.11+. Then:

```sh
python3 -m venv .venv
.venv/bin/pip install -r vendor/insiderpulse/requirements.txt
npm ci
# with Go on PATH:
.venv/bin/python scripts/local_stack.py full
# separate terminal:
npm run dev
```

The initial native cache copy is present under `data/insiderpulse` on this machine and ignored by Git. A fresh checkout's connected backend starts empty; the frontend's independent `public/insider-cache.json` remains available. Import a real original DB explicitly:

```sh
.venv/bin/python scripts/export_cache.py /absolute/path/to/insiderpulse.db
```

This backs up the source SQLite database without editing it, then generates the frontend artifact with original retrieval timestamps and a source SHA-256. Do not import untrusted or unbounded databases.

## Docker Compose

The Compose plugin is not installed in this environment, but the standalone `docker-compose` command is. These commands use it (else substitute `docker compose`). Start your Docker daemon first.

```sh
# frontend only
 docker-compose up --build frontend
# frontend + AsterKV
 docker-compose --profile asterkv up --build
# frontend + InsiderPulse
 docker-compose --profile insiderpulse up --build
# full stack
 docker-compose --profile asterkv --profile insiderpulse up --build
```

All expose the frontend at http://127.0.0.1:5173. Stop a native preview before using the same port. Node volumes are independent and persistent; InsiderPulse uses the persistent `./data/insiderpulse` bind mount. Health checks cover frontend, API, gateway, and each node's TCP listener. Node health means reachability, not quorum. Nginx resolves optional backends at request time, allowing the frontend to start with either profile absent. Only the frontend port is published, on loopback. **Configuration validated; images and container runtime not tested because the Docker daemon is stopped.**

## Live SEC ingestion

SEC access requires an identifying User-Agent with a real name and contact address. No SEC API key is needed. No identifying contact was available during implementation, so **fresh SEC ingestion was not executed**. Network access to GitHub succeeded; this does not establish SEC access.

Set these in your shell for native mode, or in a git-ignored `.env` for Compose:

```sh
export INSIDERPULSE_USER_AGENT='Your actual name your-monitored-email@your-domain'
export INSIDERPULSE_ENABLE_INGEST=1
export INSIDERPULSE_OPERATOR_TOKEN='your-own-random-secret'
```

Restart the API with that environment. Explicit operator ingestion:

```sh
curl -X POST http://127.0.0.1:8011/api/ingest \
  -H "Authorization: Bearer $INSIDERPULSE_OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"ticker":"UNH","start":"2025-05-01","end":"2025-05-31"}'
curl http://127.0.0.1:8011/api/status
```

For Compose, use `http://127.0.0.1:5173/insider-api/api/ingest` and `/insider-api/api/status`. The operator secret is never embedded in frontend code. Visitors cannot supply fetch URLs, run CLI commands, or trigger ingestion. The API has one ingestion worker, a shared SEC client, at least 250 ms between attempts, at most two retries, 10-second request timeouts, bounded backoff, 403 cooldown, at most 30 high-level upstream calls, a 120-second between-call job budget, one ticker, at most 31 days and 20 filings per job. A final in-flight request/retry can finish after the job budget. Individual responses are capped at 8 MB; parsed filings at 2 MB/1,000 rows. No redirects are followed. No scheduled scans are installed.

HTTP traffic is limited to 60 requests per minute per direct peer (behind Nginx, visitors share that conservative allowance), 2,048 tracked peers, 16 active handler threads, bounded bodies and result pagination. Ingestion stops at 50,000 existing transaction rows (one final bounded job can add rows) or SQLite's 64 MiB page budget. Cache eviction is deliberately not automatic; the operator must maintain full analysis context. Ticker cache is one file. The connected frontend polls active jobs for observed completed-filing counts; errors and partial/truncated jobs are explicit in `/api/status`. Legacy record timestamps lack a timezone; they are preserved without inventing UTC. New API retrieval timestamps are UTC.

The official guidance checked during implementation: [SEC developer resources](https://www.sec.gov/about/developer-resources) and [Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data). SEC limits aggregate automated access to 10 requests/second across machines. Run **one API instance** and coordinate other tools using the same egress IP. The in-process throttle is not a distributed limiter.

## What is original versus added

Pinned repositories/revisions are in [docs/sources.json](docs/sources.json). InsiderPulse public HEAD was verified against the local checkout. `vendor/` contains actual tracked engine code and MIT licenses, plus the new adapters. Original CLI commands remain usable.

Original InsiderPulse supports SEC ticker/CIK mapping, Form 4 listing/XML parsing, SQLite ingestion, purchase aggregation, exact-name cluster counting, rule scores with explanations, adjusted-close price caching, backtests, and text reports. The added `insiderpulse/lab_api.py` only provides HTTP, bounded ingestion, provenance, serialization, filtering, and job state. It calls the original analysis functions rather than replacing scoring logic.

Important original limitations:

- Form 4/A amendments are skipped. Ownership type, original officer titles, owner CIKs, and footnotes are not retained.
- Joint owners are joined into one name; identities use exact name strings. Multiple purchase rows are combined per filing; repeated activity by one name does not increase distinct insider count.
- Qualifying rows: code P, non-derivative, acquired, positive shares and price, known transaction date. Code P also covers private purchases; it does not prove an open-market motivation.
- Cluster: at least two distinct insider names within ±14 calendar days of the selected purchase, disclosed on or before its filing date. Same-day publication order is unknown. Browser filters do not change the analysis universe.
- Role/size/cluster scores are arbitrary research rules from `config.py`, not confidence or investment advice.

Original AsterKV supports replicated PUT/GET/DELETE/CAS, stable retry identities, persistent state, snapshots, and recovery. Added `cmd/gateway` translates narrow HTTP commands through `internal/client.Client.Do`. The gateway uses four concurrent operations, 60 operations/minute globally, and 2,000 admitted operations per process lifetime. Keys are restricted to 64 safe characters and prefixed by a random browser namespace; values/expected are capped at 512 bytes. This is session separation, not authentication. TCP reachability and measured response time are real observations; the engine exposes no role/term/commit telemetry. The frontend does not invent it. There are no public process/failure controls.

AsterKV retains every deduplication identity forever. The lifetime gateway cap resets when the gateway restarts; continued public operation therefore needs durable admission accounting and operator storage maintenance. Public production exposure is not recommended without that additional control, authentication/abuse protection, and transport security. No deployment was provisioned.

## Historical evaluation

The preview contains **3,390 transactions, 47 qualifying signals, and 135 actual cached historical results**, not invented price histories. Each filing's panel shows its sample size, evaluation dates, holding periods, SPY comparison, and available returns. The engine was rerun against authentic cached prices and reproduced all 135 results exactly; see [docs/cached-verification.json](docs/cached-verification.json).

Entry is the first trading day after disclosure; exits roll forward from entry + 7/30/90 calendar days, at most seven days. Yahoo Finance adjusted closes are used; missing/future prices are excluded. SPY lookup can itself roll forward if an exact-day quote is absent, despite the original backtester comment suggesting perfectly aligned days. No trading costs, spread, slippage, taxes, portfolio weighting, or significance testing. Hand-picked watchlists, overlapping signals, and missing delisted companies cause selection/survivorship/dependence limitations. Date-based disclosure guards are verified, but full look-ahead-bias elimination is not claimed.

No visitor backtest execution endpoint exists. Explicit operator CLI execution (may contact Yahoo Finance, no paid key required by the original code):

```sh
cd vendor/insiderpulse
../../.venv/bin/python main.py backtest --holding-period 7 --holding-period 30 --holding-period 90
```

The original CLI uses its own `vendor/insiderpulse/data/insiderpulse.db`, separate from the lab API cache. Collect/score with the original CLI first, or explicitly back up the lab database there before running it. API execution stays disabled. Yahoo data access/availability/redistribution terms require review before hosting; no new Yahoo download was verified here.

## Verification commands

```sh
npm test
npm run build
.venv/bin/python -m pytest vendor/insiderpulse/tests tests/test_adapter.py -q
.venv/bin/python scripts/verify_cached_analysis.py
# Go 1.26+; requires loopback sockets and child processes
(cd vendor/asterkv && go test -race -count=1 ./...)
# Both services + frontend running; script uses installed Google Chrome on macOS
node scripts/browser-check.mjs
```

Detailed results are in [docs/verification.md](docs/verification.md), with browser screenshots under `docs/screenshots/`. Do not interpret synthetic parser fixtures as fresh SEC integration, or cached-price recomputation as a new market-data download.
