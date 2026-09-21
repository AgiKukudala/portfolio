"""
Scoring engine: gives every insider purchase a simple, explainable score.

    score = role points + purchase-size points + cluster bonus

All point values come from config.py. Every point awarded is also recorded
as a line of text, so you can always see *why* a purchase got its score:

    CEO purchase: +3
    $750,000 purchase: +2
    3 insiders buying within 14 days: +3
"""

from dataclasses import dataclass

from insiderpulse import config
from insiderpulse.clusters import is_clustered
from insiderpulse.models import Signal


@dataclass
class ScoreResult:
    total: int
    breakdown: list[str]


def role_points(role: str) -> int:
    """Points for the insider's role (CEO, CFO, Director, ...). Unknown roles get 0."""
    return config.ROLE_POINTS.get(role, 0)


def size_points(dollar_value: float) -> int:
    """Points for the purchase size, using the thresholds in config.SIZE_POINTS."""
    for threshold, points in config.SIZE_POINTS:
        if dollar_value >= threshold:
            return points
    return 0


def cluster_points(cluster_size: int) -> int:
    """The cluster bonus if enough distinct insiders were buying, otherwise 0."""
    if is_clustered(cluster_size):
        return config.CLUSTER_BONUS_POINTS
    return 0


def short_dollars(amount: float) -> str:
    """1_000_000 -> '$1M', 500_000 -> '$500K' (used for size bucket labels)."""
    if amount >= 1_000_000:
        return f"${amount / 1_000_000:g}M"
    return f"${amount / 1_000:g}K"


def size_bucket(dollar_value: float) -> str:
    """
    Name the purchase-size group a dollar value falls in, e.g. '$100K-$500K'.
    The groups match the scoring thresholds so the report lines up with the score.
    """
    thresholds = [threshold for threshold, _ in config.SIZE_POINTS]
    for index, threshold in enumerate(thresholds):
        if dollar_value >= threshold:
            if index == 0:
                return f"{short_dollars(threshold)}+"
            return f"{short_dollars(threshold)}-{short_dollars(thresholds[index - 1])}"
    return f"Under {short_dollars(thresholds[-1])}"


def size_bucket_labels() -> list[str]:
    """All size bucket names from largest to smallest (used to order report tables)."""
    labels = [size_bucket(threshold) for threshold, _ in config.SIZE_POINTS]
    labels.append(size_bucket(0))
    return labels


def score_purchase(signal: Signal, cluster_size: int) -> ScoreResult:
    """
    Score one insider purchase.

    Inputs:  the purchase (Signal) and how many distinct insiders were buying
             the same stock at the same time (from clusters.py).
    Output:  a ScoreResult with the total and one explanation line per rule.
    """
    breakdown = []

    points_for_role = role_points(signal.insider_role)
    breakdown.append(f"{signal.insider_role} purchase: +{points_for_role}")

    points_for_size = size_points(signal.total_value)
    breakdown.append(f"${signal.total_value:,.0f} purchase: +{points_for_size}")

    points_for_cluster = cluster_points(cluster_size)
    if points_for_cluster > 0:
        breakdown.append(
            f"{cluster_size} insiders buying within {config.CLUSTER_WINDOW_DAYS} days: +{points_for_cluster}"
        )

    total = points_for_role + points_for_size + points_for_cluster
    return ScoreResult(total=total, breakdown=breakdown)


def score_signals(signals: list[Signal]) -> None:
    """Fill in `score` and `score_breakdown` on every signal (cluster sizes must be set first)."""
    for signal in signals:
        result = score_purchase(signal, signal.cluster_size)
        signal.score = result.total
        signal.score_breakdown = result.breakdown
