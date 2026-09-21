"""
Tests for backtester.py and prices.py.

A fake price source replaces yfinance, so these tests never use the internet
and every expected number can be checked by hand.
"""

from datetime import date, timedelta

import pytest

from insiderpulse import database
from insiderpulse.backtester import (
    backtest_signal,
    calculate_benchmark_adjusted_return,
    calculate_return,
    entry_target_date,
    run_backtest,
)
from insiderpulse.models import Signal
from insiderpulse.prices import PriceLoader

HOLIDAY = date(2024, 1, 15)  # Martin Luther King Jr. Day: market closed


def trading_days(start: date, end: date) -> list[date]:
    """Weekdays between start and end, minus one holiday."""
    days = []
    day = start
    while day <= end:
        if day.weekday() < 5 and day != HOLIDAY:
            days.append(day)
        day += timedelta(days=1)
    return days


def flat_prices(price: float) -> dict[date, float]:
    return {day: price for day in trading_days(date(2024, 1, 1), date(2024, 6, 28))}


class FakePriceSource:
    """Behaves like download_daily_closes() but reads from a dictionary and counts calls."""

    def __init__(self, prices_by_ticker: dict[str, dict[date, float]]):
        self.prices_by_ticker = prices_by_ticker
        self.calls = []

    def __call__(self, ticker: str, start: date, end: date) -> dict[date, float]:
        self.calls.append((ticker, start, end))
        prices = self.prices_by_ticker.get(ticker, {})
        return {day: price for day, price in prices.items() if start <= day <= end}


def make_loader(prices_by_ticker, today=date(2024, 3, 1)):
    source = FakePriceSource(prices_by_ticker)
    loader = PriceLoader(database.connect(":memory:"), download_function=source, today=today)
    return loader, source


def make_signal(**changes) -> Signal:
    values = dict(
        ticker="EXMP", company_name="Example Corp", insider_name="Doe Jane", insider_role="CEO",
        transaction_date=date(2024, 1, 3), filing_date=date(2024, 1, 5), shares=1000.0,
        average_price=100.0, total_value=100_000.0, source_filing="f1", cluster_size=1, score=4,
    )
    values.update(changes)
    return Signal(**values)


# --- return formulas -------------------------------------------------------

def test_calculate_return_matches_spec_example():
    assert calculate_return(100.0, 108.0) == pytest.approx(0.08)


def test_calculate_return_can_be_negative():
    assert calculate_return(50.0, 40.0) == pytest.approx(-0.20)


def test_calculate_return_rejects_zero_starting_price():
    with pytest.raises(ValueError):
        calculate_return(0.0, 10.0)


def test_benchmark_adjusted_return_matches_spec_example():
    assert calculate_benchmark_adjusted_return(0.08, 0.03) == pytest.approx(0.05)


# --- price lookups -----------------------------------------------------------

def test_weekend_rolls_forward_to_monday():
    loader, _ = make_loader({"EXMP": flat_prices(10.0)})
    point = loader.get_price("EXMP", date(2024, 1, 6))   # Saturday
    assert point.trade_date == date(2024, 1, 8)          # Monday


def test_holiday_rolls_forward_to_next_trading_day():
    loader, _ = make_loader({"EXMP": flat_prices(10.0)})
    assert loader.get_price("EXMP", HOLIDAY).trade_date == date(2024, 1, 16)


def test_unknown_ticker_returns_none():
    loader, _ = make_loader({})
    assert loader.get_price("NOPE", date(2024, 1, 8)) is None


def test_long_gap_in_data_returns_none():
    # Prices stop on Jan 31, like a company that was delisted.
    prices = {day: 10.0 for day in trading_days(date(2024, 1, 1), date(2024, 1, 31))}
    loader, _ = make_loader({"EXMP": prices})
    assert loader.get_price("EXMP", date(2024, 2, 14)) is None


def test_future_date_returns_none():
    loader, _ = make_loader({"EXMP": flat_prices(10.0)}, today=date(2024, 3, 1))
    assert loader.get_price("EXMP", date(2024, 3, 15)) is None


def test_price_cache_prevents_repeat_downloads():
    loader, source = make_loader({"EXMP": flat_prices(10.0)})
    loader.load_history("EXMP", date(2024, 1, 1), date(2024, 2, 28))

    loader.get_price("EXMP", date(2024, 1, 10))
    loader.get_price("EXMP", date(2024, 2, 1))
    loader.get_price("EXMP", date(2024, 1, 10))

    assert len(source.calls) == 1


def test_get_forward_prices_measures_from_actual_entry_day():
    loader, _ = make_loader({"EXMP": flat_prices(10.0)})
    entry, exits = loader.get_forward_prices("EXMP", date(2024, 1, 6), [7, 30])

    assert entry.trade_date == date(2024, 1, 8)
    assert exits[7].trade_date == date(2024, 1, 16)    # Jan 15 is the holiday
    assert exits[30].trade_date == date(2024, 2, 7)


# --- backtesting a signal ----------------------------------------------------

def build_example_prices():
    stock = flat_prices(100.0)
    stock[date(2024, 1, 16)] = 110.0    # 7-day exit
    stock[date(2024, 2, 7)] = 90.0      # 30-day exit
    spy = flat_prices(400.0)
    spy[date(2024, 1, 16)] = 404.0
    spy[date(2024, 2, 7)] = 420.0
    return {"EXMP": stock, "SPY": spy}


def test_entry_is_after_the_filing_date():
    # Look-ahead check: we can never buy on or before the day the filing became public.
    signal = make_signal(filing_date=date(2024, 1, 5))
    assert entry_target_date(signal) > signal.filing_date


def test_backtest_signal_calculates_stock_spy_and_excess_returns():
    loader, _ = make_loader(build_example_prices(), today=date(2024, 3, 1))

    results = backtest_signal(make_signal(), loader, [7, 30, 90], "SPY")

    # 90-day exit (April) is after "today" (March 1), so it is skipped, not faked.
    assert [r.holding_period_days for r in results] == [7, 30]

    week = results[0]
    assert week.entry_date == date(2024, 1, 8)     # Friday filing -> Monday entry
    assert week.exit_date == date(2024, 1, 16)
    assert week.stock_return == pytest.approx(0.10)
    assert week.benchmark_return == pytest.approx(0.01)
    assert week.benchmark_adjusted_return == pytest.approx(0.09)

    month = results[1]
    assert month.stock_return == pytest.approx(-0.10)
    assert month.benchmark_return == pytest.approx(0.05)
    assert month.benchmark_adjusted_return == pytest.approx(-0.15)


def test_signal_without_price_data_produces_no_results():
    loader, _ = make_loader({"SPY": flat_prices(400.0)})

    results, skipped = run_backtest([make_signal(ticker="DELISTED")], loader, [7, 30], "SPY")

    assert results == []
    assert skipped == 1


def test_run_backtest_downloads_each_ticker_once():
    loader, source = make_loader(build_example_prices(), today=date(2024, 6, 1))
    signals = [
        make_signal(source_filing="f1"),
        make_signal(source_filing="f2", filing_date=date(2024, 2, 1)),
    ]

    results, skipped = run_backtest(signals, loader, [7, 30, 90], "SPY")

    assert skipped == 0
    assert len(results) == 6
    downloaded_tickers = [ticker for ticker, _, _ in source.calls]
    assert sorted(downloaded_tickers) == ["EXMP", "SPY"]
