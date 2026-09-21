"""Tests for database.py, mainly duplicate handling. Uses an in-memory database."""

from datetime import date

import pytest

from insiderpulse import database
from insiderpulse.models import FilingReference, Signal, Transaction


@pytest.fixture
def connection():
    connection = database.connect(":memory:")
    yield connection
    connection.close()


def make_filing() -> FilingReference:
    return FilingReference(
        accession_number="0000000000-24-000001", cik=1, ticker="EXMP", company_name="Example Corp",
        form_type="4", filing_date=date(2024, 3, 6), document_url="https://example/doc.xml",
    )


def make_transaction(line_number: int) -> Transaction:
    return Transaction(
        company_name="Example Corp", ticker="EXMP", insider_name="Doe Jane", insider_role="CEO",
        transaction_date=date(2024, 3, 4), filing_date=date(2024, 3, 6), transaction_code="P",
        transaction_type="Open-market purchase", acquired_or_disposed="A", is_derivative=False,
        security_title="Common Stock", shares=100.0, price_per_share=10.0,
        source_filing="0000000000-24-000001", line_number=line_number,
    )


def test_duplicate_transactions_are_not_inserted_twice(connection):
    rows = [make_transaction(0), make_transaction(1)]

    assert database.save_transactions(connection, rows) == 2
    assert database.save_transactions(connection, rows) == 0   # second time: all duplicates
    assert len(database.load_transactions(connection)) == 2


def test_transaction_round_trip_keeps_values(connection):
    database.save_transactions(connection, [make_transaction(0)])
    loaded = database.load_transactions(connection)[0]

    assert loaded == make_transaction(0)
    assert loaded.transaction_value == 1000.0


def test_filing_is_remembered_once(connection):
    filing = make_filing()
    assert not database.filing_already_processed(connection, filing.accession_number, "EXMP")

    database.save_filing(connection, filing, "parsed")
    database.save_filing(connection, filing, "parsed")   # duplicate is ignored

    assert database.filing_already_processed(connection, filing.accession_number, "EXMP")
    count = connection.execute("SELECT COUNT(*) FROM filings").fetchone()[0]
    assert count == 1


def test_replace_signals_rebuilds_the_table(connection):
    signal = Signal(
        ticker="EXMP", company_name="Example Corp", insider_name="Doe Jane", insider_role="CEO",
        transaction_date=date(2024, 3, 4), filing_date=date(2024, 3, 6), shares=100.0,
        average_price=10.0, total_value=1000.0, source_filing="f1", cluster_size=2, score=6,
        score_breakdown=["CEO purchase: +3", "2 insiders buying within 14 days: +3"],
    )
    database.replace_signals(connection, [signal])
    database.replace_signals(connection, [signal])   # running `score` twice

    loaded = database.load_signals(connection)
    assert loaded == [signal]
    assert database.load_signals(connection, minimum_score=7) == []


def test_price_cache_tracks_downloaded_ranges(connection):
    database.save_prices(connection, "EXMP", {date(2024, 1, 2): 10.0, date(2024, 1, 3): 11.0})
    database.record_price_download(connection, "EXMP", date(2024, 1, 1), date(2024, 1, 31))

    assert database.load_prices(connection, "EXMP") == {date(2024, 1, 2): 10.0, date(2024, 1, 3): 11.0}
    assert database.price_range_is_cached(connection, "EXMP", date(2024, 1, 5), date(2024, 1, 20))
    assert not database.price_range_is_cached(connection, "EXMP", date(2024, 1, 5), date(2024, 2, 5))
    assert not database.price_range_is_cached(connection, "OTHER", date(2024, 1, 5), date(2024, 1, 6))
