# InsiderPulse

**An SEC insider-buying signal and backtesting engine, written in plain Python.**

InsiderPulse downloads public Form 4 filings from the SEC, finds the ones where
company insiders bought their own company's stock on the open market, scores
each purchase with simple rules you can read, and then measures what the stock
did over the next 7, 30 and 90 days compared with the S&P 500 (SPY).

It is a research and paper-analysis tool. It does not connect to a broker,
place trades, use money, or need any API key or paid service.

> Historical results do not imply future profitability. InsiderPulse is an
> educational research/backtesting system and does not provide financial advice
> or execute real trades.

---

## 1. The hypothesis being tested

> *When company insiders spend their own money buying their company's stock,
> especially senior executives, in large amounts, or several insiders at once,
> does the stock beat the market afterwards?*

InsiderPulse does not assume the answer. It gives you the numbers to check it
on whichever companies and dates you collect.

## 2. What "insider buying" means

Officers, directors and anyone owning more than 10% of a company are
*insiders*. US law requires them to report trades in their company's stock to
the SEC on **Form 4**, within two business days.

Most Form 4 rows are *not* an insider choosing to buy:

| SEC code | Meaning | Is it a buying decision? |
|---|---|---|
| **P** | Open-market or private **purchase** | **Yes**: the insider paid market price with their own money |
| S | Sale | No |
| A | Grant or award (stock given as pay) | No |
| M / X | Option exercise | No: turning existing options into shares |
| F | Shares withheld to pay tax | No |
| G | Gift | No |

InsiderPulse only uses code **P** rows on common/preferred stock (not options),
with a positive share count and price.

## 3. Architecture

```text
  SEC EDGAR (public, free, no key)
     │   company_tickers.json · submissions JSON · Form 4 XML
     ▼
  sec_client.py   polite HTTP: User-Agent, ≤ ~7 requests/s, retries with backoff
     ▼
  parser.py       Form 4 XML  ──►  Transaction objects
     ▼
  database.py     [transactions] [filings]          (SQLite: data/insiderpulse.db)
     ▼
  filters.py      keep open-market purchases, combine each filing's rows ──► Signal
     ▼
  clusters.py     how many different insiders were buying around the same time?
     ▼
  scoring.py      role points + size points + cluster bonus, with explanation
     ▼
  database.py     [signals]
     ▼
  prices.py       yfinance adjusted daily closes, cached in SQLite [prices]
     ▼
  backtester.py   stock return and SPY return over 7 / 30 / 90 days
     ▼
  database.py     [backtest_results]
     ▼
  analytics.py    averages, medians, win rates, group tables ──► text report
```

Everything runs in one Python process on your computer. `main.py` reads the
command line and calls the step functions in `insiderpulse/pipeline.py`.

```text
insiderpulse/
├── main.py                 command-line interface (argparse)
├── insiderpulse/
│   ├── config.py           every tunable number: scoring points, windows, periods
│   ├── models.py           dataclasses: FilingReference, Transaction, Signal, BacktestResult
│   ├── sec_client.py       downloading from the SEC (rate limit, retries, errors)
│   ├── parser.py           Form 4 XML → Transaction
│   ├── filters.py          is_open_market_purchase(), combining rows into signals
│   ├── clusters.py         cluster-buying detection
│   ├── scoring.py          explainable score
│   ├── prices.py           price lookups + caching (the only file that imports yfinance)
│   ├── backtester.py       return calculations
│   ├── database.py         SQLite tables and queries
│   ├── analytics.py        statistics and report text (pandas)
│   └── pipeline.py         collect / score / backtest / report steps
├── tests/                  pytest suite, fully offline
└── data/                   database and cached ticker list (git-ignored)
```

## 4. How SEC data flows through the system

1. **Ticker → CIK.** The SEC identifies companies by a *CIK* number. We download
   `https://www.sec.gov/files/company_tickers.json` once a day to translate
   `UNH` into CIK `731766`.
2. **List the company's filings.** `https://data.sec.gov/submissions/CIK0000731766.json`
   lists every filing involving the company. We keep form type `4` inside the
   requested filing-date range. Amendments (`4/A`) are skipped. If the date range
   reaches back further than the ~1,000 most recent filings, the older index
   files are downloaded too.
3. **Download each Form 4 XML** from `https://www.sec.gov/Archives/edgar/data/...`.
   Filings already in the `filings` table are never downloaded again.
4. **Parse** the XML into `Transaction` objects (company, insider, role, date,
   SEC code, shares, price, value, source filing). Form 4s where the company is
   the *buyer* of another company's stock are skipped.
