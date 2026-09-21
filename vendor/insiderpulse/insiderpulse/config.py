"""
Central configuration for InsiderPulse.

Every tunable number in the project lives here (scoring points, time windows,
holding periods, SEC politeness settings). Other modules import these values
instead of hardcoding their own, so changing a rule means editing one line.
"""

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# File locations
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DATABASE_PATH = DATA_DIR / "insiderpulse.db"

# The SEC publishes one JSON file mapping every ticker to its CIK number.
# We keep a local copy so we do not download it on every run.
TICKER_MAP_CACHE_PATH = DATA_DIR / "company_tickers.json"
TICKER_MAP_MAX_AGE_HOURS = 24

# ---------------------------------------------------------------------------
# SEC access rules
# ---------------------------------------------------------------------------

# The SEC asks every automated tool to identify itself with a name and a
# contact email in the User-Agent header. Set your own with:
#   export INSIDERPULSE_USER_AGENT="Your Name your.email@example.com"
SEC_USER_AGENT = os.environ.get(
    "INSIDERPULSE_USER_AGENT",
    "InsiderPulse educational research project insiderpulse@example.com",
)

# The SEC allows at most 10 requests per second. We stay well below that.
SEC_SECONDS_BETWEEN_REQUESTS = 0.15
SEC_REQUEST_TIMEOUT_SECONDS = 20

# Retry settings for temporary failures (timeouts, HTTP 429/500/502/503/504).
# The wait doubles after each failed attempt: 2s, 4s, 8s, 16s.
SEC_MAX_RETRIES = 4
SEC_RETRY_BASE_DELAY_SECONDS = 2.0

# ---------------------------------------------------------------------------
# Default data collection settings
# ---------------------------------------------------------------------------

# Companies collected when no --ticker is given: large companies whose insiders
# were reported to be buying in 2024-2025. In the collected data, 7 of the 10
# had open-market purchases; CMCSA, TGT and BAX had none, which shows how rare
# real insider buying is. Any US-listed ticker works with --ticker.
DEFAULT_TICKERS = [
    "UNH", "INTC", "PFE", "NKE", "EL",
    "LULU", "CMCSA", "DOW", "TGT", "BAX",
]
DEFAULT_START_DATE = "2024-01-01"

# ---------------------------------------------------------------------------
# Scoring rules
# ---------------------------------------------------------------------------

# Points for the most senior role held by the insider who bought.
ROLE_POINTS = {
    "CEO": 3,
    "CFO": 2,
    "Officer": 2,       # any other executive officer (COO, President, EVP, ...)
    "Director": 1,
    "10% Owner": 0,     # large shareholders who are not employees
    "Other": 0,
}

# Points for the total dollar size of the purchase.
# Checked from the top down; the first threshold the value reaches wins.
SIZE_POINTS = [
    (1_000_000, 3),
    (500_000, 2),
    (100_000, 1),
]

# Cluster buying: several different insiders buying the same stock
# within a short time window.
CLUSTER_WINDOW_DAYS = 14
CLUSTER_MIN_INSIDERS = 2
CLUSTER_BONUS_POINTS = 3

# Purchases smaller than this (in dollars) are ignored entirely.
DEFAULT_MINIMUM_PURCHASE_VALUE = 0

# ---------------------------------------------------------------------------
# Backtest settings
# ---------------------------------------------------------------------------

# How many calendar days after entry we measure the return.
HOLDING_PERIODS_DAYS = [7, 30, 90]

# The market benchmark every stock return is compared against.
BENCHMARK_TICKER = "SPY"

# We "buy" on the first trading day AFTER the filing date. A Form 4 can be
# filed after the market closes, so using the filing day's own closing
# price could use information the public did not have yet.
ENTRY_DELAY_DAYS = 1

# If a target date is a weekend or holiday we roll forward to the next
# trading day, but never more than this many calendar days. If no price
# exists in that window (delisted stock, bad ticker) the result is skipped.
MAX_DAYS_TO_NEXT_TRADING_DAY = 7

# Holding period used for the "by role / by size / by score" report tables.
DEFAULT_REPORT_HOLDING_PERIOD = 30
