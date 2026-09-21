"""
Cluster detection: finds times when several different insiders bought the
same company's stock within a few days of each other.

The idea: one insider buying could be personal. Several insiders buying at
once is a stronger hint that people inside the company think the stock is cheap.

Avoiding look-ahead bias: when we judge a purchase, we only count other
purchases that were already PUBLIC (filed with the SEC) on or before the
day this purchase was filed. A purchase disclosed next week cannot be used
to judge a purchase disclosed today.
"""

from datetime import timedelta

from insiderpulse import config
from insiderpulse.models import Signal


def find_cluster_insiders(signal: Signal, same_ticker_signals: list[Signal], window_days: int) -> set[str]:
    """
    Return the names of distinct insiders (including this signal's insider)
    who bought this stock within `window_days` of this purchase and whose
    filing was already public when this purchase was filed.
    """
    window = timedelta(days=window_days)
    insiders = {signal.insider_name}
    for other in same_ticker_signals:
        if other.filing_date > signal.filing_date:
            continue  # not public yet at the time of this signal
        if abs(other.transaction_date - signal.transaction_date) <= window:
            insiders.add(other.insider_name)
    return insiders


def assign_cluster_sizes(signals: list[Signal], window_days: int = config.CLUSTER_WINDOW_DAYS) -> None:
    """
    Set `cluster_size` on every signal: how many distinct insiders were
    buying the same stock around the same time (1 means buying alone).
    """
    signals_by_ticker: dict[str, list[Signal]] = {}
    for signal in signals:
        signals_by_ticker.setdefault(signal.ticker, []).append(signal)

    for signal in signals:
        insiders = find_cluster_insiders(signal, signals_by_ticker[signal.ticker], window_days)
        signal.cluster_size = len(insiders)


def is_clustered(cluster_size: int, minimum_insiders: int = config.CLUSTER_MIN_INSIDERS) -> bool:
    """True if enough distinct insiders were buying to count as a cluster."""
    return cluster_size >= minimum_insiders
