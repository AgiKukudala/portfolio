"""
Historical price data.

Only `download_daily_closes()` knows about yfinance (a free library that
reads Yahoo Finance data, no API key needed). Everything else in the
program asks the PriceLoader for prices, so swapping the data source means
changing one function.

Rules for dates that are not trading days (weekends, holidays):
    We use the closing price of the FIRST trading day ON OR AFTER the
    requested date, looking at most config.MAX_DAYS_TO_NEXT_TRADING_DAY
    calendar days ahead. We never roll backwards, because an earlier price
    would be a price from before the moment we are simulating.
    If nothing is found (bad ticker, delisted company, date in the future)
    the answer is None and the caller skips that calculation.

Prices are "adjusted closes": past prices are adjusted for stock splits
and dividends so that returns across those events are correct.
"""

import logging
import math
import sqlite3
from datetime import date, timedelta
from typing import Callable

import yfinance

from insiderpulse import config, database
from insiderpulse.models import PricePoint

# yfinance prints noisy errors for unknown tickers; we report problems ourselves.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Any function with this shape can be used as the price source (tests pass a fake one).
DownloadFunction = Callable[[str, date, date], dict[date, float]]


def download_daily_closes(ticker: str, start: date, end: date) -> dict[date, float]:
    """
    Download adjusted daily closing prices from Yahoo Finance via yfinance.

    Returns {trading_day: close_price}. Returns an empty dict when the ticker
    is unknown, delisted, or the download fails, instead of crashing.
    """
    try:
        history = yfinance.Ticker(ticker).history(
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),  # yfinance's end date is exclusive
            auto_adjust=True,
        )
    except Exception as error:  # yfinance can raise many different network/data errors
        print(f"  Price download failed for {ticker}: {error}")
        return {}

    if history.empty or "Close" not in history.columns:
        return {}

    closes = {}
    for timestamp, close_price in history["Close"].items():
        if close_price is None or math.isnan(close_price):
            continue
        closes[timestamp.date()] = float(close_price)
    return closes


class PriceLoader:
    """
    Answers "what was the price of TICKER on DATE?" using a cache.

    Cache levels:
      1. SQLite `prices` table: survives between runs
      2. a dictionary in memory: avoids re-reading SQLite for every lookup
    A range is only downloaded if no earlier download already covered it.
    """

    def __init__(
        self,
        connection: sqlite3.Connection,
        download_function: DownloadFunction = download_daily_closes,
        today: date | None = None,
    ):
        self.connection = connection
        self.download_function = download_function
        # Today's bar may still be changing while the market is open, so the
        # newest price we ever use is yesterday's close.
        self.last_complete_day = (today or date.today()) - timedelta(days=1)
        self.memory_cache: dict[str, dict[date, float]] = {}
        self.tickers_without_data: set[str] = set()

    def load_history(self, ticker: str, start: date, end: date) -> None:
        """Make sure prices for start..end are cached, downloading them only if needed."""
        end = min(end, self.last_complete_day)
        if start > end:
            return  # the whole range is in the future
        if ticker in self.tickers_without_data:
            return  # already failed this run; don't ask Yahoo again
        if database.price_range_is_cached(self.connection, ticker, start, end):
            return

        closes = self.download_function(ticker, start, end)
        closes = {day: price for day, price in closes.items() if start <= day <= end}
        if not closes:
            # Unknown/delisted ticker or a temporary outage. We don't record the
            # range as cached, so a later run will try again.
            print(f"  No price data for {ticker} between {start} and {end}")
            self.tickers_without_data.add(ticker)
            return

        database.save_prices(self.connection, ticker, closes)
        database.record_price_download(self.connection, ticker, start, end)
        self.memory_cache.pop(ticker, None)  # force a fresh read from SQLite

    def cached_closes(self, ticker: str) -> dict[date, float]:
        """All cached closing prices for a ticker, read from SQLite once per run."""
        if ticker not in self.memory_cache:
            self.memory_cache[ticker] = database.load_prices(self.connection, ticker)
        return self.memory_cache[ticker]

    def get_price(self, ticker: str, target_date: date) -> PricePoint | None:
        """
        Closing price on `target_date`, or on the next trading day if the
        market was closed that day. None if no price is available.
        """
        last_day_to_check = target_date + timedelta(days=config.MAX_DAYS_TO_NEXT_TRADING_DAY)
        self.load_history(ticker, target_date, last_day_to_check)
        closes = self.cached_closes(ticker)

        for days_ahead in range(config.MAX_DAYS_TO_NEXT_TRADING_DAY + 1):
            candidate = target_date + timedelta(days=days_ahead)
            if candidate > self.last_complete_day:
                return None  # this price does not exist yet
            if candidate in closes:
                return PricePoint(trade_date=candidate, price=closes[candidate])
        return None

    def get_forward_prices(
        self, ticker: str, start_date: date, periods: list[int]
    ) -> tuple[PricePoint | None, dict[int, PricePoint | None]]:
        """
        Find the entry price on `start_date` and the price `period` calendar
        days after the actual entry day, for each holding period.

        Returns (entry, {period: exit_price_or_None}). If there is no entry
        price, every exit is None as well.
        """
        entry = self.get_price(ticker, start_date)
        exits: dict[int, PricePoint | None] = {}
        for period in periods:
            if entry is None:
                exits[period] = None
            else:
                exits[period] = self.get_price(ticker, entry.trade_date + timedelta(days=period))
        return entry, exits
