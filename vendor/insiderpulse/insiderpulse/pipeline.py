"""
Pipeline: the four steps of InsiderPulse, each as one function.

    collect   SEC -> parse Form 4s -> transactions table
    score     transactions -> purchases -> signals (clusters + scores) -> signals table
    backtest  signals -> prices -> returns vs SPY -> backtest_results table
    report    tables -> statistics -> text

Each step reads its input from SQLite and writes its output to SQLite, so the
steps can be run separately (python main.py score) or all together (run).
"""

import sqlite3
from datetime import date
from pathlib import Path

from insiderpulse import config, database
from insiderpulse.analytics import build_report
from insiderpulse.backtester import run_backtest
from insiderpulse.clusters import assign_cluster_sizes, is_clustered
from insiderpulse.filters import (
    combine_purchases_into_signals,
    filter_by_minimum_value,
    filter_open_market_purchases,
)
from insiderpulse.models import FilingReference, Signal
from insiderpulse.parser import FilingParseError, parse_form4_xml
from insiderpulse.prices import PriceLoader
from insiderpulse.scoring import score_signals
from insiderpulse.sec_client import (
    SecAccessDeniedError,
    SecClient,
    SecNotFoundError,
    SecRequestError,
    list_form4_filings,
    load_ticker_map,
)

# ---------------------------------------------------------------------------
# Step 1: collect
# ---------------------------------------------------------------------------

def process_filing(connection: sqlite3.Connection, client: SecClient, filing: FilingReference) -> int:
    """
    Download, parse and store one Form 4. Returns the number of new transactions saved.

    The filing is recorded as processed only after its transactions are saved,
    so if the program stops halfway, the filing is simply processed again next
    time (and duplicate rows are ignored by the database).
    """
    try:
        xml_text = client.get_text(filing.document_url)
    except SecNotFoundError:
        database.save_filing(connection, filing, "not_found")
        return 0
    except SecAccessDeniedError:
        raise  # stop everything; continuing would only make the SEC block us longer
    except SecRequestError as error:
        print(f"  Skipping {filing.accession_number} for now: {error}")
        return 0  # not recorded, so it will be retried on the next run

    try:
        transactions = parse_form4_xml(xml_text, filing)
    except FilingParseError as error:
        print(f"  Could not parse {filing.accession_number}: {error}")
        database.save_filing(connection, filing, "parse_error")
        return 0

    inserted = database.save_transactions(connection, transactions)
    database.save_filing(connection, filing, "parsed")
    return inserted


def collect(
    connection: sqlite3.Connection,
    client: SecClient,
    tickers: list[str],
    start_date: date,
    end_date: date,
    ticker_map_path: Path = config.TICKER_MAP_CACHE_PATH,
) -> int:
    """
    Download every Form 4 filed for `tickers` between the two dates that we
    have not processed before. Returns the number of new transactions stored.
    """
    print(f"Collecting Form 4 filings from {start_date} to {end_date} for {', '.join(tickers)}")
    ticker_map = load_ticker_map(client, ticker_map_path)
    total_inserted = 0

    for ticker in tickers:
        if ticker not in ticker_map:
            print(f"{ticker}: not found in the SEC ticker list, skipping")
            continue
        cik, company_name = ticker_map[ticker]

        try:
            filings = list_form4_filings(client, cik, ticker, company_name, start_date, end_date)
        except SecAccessDeniedError:
            raise
        except SecRequestError as error:
            print(f"{ticker}: could not list filings ({error}), skipping")
            continue

        new_filings = [
            filing for filing in filings
            if not database.filing_already_processed(connection, filing.accession_number, ticker)
        ]
        print(f"{ticker} ({company_name}): {len(filings)} Form 4 filings in range, {len(new_filings)} new")

        ticker_inserted = 0
        for number, filing in enumerate(new_filings, start=1):
            ticker_inserted += process_filing(connection, client, filing)
            if number % 25 == 0:
                print(f"  {number}/{len(new_filings)} filings processed")
        print(f"  saved {ticker_inserted} new transactions")
        total_inserted += ticker_inserted

    print(f"Collection finished: {total_inserted} new transactions stored.")
    return total_inserted


