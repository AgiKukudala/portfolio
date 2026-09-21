"""Tests for analytics.py. Every expected value below can be checked by hand."""

from datetime import date

import pytest

from insiderpulse.analytics import (
    build_report,
    performance_by_group,
    results_to_dataframe,
    summarize_period,
)
from insiderpulse.models import BacktestResult


def make_result(stock_return, benchmark_return, role="CEO", cluster_size=1, value=200_000.0,
                score=4, period=30, filing="f1", ticker="EXMP") -> BacktestResult:
    return BacktestResult(
        ticker=ticker, insider_name="Someone", insider_role=role,
        transaction_date=date(2024, 1, 3), filing_date=date(2024, 1, 5), source_filing=filing,
        total_value=value, insider_score=score, cluster_size=cluster_size,
        holding_period_days=period, entry_date=date(2024, 1, 8), exit_date=date(2024, 2, 7),
        starting_price=100.0, ending_price=100.0 * (1 + stock_return), stock_return=stock_return,
        benchmark_ticker="SPY", benchmark_return=benchmark_return,
        benchmark_adjusted_return=stock_return - benchmark_return,
    )


RESULTS = [
    make_result(0.10, 0.02, role="CEO", cluster_size=3, value=1_500_000.0, score=9, filing="f1", ticker="AAA"),
    make_result(-0.05, 0.01, role="Director", filing="f2", ticker="BBB"),
    make_result(0.02, 0.03, role="Director", filing="f3", ticker="CCC"),
]


def test_summary_statistics():
    summary = summarize_period(results_to_dataframe(RESULTS))

    assert summary["count"] == 3
    assert summary["average_stock_return"] == pytest.approx(0.07 / 3)
    assert summary["average_benchmark_return"] == pytest.approx(0.02)
    assert summary["average_excess_return"] == pytest.approx(0.01 / 3)   # (0.08 - 0.06 - 0.01) / 3
    assert summary["median_stock_return"] == pytest.approx(0.02)
    assert summary["median_excess_return"] == pytest.approx(-0.01)
    assert summary["win_rate_vs_benchmark"] == pytest.approx(1 / 3)       # only AAA beat SPY
    assert summary["positive_return_rate"] == pytest.approx(2 / 3)
    assert summary["best"]["ticker"] == "AAA"
    assert summary["worst"]["ticker"] == "BBB"


def test_performance_by_role():
    grouped = performance_by_group(results_to_dataframe(RESULTS), "insider_role", ["CEO", "CFO", "Director"])

    assert list(grouped.index) == ["CEO", "Director"]      # CFO has no results, so no row
    assert grouped.loc["Director", "signals"] == 2
    assert grouped.loc["Director", "average_excess"] == pytest.approx((-0.06 - 0.01) / 2)
    assert grouped.loc["CEO", "win_rate"] == 1.0


def test_helper_columns_for_size_and_clusters():
    table = results_to_dataframe(RESULTS)
    assert list(table["size_bucket"]) == ["$1M+", "$100K-$500K", "$100K-$500K"]
    assert list(table["cluster_label"]) == ["Clustered", "Isolated", "Isolated"]


def test_report_contains_calculated_numbers_and_disclaimer():
    text = build_report([], [], RESULTS, focus_period=30, filter_description="test")

    assert "30-DAY RESULTS (3 signals)" in text
    assert "+0.33%" in text           # average excess return 0.01 / 3
    assert "33.3%" in text            # win rate vs SPY
    assert "BY INSIDER ROLE" in text
    assert "does not provide financial advice" in text


def test_report_with_no_results_says_so():
    text = build_report([], [], [], focus_period=30, filter_description="test")
    assert "No backtest results" in text