5. **Store** the transactions. `UNIQUE(source_filing, line_number)` makes duplicates
   impossible.

SEC access rules followed: a `User-Agent` with contact details, a pause between
requests (well under the 10 requests/second limit), retries with doubling delays
on HTTP 429/5xx and timeouts, obeying `Retry-After`, and stopping entirely on
HTTP 403.

## 5. How the scoring system works

Each purchase gets points from three rules. All numbers live in `config.py`.

| Rule | Points |
|---|---|
| CEO | +3 |
| CFO | +2 |
| Other executive officer | +2 |
| Director | +1 |
| 10% owner / other | +0 |
| Purchase ≥ $1,000,000 | +3 |
| $500,000 – $999,999 | +2 |
| $100,000 – $499,999 | +1 |
| Cluster: ≥ 2 different insiders buying within 14 days | +3 |

The score always comes with its explanation, for example this real UNH signal:

```text
UNH  HEMSLEY STEPHEN J (CEO)  filed 2025-05-16  score 9
    CEO purchase: +3
    $25,019,019 purchase: +3
    5 insiders buying within 14 days: +3
```

**Why purchases are combined per filing:** one purchase is often reported as
several rows at slightly different prices (1,000 shares at $50.01, 500 at
$50.03, ...). InsiderPulse adds up the rows of each filing into one `Signal`, so
one buying decision counts once and its full dollar size is scored.

The role comes from the Form 4 relationship checkboxes plus the free-text
officer title ("President & CEO" → CEO, "EVP & Chief Financial Officer" → CFO).
If one person holds several roles, the most senior one is used.

## 6. How cluster detection works

For each purchase, InsiderPulse counts the **distinct insiders** of the same
company who bought within `CLUSTER_WINDOW_DAYS` (14) of it, **counting only
purchases already public on the day this purchase was filed**. A cluster needs at
least `CLUSTER_MIN_INSIDERS` (2).

Example (CEO buys Jan 3, Director Jan 5, CFO Jan 7, each filed two days later):

| Purchase | Insiders known at filing time | Cluster size |
|---|---|---|
| CEO, Jan 3 | CEO | 1 (not a cluster yet) |
| Director, Jan 5 | CEO, Director | 2 |
| CFO, Jan 7 | CEO, Director, CFO | 3 |

The first buyer does not get the bonus, because on its filing day nobody could
know others would follow. That is deliberate: see look-ahead bias below.

Cluster detection only considers purchases that pass `--minimum-value`.

## 7. How backtesting works

A backtest asks: *if someone had bought the stock when this purchase became
public, what would have happened?*

For every signal and every holding period (7, 30, 90 calendar days):

```text
entry day   = first trading day AFTER the Form 4 filing date
exit day    = first trading day on or after (entry day + holding period)

stock return               = (exit price − entry price) / entry price
SPY return                 = same formula, same two days, for SPY
benchmark-adjusted return  = stock return − SPY return
```

Example: stock goes $100 → $108 (+8%), SPY goes +3% over the same days, so the
benchmark-adjusted (excess) return is **+5%**.

**Price rules** (`prices.py`):

* Prices are Yahoo Finance *adjusted closes* via `yfinance` (free, no key),
  so stock splits and dividends do not create fake jumps.
* Weekend or holiday? Use the next trading day, up to 7 calendar days ahead.
  We never roll backwards, because that would use a price from before the simulated moment.
* No price in that window (unknown or delisted ticker), or the date has not
  happened yet? The calculation is **skipped**, never filled in with 0%.
* The newest price ever used is yesterday's close, because today's is not final.
* Every download is stored in SQLite, and a range already downloaded is never requested again.

## 8. Why SPY is used as a benchmark

SPY is an exchange-traded fund that tracks the S&P 500, which is roughly "the
US stock market". If a stock rose 5% while the whole market rose 5%, insider
buying did not predict anything special. Subtracting SPY's return over the
*exact same days* isolates how much better or worse the stock did than simply
owning the market.

## 9. What look-ahead bias means

**Look-ahead bias** is when a backtest uses information that was not available
yet at the moment being simulated. It makes results look better than anything
achievable in reality.

InsiderPulse guards against it in three places:

1. **Entry is based on the filing date, not the trade date.** An insider may buy
   on Monday and file on Wednesday. The public only knows on Wednesday, so we
   cannot "buy" on Monday's price.
2. **Entry is the day after the filing date.** Filings can arrive after the
   market has closed, so even the filing day's closing price could be too early.
