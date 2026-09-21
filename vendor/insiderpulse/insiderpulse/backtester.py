"""
Backtester: measures what happened to each stock after an insider purchase
became public, and compares it with the market (SPY) over the same days.

For every signal and every holding period (7, 30, 90 days):

    entry day   = first trading day AFTER the Form 4 filing date
    exit day    = first trading day on/after entry day + holding period
    stock return     = (exit price - entry price) / entry price
    SPY return       = same formula, same two days, for SPY
    adjusted return  = stock return - SPY return

This is a paper calculation. No orders are placed anywhere.
"""

from datetime import date, timedelta

from insiderpulse import config
from insiderpulse.models import BacktestResult, Signal
from insiderpulse.prices import PriceLoader


def calculate_return(starting_price: float, ending_price: float) -> float:
    """Fractional return: 100 -> 108 gives 0.08 (8%)."""
    if starting_price <= 0:
        raise ValueError("starting price must be positive")
    return (ending_price - starting_price) / starting_price


def calculate_benchmark_adjusted_return(stock_return: float, benchmark_return: float) -> float:
    """How much better (or worse) the stock did than the benchmark: 0.08 - 0.03 = 0.05."""
    return stock_return - benchmark_return


def entry_target_date(signal: Signal) -> date:
    """
    The earliest day we are allowed to "buy".

    We use the filing date, not the trade date: the public only learns about
    an insider purchase when the Form 4 is filed. We also wait one extra day
    because a filing can arrive after the market has closed.
    """
    return signal.filing_date + timedelta(days=config.ENTRY_DELAY_DAYS)


def preload_prices(
    signals: list[Signal], price_loader: PriceLoader, holding_periods: list[int], benchmark_ticker: str
) -> None:
    """
    Download each ticker's full needed date range with ONE request per ticker
    (instead of one request per signal), plus one range for the benchmark.
    """
    if not signals:
        return
    # Room for the longest holding period plus weekend/holiday roll-forward
    # at both the entry and the exit.
    extra_days = max(holding_periods) + 2 * config.MAX_DAYS_TO_NEXT_TRADING_DAY

    date_ranges: dict[str, tuple[date, date]] = {}
    for signal in signals:
        start = entry_target_date(signal)
        end = start + timedelta(days=extra_days)
        if signal.ticker in date_ranges:
            old_start, old_end = date_ranges[signal.ticker]
            start, end = min(start, old_start), max(end, old_end)
        date_ranges[signal.ticker] = (start, end)

    all_starts = [start for start, _ in date_ranges.values()]
    all_ends = [end for _, end in date_ranges.values()]
    date_ranges[benchmark_ticker] = (min(all_starts), max(all_ends))

    for ticker, (start, end) in date_ranges.items():
        price_loader.load_history(ticker, start, end)


def backtest_signal(
    signal: Signal, price_loader: PriceLoader, holding_periods: list[int], benchmark_ticker: str
) -> list[BacktestResult]:
    """
    Backtest one signal for every holding period.

    Returns one BacktestResult per holding period that has complete price
    data. Periods whose exit day has not happened yet (or has no price) are
    left out, so a missing price can never turn into a fake 0% return.
    """
    entry, exits = price_loader.get_forward_prices(signal.ticker, entry_target_date(signal), holding_periods)
    if entry is None:
        return []
    benchmark_entry = price_loader.get_price(benchmark_ticker, entry.trade_date)
    if benchmark_entry is None:
        return []

    results = []
    for period in holding_periods:
        exit_point = exits[period]
        if exit_point is None:
            continue
        # Measure the benchmark over exactly the same two days as the stock.
        benchmark_exit = price_loader.get_price(benchmark_ticker, exit_point.trade_date)
        if benchmark_exit is None:
            continue

        stock_return = calculate_return(entry.price, exit_point.price)
        benchmark_return = calculate_return(benchmark_entry.price, benchmark_exit.price)
        results.append(
            BacktestResult(
                ticker=signal.ticker,
                insider_name=signal.insider_name,
                insider_role=signal.insider_role,
                transaction_date=signal.transaction_date,
                filing_date=signal.filing_date,
                source_filing=signal.source_filing,
                total_value=signal.total_value,
                insider_score=signal.score,
                cluster_size=signal.cluster_size,
                holding_period_days=period,
                entry_date=entry.trade_date,
                exit_date=exit_point.trade_date,
                starting_price=entry.price,
                ending_price=exit_point.price,
                stock_return=stock_return,
                benchmark_ticker=benchmark_ticker,
                benchmark_return=benchmark_return,
                benchmark_adjusted_return=calculate_benchmark_adjusted_return(stock_return, benchmark_return),
            )
        )
    return results


def run_backtest(
    signals: list[Signal],
    price_loader: PriceLoader,
    holding_periods: list[int] = config.HOLDING_PERIODS_DAYS,
    benchmark_ticker: str = config.BENCHMARK_TICKER,
) -> tuple[list[BacktestResult], int]:
    """
    Backtest every signal.

    Returns (all results, number of signals that produced no result at all
    because price data was missing or the filing is too recent).
    """
    preload_prices(signals, price_loader, holding_periods, benchmark_ticker)

    results = []
    signals_without_results = 0
    for signal in signals:
        signal_results = backtest_signal(signal, price_loader, holding_periods, benchmark_ticker)
        if not signal_results:
            signals_without_results += 1
        results.extend(signal_results)
    return results, signals_without_results
