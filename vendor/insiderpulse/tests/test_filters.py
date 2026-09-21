"""Tests for filters.py: purchase classification and combining rows into signals."""

from datetime import date

from insiderpulse.filters import (
    GRANT_OR_AWARD,
    OPEN_MARKET_PURCHASE,
    OPTION_EXERCISE,
    SALE,
    TAX_WITHHOLDING,
    classify_transaction,
    combine_purchases_into_signals,
    filter_by_minimum_value,
    filter_open_market_purchases,
    is_open_market_purchase,
)
from insiderpulse.models import Transaction


def make_transaction(**changes) -> Transaction:
    """A valid open-market purchase; pass keyword arguments to change fields."""
    values = dict(
        company_name="Example Corp",
        ticker="EXMP",
        insider_name="Doe Jane",
        insider_role="CEO",
        transaction_date=date(2024, 3, 4),
        filing_date=date(2024, 3, 6),
        transaction_code="P",
        transaction_type="Open-market purchase",
        acquired_or_disposed="A",
        is_derivative=False,
        security_title="Common Stock",
        shares=1000.0,
        price_per_share=50.0,
        source_filing="filing-1",
        line_number=0,
    )
    values.update(changes)
    return Transaction(**values)


def test_open_market_purchase_is_recognized():
    assert is_open_market_purchase(make_transaction())
    assert classify_transaction(make_transaction()) == OPEN_MARKET_PURCHASE


def test_sale_is_not_a_purchase():
    sale = make_transaction(transaction_code="S", acquired_or_disposed="D")
    assert not is_open_market_purchase(sale)
    assert classify_transaction(sale) == SALE


def test_option_exercise_is_not_a_purchase():
    exercise = make_transaction(transaction_code="M", is_derivative=True)
    assert not is_open_market_purchase(exercise)
    assert classify_transaction(exercise) == OPTION_EXERCISE


def test_stock_grant_is_not_a_purchase():
    grant = make_transaction(transaction_code="A", price_per_share=0.0)
    assert not is_open_market_purchase(grant)
    assert classify_transaction(grant) == GRANT_OR_AWARD


def test_tax_withholding_is_not_a_purchase():
    withholding = make_transaction(transaction_code="F", acquired_or_disposed="D")
    assert classify_transaction(withholding) == TAX_WITHHOLDING


def test_purchase_code_on_a_derivative_row_is_rejected():
    assert not is_open_market_purchase(make_transaction(is_derivative=True))


def test_purchase_with_missing_or_zero_numbers_is_rejected():
    assert not is_open_market_purchase(make_transaction(price_per_share=None))
    assert not is_open_market_purchase(make_transaction(price_per_share=0.0))
    assert not is_open_market_purchase(make_transaction(shares=None))
    assert not is_open_market_purchase(make_transaction(transaction_date=None))


def test_filter_keeps_only_purchases():
    transactions = [
        make_transaction(),
        make_transaction(transaction_code="S", acquired_or_disposed="D"),
        make_transaction(transaction_code="A"),
    ]
    assert len(filter_open_market_purchases(transactions)) == 1


def test_rows_from_one_filing_are_combined_into_one_signal():
    rows = [
        make_transaction(shares=1000.0, price_per_share=10.0, line_number=0),
        make_transaction(shares=500.0, price_per_share=13.0, line_number=1,
                         transaction_date=date(2024, 3, 5)),
        make_transaction(source_filing="filing-2", insider_name="Roe Rick"),
    ]

    signals = combine_purchases_into_signals(rows)

    assert len(signals) == 2
    combined = next(s for s in signals if s.source_filing == "filing-1")
    assert combined.shares == 1500.0
    assert combined.total_value == 16_500.0          # 10,000 + 6,500
    assert combined.average_price == 11.0            # 16,500 / 1,500
    assert combined.transaction_date == date(2024, 3, 5)  # latest purchase date


def test_minimum_value_filter():
    signals = combine_purchases_into_signals([
        make_transaction(shares=100.0, price_per_share=10.0),                 # $1,000
        make_transaction(source_filing="filing-2", shares=10_000.0),          # $500,000
    ])
    kept = filter_by_minimum_value(signals, 100_000)
    assert [s.source_filing for s in kept] == ["filing-2"]
