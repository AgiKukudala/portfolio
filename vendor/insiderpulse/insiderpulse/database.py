"""
Database: stores everything in one local SQLite file (data/insiderpulse.db).

SQLite is a full SQL database that lives in a single file and ships with
Python (the sqlite3 module), so there is no server to install.

Tables:
  filings           Form 4 filings we have already processed (so we never download twice)
  transactions      every parsed Form 4 row
  signals           scored open-market purchases (rebuilt by the `score` command)
  backtest_results  returns after each signal (rebuilt by the `backtest` command)
  prices            cached daily closing prices
  price_downloads   which (ticker, date range) we already asked Yahoo for

Dates are stored as ISO text ("2024-03-05"), which sorts correctly as text.
"""

import sqlite3
from datetime import date, datetime
from pathlib import Path

from insiderpulse import config
from insiderpulse.models import BacktestResult, FilingReference, Signal, Transaction

SCHEMA = """
CREATE TABLE IF NOT EXISTS filings (
    accession_number TEXT NOT NULL,
    ticker           TEXT NOT NULL,
    cik              INTEGER NOT NULL,
    form_type        TEXT NOT NULL,
    filing_date      TEXT NOT NULL,
    document_url     TEXT NOT NULL,
    status           TEXT NOT NULL,
    processed_at     TEXT NOT NULL,
    PRIMARY KEY (accession_number, ticker)
);

CREATE TABLE IF NOT EXISTS transactions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_filing        TEXT NOT NULL,
    line_number          INTEGER NOT NULL,
    company_name         TEXT NOT NULL,
    ticker               TEXT NOT NULL,
    insider_name         TEXT NOT NULL,
    insider_role         TEXT NOT NULL,
    transaction_date     TEXT,
    filing_date          TEXT NOT NULL,
    transaction_code     TEXT NOT NULL,
    transaction_type     TEXT NOT NULL,
    acquired_or_disposed TEXT NOT NULL,
    is_derivative        INTEGER NOT NULL,
    security_title       TEXT NOT NULL,
    shares               REAL,
    price_per_share      REAL,
    transaction_value    REAL,
    UNIQUE (source_filing, line_number)
);

CREATE TABLE IF NOT EXISTS signals (
    source_filing    TEXT PRIMARY KEY,
    ticker           TEXT NOT NULL,
    company_name     TEXT NOT NULL,
    insider_name     TEXT NOT NULL,
    insider_role     TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    filing_date      TEXT NOT NULL,
    shares           REAL NOT NULL,
    average_price    REAL NOT NULL,
    total_value      REAL NOT NULL,
    cluster_size     INTEGER NOT NULL,
    score            INTEGER NOT NULL,
    score_breakdown  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_results (
    source_filing             TEXT NOT NULL,
    holding_period_days       INTEGER NOT NULL,
    ticker                    TEXT NOT NULL,
    insider_name              TEXT NOT NULL,
    insider_role              TEXT NOT NULL,
    transaction_date          TEXT NOT NULL,
    filing_date               TEXT NOT NULL,
    total_value               REAL NOT NULL,
    insider_score             INTEGER NOT NULL,
    cluster_size              INTEGER NOT NULL,
    entry_date                TEXT NOT NULL,
    exit_date                 TEXT NOT NULL,
    starting_price            REAL NOT NULL,
    ending_price              REAL NOT NULL,
    stock_return              REAL NOT NULL,
    benchmark_ticker          TEXT NOT NULL,
    benchmark_return          REAL NOT NULL,
    benchmark_adjusted_return REAL NOT NULL,
    PRIMARY KEY (source_filing, holding_period_days)
);

CREATE TABLE IF NOT EXISTS prices (
    ticker      TEXT NOT NULL,
    trade_date  TEXT NOT NULL,
    close_price REAL NOT NULL,
    PRIMARY KEY (ticker, trade_date)
);

CREATE TABLE IF NOT EXISTS price_downloads (
    ticker        TEXT NOT NULL,
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    downloaded_at TEXT NOT NULL
);
"""


def connect(path: Path | str = config.DATABASE_PATH) -> sqlite3.Connection:
    """Open (or create) the database file and make sure all tables exist."""
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row  # lets us read columns by name: row["ticker"]
    connection.executescript(SCHEMA)
    return connection


def to_text(value: date | None) -> str | None:
    """date -> '2024-03-05' for storage."""
    return value.isoformat() if value is not None else None


def to_date(text: str | None) -> date | None:
    """'2024-03-05' -> date when reading back."""
    return date.fromisoformat(text) if text else None