3. **Cluster detection only counts filings already public.** A purchase disclosed
   next week cannot boost the score of a purchase disclosed today.

## 10. Project limitations

Read these before drawing conclusions from any report:

* **Small, hand-picked sample.** The default watchlist is 10 large companies
  picked because their insiders were reported to be buying in 2024–2025 (7 of
  the 10 turned out to have open-market purchases; CMCSA, TGT and BAX had none).
  The companies were picked with hindsight, so they are not a random sample of the market.
* **Overlapping signals are not independent.** When five UNH insiders all file
  on the same day, they share one entry and exit day and so have identical
  returns. Averages count them five times.
* **Survivorship bias.** Yahoo Finance usually has no data for delisted
  companies, so those signals are skipped, and delisted stocks often did badly.
* **No trading costs.** No commissions, bid-ask spread, slippage or taxes.
* **Closing prices only.** The simulated trade happens at a daily close.
* **No significance testing.** Averages over a few dozen signals can easily be
  luck. The report warns when a group has fewer than 10 signals.
* **Scoring weights are arbitrary.** They are simple rules of thumb and were
  not fitted to data, which is on purpose to avoid overfitting.
* **Parsing simplifications.** Form 4/A amendments are ignored. Joint filings
  (several owners on one form) are combined under one name. Roles come from
  free-text titles. Only XML filings (2003 onwards) are supported.
* **Fixed calendar-day holding periods.** 30 days means 30 calendar days, not
  30 trading days.

## 11. Setup

Requires Python 3.10+ (tested with 3.14) and an internet connection for
`collect` and `backtest`.

```sh
cd insiderpulse
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# The SEC asks automated tools to identify themselves. Use your own name/email:
export INSIDERPULSE_USER_AGENT="Your Name your.email@example.com"
```

No API keys, accounts or paid services are required.

## 12. Commands

| Command | What it does |
|---|---|
| `python main.py collect` | Download and parse Form 4s for the tickers and filing dates given |
| `python main.py score` | Rebuild signals: purchases → clusters → scores |
| `python main.py backtest` | Rebuild backtest results for every signal |
| `python main.py report` | Print the statistics |
| `python main.py run` | All four in order |

Options (all commands accept them; each uses the ones that apply):

| Option | Used by | Meaning |
|---|---|---|
| `--ticker UNH,INTC` | collect, report | Which companies (collect default: the watchlist in `config.py`) |
| `--start-date 2024-01-01` | collect, report | First filing date (collect default: 2024-01-01) |
| `--end-date 2025-06-30` | collect, report | Last filing date (collect default: today) |
| `--minimum-value 100000` | score | Ignore purchases under this many dollars |
| `--minimum-score 5` | backtest, report | Only signals with at least this score |
| `--holding-period 30` | backtest, report | Repeatable. Backtest: which periods (default 7, 30, 90). Report: which period the group tables use (default 30) |

Examples:

```sh
python main.py run                                        # full pipeline on the default watchlist
python main.py collect --ticker KO,PEP --start-date 2024-06-01
python main.py score --minimum-value 100000
python main.py report --minimum-score 6 --holding-period 90
```

`collect` only downloads filings it has not seen before, so re-running it is
cheap. `score` and `backtest` rebuild their tables from scratch every time,
so changes to `config.py` always take effect. Prices come from the cache.

## 13. Example output

Real output from `python main.py run` on the default 10-ticker watchlist,
filings from 2024-01-01 to 2026-09-15 (run on 2026-09-15). Your numbers will
differ when you collect different tickers or dates, or run it later.

Given the limitations above (46 signals, many of them overlapping), **these
numbers do not show that insider buying works or fails.** They show that the
pipeline measures it.

