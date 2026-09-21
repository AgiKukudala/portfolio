"""
Analytics: turns stored backtest results into summary statistics and a
plain-text report.

pandas is used here because grouping ("average return per insider role")
and statistics (mean, median) are exactly what it is good at. Every number
in the report is calculated from the results passed in; nothing is typed in
by hand.
"""

from dataclasses import asdict, fields

import pandas as pd

from insiderpulse import config
from insiderpulse.clusters import is_clustered
from insiderpulse.filters import classify_transaction
from insiderpulse.models import BacktestResult, Signal, Transaction
from insiderpulse.scoring import size_bucket, size_bucket_labels

ROLE_ORDER = ["CEO", "CFO", "Officer", "Director", "10% Owner", "Other"]
SMALL_SAMPLE_SIZE = 10
REPORT_WIDTH = 60


# ---------------------------------------------------------------------------
# Calculations
# ---------------------------------------------------------------------------

def results_to_dataframe(results: list[BacktestResult]) -> pd.DataFrame:
    """
    Put backtest results in a pandas table (one row per result) and add two
    helper columns used for grouping: size_bucket and cluster_label.
    """
    column_names = [field.name for field in fields(BacktestResult)]
    table = pd.DataFrame([asdict(result) for result in results], columns=column_names)
    table["size_bucket"] = [size_bucket(value) for value in table["total_value"]]
    table["cluster_label"] = [
        "Clustered" if is_clustered(size) else "Isolated" for size in table["cluster_size"]
    ]
    return table


def summarize_period(period_results: pd.DataFrame) -> dict:
    """
    Headline statistics for the results of ONE holding period.

    Win rate = share of signals whose stock beat SPY over the same days.
    Best/worst = the single best and worst stock return.
    """
    stock_returns = period_results["stock_return"]
    excess_returns = period_results["benchmark_adjusted_return"]
    return {
        "count": len(period_results),
        "average_stock_return": stock_returns.mean(),
        "average_benchmark_return": period_results["benchmark_return"].mean(),
        "average_excess_return": excess_returns.mean(),
        "median_stock_return": stock_returns.median(),
        "median_excess_return": excess_returns.median(),
        "win_rate_vs_benchmark": (excess_returns > 0).mean(),
        "positive_return_rate": (stock_returns > 0).mean(),
        "best": period_results.loc[stock_returns.idxmax()],
        "worst": period_results.loc[stock_returns.idxmin()],
    }


def performance_by_group(period_results: pd.DataFrame, column: str, order: list | None = None) -> pd.DataFrame:
    """
    Average return, average excess return and win rate for each value of
    `column` (for example each insider role). `order` sets the row order.
    """
    grouped = period_results.groupby(column).agg(
        signals=("stock_return", "size"),
        average_return=("stock_return", "mean"),
        average_excess=("benchmark_adjusted_return", "mean"),
        win_rate=("benchmark_adjusted_return", lambda returns: (returns > 0).mean()),
    )
    if order is not None:
        grouped = grouped.reindex([name for name in order if name in grouped.index])
    return grouped


def count_transaction_categories(transactions: list[Transaction]) -> dict[str, int]:
    """How many transactions fall in each category (purchase, sale, grant, ...), biggest first."""
    counts: dict[str, int] = {}
    for transaction in transactions:
        category = classify_transaction(transaction)
        counts[category] = counts.get(category, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: item[1], reverse=True))


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def format_return(value: float) -> str:
    """0.0123 -> '+1.23%'"""
    return f"{value * 100:+.2f}%"


def format_rate(value: float) -> str:
    """0.564 -> '56.4%'"""
    return f"{value * 100:.1f}%"


def describe_result(row: pd.Series) -> str:
    """One-line description of a single result, used for best/worst."""
    return (
        f"{format_return(row['stock_return'])} {row['ticker']} "
        f"filed {row['filing_date']} ({row['insider_name']}, {row['insider_role']})"
    )


