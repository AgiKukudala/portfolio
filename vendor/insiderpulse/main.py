"""
InsiderPulse command-line interface.

Usage:
    python main.py collect   [--ticker UNH,INTC] [--start-date 2024-01-01] [--end-date 2025-06-30]
    python main.py score     [--minimum-value 100000]
    python main.py backtest  [--minimum-score 0] [--holding-period 7 --holding-period 30]
    python main.py report    [--ticker UNH] [--minimum-score 5] [--holding-period 30]
    python main.py run       (all four steps in order)

This file only reads the command-line options and calls the matching
functions in insiderpulse/pipeline.py.
"""

import argparse
import sys
from datetime import date

from insiderpulse import config, database, pipeline
from insiderpulse.prices import PriceLoader
from insiderpulse.sec_client import SecAccessDeniedError, SecClient


def parse_date_argument(text: str) -> date:
    """Turn '2024-01-31' into a date, with a friendly error for bad input."""
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"'{text}' is not a date in YYYY-MM-DD format")


def parse_ticker_argument(text: str) -> list[str]:
    """Turn 'unh, intc' into ['UNH', 'INTC']."""
    return [ticker.strip().upper() for ticker in text.split(",") if ticker.strip()]


def build_argument_parser() -> argparse.ArgumentParser:
    """Define the commands and options the program accepts."""
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument("--ticker", type=parse_ticker_argument,
                         help="comma-separated tickers (collect: what to download; report: filter)")
    options.add_argument("--start-date", type=parse_date_argument,
                         help="first filing date, YYYY-MM-DD (collect default: %s)" % config.DEFAULT_START_DATE)
    options.add_argument("--end-date", type=parse_date_argument,
                         help="last filing date, YYYY-MM-DD (collect default: today)")
    options.add_argument("--minimum-value", type=float, default=config.DEFAULT_MINIMUM_PURCHASE_VALUE,
                         help="score: ignore purchases smaller than this many dollars")
    options.add_argument("--minimum-score", type=int, default=0,
                         help="backtest/report: only use signals with at least this score")
    options.add_argument("--holding-period", type=int, action="append",
                         help="days to hold; repeat for several (backtest default: 7, 30, 90; "
                              "report: the period used for group tables, default 30)")

    parser = argparse.ArgumentParser(
        prog="main.py",
        description="InsiderPulse: SEC insider-buying signal and backtesting engine (educational).",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("collect", parents=[options], help="download and parse Form 4 filings from the SEC")
    commands.add_parser("score", parents=[options], help="find open-market purchases, detect clusters, score them")
    commands.add_parser("backtest", parents=[options], help="measure returns after each signal vs SPY")
    commands.add_parser("report", parents=[options], help="print performance statistics")
    commands.add_parser("run", parents=[options], help="collect, score, backtest and report in one go")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the requested command. Returns the process exit code (0 = success)."""
    args = build_argument_parser().parse_args(argv)
    holding_periods = args.holding_period or config.HOLDING_PERIODS_DAYS
    connection = database.connect()

    try:
        if args.command in ("collect", "run"):
            tickers = args.ticker or config.DEFAULT_TICKERS
            start_date = args.start_date or date.fromisoformat(config.DEFAULT_START_DATE)
            end_date = args.end_date or date.today()
            pipeline.collect(connection, SecClient(), tickers, start_date, end_date)

        if args.command in ("score", "run"):
            pipeline.score(connection, args.minimum_value)

        if args.command in ("backtest", "run"):
            pipeline.backtest(connection, PriceLoader(connection), holding_periods, args.minimum_score)

        if args.command in ("report", "run"):
            focus_period = args.holding_period[0] if args.holding_period else config.DEFAULT_REPORT_HOLDING_PERIOD
            print()
            print(pipeline.report(connection, args.ticker, args.start_date, args.end_date,
                                  args.minimum_score, focus_period))
    except SecAccessDeniedError as error:
        print(f"Stopped: {error}")
        return 1
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
