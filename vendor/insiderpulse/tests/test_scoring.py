"""Tests for scoring.py and clusters.py."""

from datetime import date

import pytest

from insiderpulse.clusters import assign_cluster_sizes, is_clustered
from insiderpulse.models import Signal
from insiderpulse.scoring import (
    role_points,
    score_purchase,
    score_signals,
    size_bucket,
    size_points,
)


def make_signal(**changes) -> Signal:
    values = dict(
        ticker="EXMP",
        company_name="Example Corp",
        insider_name="Doe Jane",
        insider_role="CEO",
        transaction_date=date(2024, 1, 3),
        filing_date=date(2024, 1, 5),
        shares=10_000.0,
        average_price=75.0,
        total_value=750_000.0,
        source_filing="filing-1",
    )
    values.update(changes)
    return Signal(**values)


# --- role scoring -----------------------------------------------------------

@pytest.mark.parametrize(
    "role, expected",
    [("CEO", 3), ("CFO", 2), ("Officer", 2), ("Director", 1), ("10% Owner", 0), ("Other", 0), ("???", 0)],
)
def test_role_points(role, expected):
    assert role_points(role) == expected


# --- size scoring -----------------------------------------------------------

@pytest.mark.parametrize(
    "value, expected",
    [
        (50_000, 0),
        (99_999.99, 0),
        (100_000, 1),
        (499_999, 1),
        (500_000, 2),
        (999_999, 2),
        (1_000_000, 3),
        (25_000_000, 3),
    ],
)
def test_size_points_boundaries(value, expected):
    assert size_points(value) == expected


def test_size_bucket_labels_match_thresholds():
    assert size_bucket(50_000) == "Under $100K"
    assert size_bucket(100_000) == "$100K-$500K"
    assert size_bucket(750_000) == "$500K-$1M"
    assert size_bucket(2_000_000) == "$1M+"


# --- full score with explanation -------------------------------------------

def test_score_matches_example_from_spec():
    result = score_purchase(make_signal(), cluster_size=3)

    assert result.total == 8
    assert result.breakdown == [
        "CEO purchase: +3",
        "$750,000 purchase: +2",
        "3 insiders buying within 14 days: +3",
    ]


def test_lone_small_director_purchase():
    signal = make_signal(insider_role="Director", total_value=40_000.0)
    result = score_purchase(signal, cluster_size=1)

    assert result.total == 1
    assert "insiders buying" not in " ".join(result.breakdown)


def test_score_signals_fills_every_signal():
    signals = [make_signal(), make_signal(source_filing="filing-2", insider_role="Director")]
    for signal in signals:
        signal.cluster_size = 1

    score_signals(signals)

    assert [s.score for s in signals] == [5, 3]
    assert signals[0].score_breakdown[0] == "CEO purchase: +3"


# --- cluster detection -----------------------------------------------------

def test_spec_example_ceo_director_cfo_cluster():
    ceo = make_signal(insider_name="CEO A", transaction_date=date(2024, 1, 3),
                      filing_date=date(2024, 1, 5), source_filing="f1")
    director = make_signal(insider_name="Director B", transaction_date=date(2024, 1, 5),
                           filing_date=date(2024, 1, 7), source_filing="f2")
    cfo = make_signal(insider_name="CFO C", transaction_date=date(2024, 1, 7),
                      filing_date=date(2024, 1, 9), source_filing="f3")

    assign_cluster_sizes([ceo, director, cfo], window_days=14)

    # The CEO bought first: at that moment nobody else had bought yet.
    assert ceo.cluster_size == 1
    # The director's filing could see the CEO's purchase.
    assert director.cluster_size == 2
    # The CFO's filing could see both earlier purchases.
    assert cfo.cluster_size == 3
    assert is_clustered(cfo.cluster_size)
    assert not is_clustered(ceo.cluster_size)


def test_purchases_outside_window_are_not_a_cluster():
    first = make_signal(insider_name="A", transaction_date=date(2024, 1, 1),
                        filing_date=date(2024, 1, 2), source_filing="f1")
    later = make_signal(insider_name="B", transaction_date=date(2024, 2, 1),
                        filing_date=date(2024, 2, 2), source_filing="f2")

    assign_cluster_sizes([first, later], window_days=14)

    assert later.cluster_size == 1


def test_different_companies_never_cluster_together():
    a = make_signal(ticker="AAA", insider_name="A", source_filing="f1")
    b = make_signal(ticker="BBB", insider_name="B", source_filing="f2")

    assign_cluster_sizes([a, b], window_days=14)

    assert a.cluster_size == 1 and b.cluster_size == 1


def test_same_insider_buying_twice_is_not_a_cluster():
    first = make_signal(source_filing="f1", filing_date=date(2024, 1, 5))
    second = make_signal(source_filing="f2", transaction_date=date(2024, 1, 8),
                         filing_date=date(2024, 1, 10))

    assign_cluster_sizes([first, second], window_days=14)

    assert second.cluster_size == 1


def test_late_filing_is_not_used_before_it_was_public():
    # B traded earlier but filed late; A's signal must not know about B yet.
    a = make_signal(insider_name="A", transaction_date=date(2024, 1, 5),
                    filing_date=date(2024, 1, 6), source_filing="f1")
    b = make_signal(insider_name="B", transaction_date=date(2024, 1, 4),
                    filing_date=date(2024, 1, 20), source_filing="f2")

    assign_cluster_sizes([a, b], window_days=14)

    assert a.cluster_size == 1
    assert b.cluster_size == 2