# ---------------------------------------------------------------------------
# Filings
# ---------------------------------------------------------------------------

def filing_already_processed(connection: sqlite3.Connection, accession_number: str, ticker: str) -> bool:
    """True if this filing was already downloaded and handled for this ticker."""
    row = connection.execute(
        "SELECT 1 FROM filings WHERE accession_number = ? AND ticker = ?",
        (accession_number, ticker),
    ).fetchone()
    return row is not None


def save_filing(connection: sqlite3.Connection, filing: FilingReference, status: str) -> None:
    """Remember that a filing was processed, with a status such as 'parsed' or 'parse_error'."""
    connection.execute(
        """INSERT OR IGNORE INTO filings
           (accession_number, ticker, cik, form_type, filing_date, document_url, status, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            filing.accession_number, filing.ticker, filing.cik, filing.form_type,
            to_text(filing.filing_date), filing.document_url, status,
            datetime.now().isoformat(timespec="seconds"),
        ),
    )
    connection.commit()


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------

def save_transactions(connection: sqlite3.Connection, transactions: list[Transaction]) -> int:
    """
    Insert transactions, silently skipping any we already have.

    The UNIQUE (source_filing, line_number) rule means the same Form 4 row can
    never be stored twice. Returns how many rows were actually new.
    """
    inserted = 0
    for t in transactions:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO transactions
               (source_filing, line_number, company_name, ticker, insider_name, insider_role,
                transaction_date, filing_date, transaction_code, transaction_type,
                acquired_or_disposed, is_derivative, security_title, shares,
                price_per_share, transaction_value)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                t.source_filing, t.line_number, t.company_name, t.ticker, t.insider_name,
                t.insider_role, to_text(t.transaction_date), to_text(t.filing_date),
                t.transaction_code, t.transaction_type, t.acquired_or_disposed,
                int(t.is_derivative), t.security_title, t.shares, t.price_per_share,
                t.transaction_value,
            ),
        )
        inserted += cursor.rowcount  # 1 if inserted, 0 if it was a duplicate
    connection.commit()
    return inserted


def load_transactions(connection: sqlite3.Connection) -> list[Transaction]:
    """Read every stored transaction back into Transaction objects."""
    rows = connection.execute(
        "SELECT * FROM transactions ORDER BY filing_date, source_filing, line_number"
    ).fetchall()
    transactions = []
    for row in rows:
        transactions.append(
            Transaction(
                company_name=row["company_name"],
                ticker=row["ticker"],
                insider_name=row["insider_name"],
                insider_role=row["insider_role"],
                transaction_date=to_date(row["transaction_date"]),
                filing_date=to_date(row["filing_date"]),
                transaction_code=row["transaction_code"],
                transaction_type=row["transaction_type"],
                acquired_or_disposed=row["acquired_or_disposed"],
                is_derivative=bool(row["is_derivative"]),
                security_title=row["security_title"],
                shares=row["shares"],
                price_per_share=row["price_per_share"],
                source_filing=row["source_filing"],
                line_number=row["line_number"],
            )
        )
    return transactions


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

def replace_signals(connection: sqlite3.Connection, signals: list[Signal]) -> None:
    """
    Delete all old signals and store the new ones.

    Signals are fully rebuilt every time `score` runs, so a change to the
    scoring rules in config.py is always reflected everywhere.
    """
    connection.execute("DELETE FROM signals")
    for s in signals:
        connection.execute(
            """INSERT INTO signals
               (source_filing, ticker, company_name, insider_name, insider_role, transaction_date,
                filing_date, shares, average_price, total_value, cluster_size, score, score_breakdown)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                s.source_filing, s.ticker, s.company_name, s.insider_name, s.insider_role,
                to_text(s.transaction_date), to_text(s.filing_date), s.shares, s.average_price,
                s.total_value, s.cluster_size, s.score, "\n".join(s.score_breakdown),
            ),
        )
    connection.commit()


def load_signals(connection: sqlite3.Connection, minimum_score: int = 0) -> list[Signal]:
    """Read signals with score >= minimum_score, oldest filing first."""
    rows = connection.execute(
        "SELECT * FROM signals WHERE score >= ? ORDER BY filing_date, ticker, source_filing",
        (minimum_score,),
    ).fetchall()
    signals = []
    for row in rows:
        signals.append(
            Signal(
                ticker=row["ticker"],
                company_name=row["company_name"],
                insider_name=row["insider_name"],
                insider_role=row["insider_role"],
                transaction_date=to_date(row["transaction_date"]),
                filing_date=to_date(row["filing_date"]),
                shares=row["shares"],
                average_price=row["average_price"],
                total_value=row["total_value"],
                source_filing=row["source_filing"],
                cluster_size=row["cluster_size"],
                score=row["score"],
                score_breakdown=row["score_breakdown"].split("\n") if row["score_breakdown"] else [],
            )
        )
    return signals