def format_group_table(title: str, grouped: pd.DataFrame, period: int) -> list[str]:
    """Render one 'BY ...' table as lines of text."""
    lines = ["", f"{title} ({period}-day)"]
    lines.append(f"  {'Group':<16}{'Signals':>8}{'Avg return':>13}{'Avg excess':>13}{'Win rate':>11}")
    for group_name, row in grouped.iterrows():
        lines.append(
            f"  {str(group_name):<16}{int(row['signals']):>8}"
            f"{format_return(row['average_return']):>13}"
            f"{format_return(row['average_excess']):>13}"
            f"{format_rate(row['win_rate']):>11}"
        )
    return lines


def format_period_summary(period: int, summary: dict, benchmark: str) -> list[str]:
    """Render the headline numbers for one holding period."""
    return [
        "",
        f"{period}-DAY RESULTS ({summary['count']} signals)",
        f"  Average stock return:      {format_return(summary['average_stock_return']):>9}",
        f"  Average {benchmark} return:        {format_return(summary['average_benchmark_return']):>9}",
        f"  Average excess return:     {format_return(summary['average_excess_return']):>9}",
        f"  Median stock return:       {format_return(summary['median_stock_return']):>9}",
        f"  Median excess return:      {format_return(summary['median_excess_return']):>9}",
        f"  Win rate vs {benchmark}:           {format_rate(summary['win_rate_vs_benchmark']):>9}",
        f"  Positive-return rate:      {format_rate(summary['positive_return_rate']):>9}",
        f"  Best:  {describe_result(summary['best'])}",
        f"  Worst: {describe_result(summary['worst'])}",
    ]


def build_report(
    transactions: list[Transaction],
    signals: list[Signal],
    results: list[BacktestResult],
    focus_period: int,
    filter_description: str,
) -> str:
    """
    Build the full text report.

    Inputs are already filtered by the caller (ticker, dates, minimum score).
    `focus_period` chooses which holding period the group tables use.
    """
    benchmark = config.BENCHMARK_TICKER
    lines = ["=" * REPORT_WIDTH, "INSIDERPULSE BACKTEST REPORT", "=" * REPORT_WIDTH]
    lines.append(f"Filters: {filter_description}")
    lines.append(f"Benchmark: {benchmark}. Entry: first trading day after the Form 4 filing date.")

    lines += ["", "DATA"]
    lines.append(f"  Transactions analyzed:          {len(transactions):>7,}")
    for category, count in count_transaction_categories(transactions).items():
        lines.append(f"    {category + ':':<30}{count:>7,}")
    clustered_count = sum(1 for signal in signals if is_clustered(signal.cluster_size))
    lines.append(f"  Qualifying purchases (signals): {len(signals):>7,}")
    lines.append(f"    Part of a cluster:            {clustered_count:>7,}")

    table = results_to_dataframe(results)
    lines.append(f"  Signals with backtest results:  {table['source_filing'].nunique():>7,}")

    if table.empty:
        lines += ["", "No backtest results match these filters yet.",
                  "Run `python main.py collect`, `score` and `backtest` first."]
        return "\n".join(lines)

    for period in sorted(table["holding_period_days"].unique()):
        period_results = table[table["holding_period_days"] == period]
        lines += format_period_summary(int(period), summarize_period(period_results), benchmark)

    focus_results = table[table["holding_period_days"] == focus_period]
    if focus_results.empty:
        lines += ["", f"No {focus_period}-day results to break down by group."]
    else:
        lines += format_group_table(
            "BY INSIDER ROLE", performance_by_group(focus_results, "insider_role", ROLE_ORDER), focus_period
        )
        lines += format_group_table(
            "BY PURCHASE SIZE", performance_by_group(focus_results, "size_bucket", size_bucket_labels()), focus_period
        )
        score_order = sorted(focus_results["insider_score"].unique(), reverse=True)
        lines += format_group_table(
            "BY SIGNAL SCORE", performance_by_group(focus_results, "insider_score", score_order), focus_period
        )
        lines += format_group_table(
            "CLUSTERED VS ISOLATED",
            performance_by_group(focus_results, "cluster_label", ["Clustered", "Isolated"]),
            focus_period,
        )

    lines += [
        "",
        f"Groups with fewer than {SMALL_SAMPLE_SIZE} signals are too small to draw conclusions from.",
        "Historical results do not imply future profitability. InsiderPulse is an educational",
        "research/backtesting system and does not provide financial advice or execute real trades.",
    ]
    return "\n".join(lines)