```text
Scored 47 insider purchases from 3390 transactions (66 purchase rows, 25 purchases in clusters).

  UNH  HEMSLEY STEPHEN J (CEO)  filed 2025-05-16  score 9
      CEO purchase: +3
      $25,019,019 purchase: +3
      5 insiders buying within 14 days: +3
  ...
Backtesting 47 signals for holding periods [7, 30, 90] days...
Stored 135 backtest results. 0 signals had no usable price data (too recent, unknown or delisted ticker).

============================================================
INSIDERPULSE BACKTEST REPORT
============================================================
Filters: tickers=all, filed any to any, minimum score=0
Benchmark: SPY. Entry: first trading day after the Form 4 filing date.

DATA
  Transactions analyzed:            3,390
    Grant or award:                 1,643
    Option exercise:                  729
    Tax withholding:                  624
    Sale:                             132
    Other:                            130
    Open-market purchase:              66
    Gift:                              66
  Qualifying purchases (signals):      47
    Part of a cluster:                 25
  Signals with backtest results:       47

7-DAY RESULTS (47 signals)
  Average stock return:         +0.80%
  Average SPY return:           +0.96%
  Average excess return:        -0.16%
  Median stock return:          +0.98%
  Median excess return:         -0.04%
  Win rate vs SPY:               48.9%
  Positive-return rate:          57.4%
  Best:  +13.21% EL filed 2024-11-19 (FRIBOURG PAUL J, Director)
  Worst: -15.68% INTC filed 2026-08-14 (TAN LIP BU, CEO)

30-DAY RESULTS (46 signals)
  Average stock return:         +0.12%
  Average SPY return:           +1.19%
  Average excess return:        -1.07%
  Median stock return:          -1.45%
  Median excess return:         -0.92%
  Win rate vs SPY:               47.8%
  Positive-return rate:          45.7%
  Best:  +16.64% EL filed 2024-11-15 (Shrivastava Akhil, CFO)
  Worst: -20.66% INTC filed 2024-11-06 (GELSINGER PATRICK P, CEO)

90-DAY RESULTS (42 signals)
  Average stock return:         -2.09%
  Average SPY return:           +3.85%
  Average excess return:        -5.95%
  Median stock return:          -4.50%
  Median excess return:         -7.18%
  Win rate vs SPY:               26.2%
  Positive-return rate:          26.2%
  Best:  +73.27% INTC filed 2026-01-27 (Zinsner David, CFO)
  Worst: -34.50% LULU filed 2026-03-23 (Bergh Charles V, Director)

BY INSIDER ROLE (30-day)
  Group            Signals   Avg return   Avg excess   Win rate
  CEO                   13       -3.07%       -6.32%      30.8%
  CFO                    4       +1.31%       +3.52%      50.0%
  Director              29       +1.38%       +0.65%      55.2%

BY PURCHASE SIZE (30-day)
  Group            Signals   Avg return   Avg excess   Win rate
  $1M+                  16       +2.22%       +2.82%      62.5%
  $500K-$1M              9       -0.13%       -3.94%      44.4%
  $100K-$500K           16       -2.03%       -4.43%      31.2%
  Under $100K            5       +0.70%       +2.40%      60.0%

BY SIGNAL SCORE (30-day)
  Group            Signals   Avg return   Avg excess   Win rate
  9                      4       -0.22%       +0.29%      50.0%
  8                      2       -4.95%       -7.97%       0.0%
  7                      9       +1.75%       +1.60%      66.7%
  6                      4       +6.97%       +5.83%     100.0%
  5                      6       +2.23%       +2.03%      50.0%
  4                      9       -2.80%       -4.92%      22.2%
  3                      6       -3.39%       -8.09%      16.7%
  2                      4       +3.23%       +3.93%      75.0%
  1                      2       -4.12%       -3.61%      50.0%

CLUSTERED VS ISOLATED (30-day)
  Group            Signals   Avg return   Avg excess   Win rate
  Clustered             25       +1.47%       +1.23%      56.0%
  Isolated              21       -1.50%       -3.80%      38.1%

Groups with fewer than 10 signals are too small to draw conclusions from.
Historical results do not imply future profitability. InsiderPulse is an educational
research/backtesting system and does not provide financial advice or execute real trades.
```

Some periods have fewer signals than others because their exit day has not
happened yet. For example, a purchase filed in August 2026 has a 7-day result but
no 90-day result. The missing periods are left out, never counted as 0%.

## 14. Testing

```sh
python -m pytest
```

The suite runs fully offline. A fake HTTP session replaces the SEC and a fake
price function replaces yfinance, so every expected number can be checked by
hand. It covers:

* transaction value calculation and Form 4 parsing (including missing prices and malformed XML)
* purchase classification (purchases vs sales, option exercises, grants, tax withholding)
* role scoring, purchase-size scoring and the full score explanation
* cluster detection, including the rule that unpublished filings are not used
* return and benchmark-adjusted return calculations
* weekend/holiday roll-forward, unknown tickers, delisted/missing data, future dates
* duplicate filings and transactions, and price caching
* SEC retries, backoff, `Retry-After`, 404/403 handling and malformed JSON
* an end-to-end collect → score → backtest → report run

## 15. License

Released under the [MIT License](LICENSE).

InsiderPulse is an educational research and backtesting tool. It is not
financial advice, it does not execute trades, and historical results do not
imply future profitability.