# ---------------------------------------------------------------------------
# Backtest results
# ---------------------------------------------------------------------------

def replace_backtest_results(connection: sqlite3.Connection, results: list[BacktestResult]) -> None:
    """Delete all old backtest results and store the new ones."""
    connection.execute("DELETE FROM backtest_results")
    for r in results:
        connection.execute(
            """INSERT INTO backtest_results
               (source_filing, holding_period_days, ticker, insider_name, insider_role,
                transaction_date, filing_date, total_value, insider_score, cluster_size,
                entry_date, exit_date, starting_price, ending_price, stock_return,
                benchmark_ticker, benchmark_return, benchmark_adjusted_return)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                r.source_filing, r.holding_period_days, r.ticker, r.insider_name, r.insider_role,
                to_text(r.transaction_date), to_text(r.filing_date), r.total_value,
                r.insider_score, r.cluster_size, to_text(r.entry_date), to_text(r.exit_date),
                r.starting_price, r.ending_price, r.stock_return, r.benchmark_ticker,
                r.benchmark_return, r.benchmark_adjusted_return,
            ),
        )
    connection.commit()


def load_backtest_results(connection: sqlite3.Connection) -> list[BacktestResult]:
    """Read every stored backtest result."""
    rows = connection.execute(
        "SELECT * FROM backtest_results ORDER BY filing_date, ticker, holding_period_days"
    ).fetchall()
    results = []
    for row in rows:
        results.append(
            BacktestResult(
                ticker=row["ticker"],
                insider_name=row["insider_name"],
                insider_role=row["insider_role"],
                transaction_date=to_date(row["transaction_date"]),
                filing_date=to_date(row["filing_date"]),
                source_filing=row["source_filing"],
                total_value=row["total_value"],
                insider_score=row["insider_score"],
                cluster_size=row["cluster_size"],
                holding_period_days=row["holding_period_days"],
                entry_date=to_date(row["entry_date"]),
                exit_date=to_date(row["exit_date"]),
                starting_price=row["starting_price"],
                ending_price=row["ending_price"],
                stock_return=row["stock_return"],
                benchmark_ticker=row["benchmark_ticker"],
                benchmark_return=row["benchmark_return"],
                benchmark_adjusted_return=row["benchmark_adjusted_return"],
            )
        )
    return results


# ---------------------------------------------------------------------------
# Price cache
# ---------------------------------------------------------------------------

def save_prices(connection: sqlite3.Connection, ticker: str, closes: dict[date, float]) -> None:
    """Store daily closing prices; re-downloaded days simply overwrite the old value."""
    for trade_date, close_price in closes.items():
        connection.execute(
            "INSERT OR REPLACE INTO prices (ticker, trade_date, close_price) VALUES (?, ?, ?)",
            (ticker, to_text(trade_date), close_price),
        )
    connection.commit()


def load_prices(connection: sqlite3.Connection, ticker: str) -> dict[date, float]:
    """Return {trade_date: close_price} for every cached day of this ticker."""
    rows = connection.execute(
        "SELECT trade_date, close_price FROM prices WHERE ticker = ?", (ticker,)
    ).fetchall()
    return {to_date(row["trade_date"]): row["close_price"] for row in rows}


def record_price_download(connection: sqlite3.Connection, ticker: str, start: date, end: date) -> None:
    """Remember that we asked for this ticker's prices from start to end (even if none came back)."""
    connection.execute(
        "INSERT INTO price_downloads (ticker, start_date, end_date, downloaded_at) VALUES (?, ?, ?, ?)",
        (ticker, to_text(start), to_text(end), datetime.now().isoformat(timespec="seconds")),
    )
    connection.commit()


def price_range_is_cached(connection: sqlite3.Connection, ticker: str, start: date, end: date) -> bool:
    """True if one earlier download already covered the whole range start..end."""
    row = connection.execute(
        """SELECT 1 FROM price_downloads
           WHERE ticker = ? AND start_date <= ? AND end_date >= ?""",
        (ticker, to_text(start), to_text(end)),
    ).fetchone()
    return row is not None
