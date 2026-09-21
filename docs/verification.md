# Verification record

Executed locally on September 19–20, 2026 (America/Chicago / UTC).

| Check | Result | Evidence scope |
|---|---|---|
| Original InsiderPulse suite | 92 passed | Original offline parser, filters, scoring, cluster, SEC retry, database, price/backtest and pipeline fixtures |
| Added HTTP adapter suite | 16 passed | Field/missing-value preservation, pagination, validation, exact cluster enrichment, upstream failure, SEC URL/budget boundaries, Retry-After date/cooldown, real local HTTP 400/404/503/429 |
| Original vs exposed signals | 47 exact matches | Recomputed from authentic local SEC cache and compared with original stored signals |
| Historical backtests | 135 exact matches | Original engine rerun using authentic cached Yahoo prices; zero fresh upstream requests |
| AsterKV race suite | Passed | `go test -race -count=1 ./...`, including original real-socket and process-kill/recovery tests |
| AsterKV gateway smoke | Passed | Real three-node cluster: PUT/GET/CAS/DELETE, retry identity, namespace separation, invalid operation |
| Frontend unit checks | 4 passed | Filtering, missing values, safe filing URLs, escaping |
| Frontend production build | Passed | Vite 7.3.6 |
| Browser interactions | Passed | See browser-verification.json; real services plus intentionally intercepted failure response |
| Desktop / 390px mobile | Inspected | Both labs, menus, no horizontal overflow; screenshots in screenshots/ |
| Compose profiles | Configuration valid | `docker-compose --profile asterkv --profile insiderpulse config --quiet` |
| Docker build/runtime | Not executed | Docker daemon stopped; Compose plugin absent, standalone docker-compose available |
| Fresh SEC ingestion | Not executed | No real identifying User-Agent/contact supplied; ingestion stays disabled |
| Fresh Yahoo price download | Not executed | Existing cache supported reproducible historical evaluation; no fresh-data claim |

Initial sandboxed socket tests failed with EPERM and were rerun with approved local socket access. An initial pytest command was mistakenly launched from the home directory; it was stopped and the intended project suite then passed. Initial npm installation hit shared-cache permissions; the successful install used a separate temporary npm cache. Browser checks caught and fixed a malformed purchase option and an immediate mobile-menu close issue. These failed attempts are not counted as passing validation.

The shipped sample fixture is synthetic Example Corp XML from the original parser test. Authentic bundled data is separately labeled Cached and includes source DB SHA-256, export time, filing source URLs, and original (timezone-unspecified) retrieval timestamps. A connected API response backed by SQLite remains labeled Cached; connecting to a backend does not turn cached data into fresh SEC data.

The original AsterKV/portfolio brief was not supplied in this thread. There was no pre-existing portfolio or Compose implementation in the public `website` repository. Compatibility with unprovided requirements cannot be claimed.