# ---------------------------------------------------------------------------
# Step 2: score
# ---------------------------------------------------------------------------

def score(connection: sqlite3.Connection, minimum_value: float) -> list[Signal]:
    """
    Rebuild the signals table from every stored transaction:
    filter purchases -> combine rows per filing -> apply minimum value ->
    detect clusters -> score. Returns the new signals.
    """
    transactions = database.load_transactions(connection)
    purchases = filter_open_market_purchases(transactions)
    signals = combine_purchases_into_signals(purchases)
    signals = filter_by_minimum_value(signals, minimum_value)
    assign_cluster_sizes(signals)
    score_signals(signals)
    database.replace_signals(connection, signals)

    clustered = sum(1 for signal in signals if is_clustered(signal.cluster_size))
    print(
        f"Scored {len(signals)} insider purchases from {len(transactions)} transactions "
        f"({len(purchases)} purchase rows, {clustered} purchases in clusters)."
    )
    print_top_signals(signals)
    return signals


def print_top_signals(signals: list[Signal], how_many: int = 5) -> None:
    """Show the highest-scoring purchases with their score explanations."""
    ranked = sorted(signals, key=lambda signal: (signal.score, signal.total_value), reverse=True)
    for signal in ranked[:how_many]:
        print(
            f"\n  {signal.ticker}  {signal.insider_name} ({signal.insider_role})  "
            f"filed {signal.filing_date}  score {signal.score}"
        )
        for line in signal.score_breakdown:
            print(f"      {line}")


# ---------------------------------------------------------------------------
# Step 3: backtest
# ---------------------------------------------------------------------------

def backtest(
    connection: sqlite3.Connection,
    price_loader: PriceLoader,
    holding_periods: list[int],
    minimum_score: int,
) -> None:
    """Backtest every stored signal with score >= minimum_score and store the results."""
    signals = database.load_signals(connection, minimum_score)
    print(f"Backtesting {len(signals)} signals for holding periods {holding_periods} days...")
    results, signals_without_results = run_backtest(signals, price_loader, holding_periods)
    database.replace_backtest_results(connection, results)
    print(
        f"Stored {len(results)} backtest results. {signals_without_results} signals had no "
        "usable price data (too recent, unknown or delisted ticker)."
    )


# ---------------------------------------------------------------------------
# Step 4: report
# ---------------------------------------------------------------------------

def is_in_scope(ticker: str, filing_date: date, tickers: list[str] | None,
                start_date: date | None, end_date: date | None) -> bool:
    """True if a record matches the report filters (None means 'no filter')."""
    if tickers and ticker not in tickers:
        return False
    if start_date and filing_date < start_date:
        return False
    if end_date and filing_date > end_date:
        return False
    return True


def report(
    connection: sqlite3.Connection,
    tickers: list[str] | None,
    start_date: date | None,
    end_date: date | None,
    minimum_score: int,
    focus_period: int,
) -> str:
    """Read the database, apply the filters, and return the report text."""
    transactions = [
        t for t in database.load_transactions(connection)
        if is_in_scope(t.ticker, t.filing_date, tickers, start_date, end_date)
    ]
    signals = [
        s for s in database.load_signals(connection, minimum_score)
        if is_in_scope(s.ticker, s.filing_date, tickers, start_date, end_date)
    ]
    results = [
        r for r in database.load_backtest_results(connection)
        if r.insider_score >= minimum_score
        and is_in_scope(r.ticker, r.filing_date, tickers, start_date, end_date)
    ]

    filter_description = (
        f"tickers={','.join(tickers) if tickers else 'all'}, "
        f"filed {start_date or 'any'} to {end_date or 'any'}, minimum score={minimum_score}"
    )
    return build_report(transactions, signals, results, focus_period, filter_description)
