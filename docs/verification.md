# Verification record — static build

Executed locally on 2026-09-21 against the production build (`dist/`) served by
`python3 -m http.server`, with no Python API, Go gateway or node process used by
the page. (An older local gateway and API happened to be listening on ports
8010/8011; the browser check asserts that the page never requested them.)

| Check | Result | Scope |
|---|---|---|
| `npm test` | 29 passed | Analysis equivalence, Raft simulation, helpers |
| JS analysis vs Python export | 47 / 47 signals identical | Every field incl. float totals, score text, cluster insiders, related filings; also after reversing row order |
| JS summary stats vs `analytics.summarize_period` | Match (< 1e-12) | 7/30/90-day stored results; values printed by the original pandas code |
| Dataset re-export (`scripts/export_cache.py`) | Identical data | Run in a scratch copy; transactions, signals and backtests equal to the committed file |
| Raft simulation, deterministic | 14 scenario tests | Election, commit, catch-up, failover, no-majority timeout, isolated stale leader + truncation, vote refusal, committed-entry protection, CAS, dedup, reset, destroy |
| Raft randomized faults | 6 seeds, invariants held | Stops, restarts, isolations and delay changes; one leader per term, committed prefixes agree, no acknowledged write lost |
| `npm run build` | Passed | Vite 7.3.6; labs and workers are separate lazy chunks |
| Browser check (`scripts/browser-check.mjs`) | 23 checks passed | See `browser-verification.json` |
| Desktop 1440 px / mobile 390 px | No horizontal overflow on any route | Screenshots in `screenshots/` |
| Worker lifecycle | 0 workers after leaving AsterKV; never more than 3 | Three round trips plus in-app navigation |
| Network | No backend, SEC or market-data requests | Only other origin: Google Fonts |

Not verified here: the Cloudflare Pages deployment itself (not provisioned), the
Python and Go suites (their code is unchanged by this conversion), browsers
other than Playwright's Chromium, and behaviour in background tabs, where
browsers throttle worker timers and the simulation may hold extra elections.
