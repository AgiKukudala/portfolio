"""Tests for parser.py and the transaction value calculation in models.py."""

from datetime import date

import pytest

from insiderpulse.models import FilingReference, calculate_transaction_value
from insiderpulse.parser import (
    FilingParseError,
    determine_insider_role,
    parse_date,
    parse_form4_xml,
    parse_number,
)

# A trimmed-down but realistic Form 4: the CEO buys stock in two rows,
# sells in one row, and exercises options in the derivative table.
SAMPLE_FORM4 = """<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0000012345</issuerCik>
    <issuerName>Example Corp</issuerName>
    <issuerTradingSymbol>EXMP</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chairman and Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-04</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>50.25</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-05-05:00</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-06</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>51</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Stock Option</value></securityTitle>
      <transactionDate><value>2024-03-06</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>300</value></transactionShares>
        <transactionPricePerShare><value>20</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>
"""


def make_filing(cik: int = 12345) -> FilingReference:
    return FilingReference(
        accession_number="0000000000-24-000001",
        cik=cik,
        ticker="EXMP",
        company_name="Example Corp",
        form_type="4",
        filing_date=date(2024, 3, 6),
        document_url="https://www.sec.gov/Archives/example.xml",
    )


# --- transaction value -----------------------------------------------------

def test_transaction_value_is_shares_times_price():
    assert calculate_transaction_value(1000, 50.25) == 50_250.0


def test_transaction_value_is_none_when_price_missing():
    assert calculate_transaction_value(1000, None) is None
    assert calculate_transaction_value(None, 10.0) is None


# --- full filing parsing ---------------------------------------------------

def test_parse_form4_reads_every_row_in_order():
    transactions = parse_form4_xml(SAMPLE_FORM4, make_filing())

    assert len(transactions) == 4
    assert [t.transaction_code for t in transactions] == ["P", "P", "S", "M"]
    assert [t.line_number for t in transactions] == [0, 1, 2, 3]
    assert [t.is_derivative for t in transactions] == [False, False, False, True]


def test_parse_form4_fills_transaction_fields():
    first = parse_form4_xml(SAMPLE_FORM4, make_filing())[0]

    assert first.insider_name == "Doe Jane"
    assert first.insider_role == "CEO"
    assert first.ticker == "EXMP"
    assert first.transaction_date == date(2024, 3, 4)
    assert first.filing_date == date(2024, 3, 6)
    assert first.shares == 1000
    assert first.price_per_share == 50.25
    assert first.transaction_value == 50_250.0
    assert first.transaction_type == "Open-market purchase"
    assert first.source_filing == "0000000000-24-000001"


def test_missing_price_becomes_none_instead_of_crashing():
    second = parse_form4_xml(SAMPLE_FORM4, make_filing())[1]

    assert second.price_per_share is None
    assert second.transaction_value is None
    assert second.transaction_date == date(2024, 3, 5)  # timezone suffix ignored


def test_filing_about_a_different_company_is_skipped():
    # The company we asked about (CIK 99999) is not the issuer in this filing.
    assert parse_form4_xml(SAMPLE_FORM4, make_filing(cik=99999)) == []


def test_malformed_xml_raises_parse_error():
    with pytest.raises(FilingParseError):
        parse_form4_xml("<ownershipDocument><issuer>", make_filing())


def test_wrong_document_type_raises_parse_error():
    with pytest.raises(FilingParseError):
        parse_form4_xml("<html><body>Not found</body></html>", make_filing())


def test_filing_without_reporting_owner_raises_parse_error():
    xml = "<ownershipDocument><issuer><issuerCik>12345</issuerCik></issuer></ownershipDocument>"
    with pytest.raises(FilingParseError):
        parse_form4_xml(xml, make_filing())


# --- small helpers ---------------------------------------------------------

def test_parse_number_handles_commas_blanks_and_garbage():
    assert parse_number("1,500") == 1500.0
    assert parse_number(" 12.5 ") == 12.5
    assert parse_number("") is None
    assert parse_number("n/a") is None
    assert parse_number(None) is None


def test_parse_date_handles_invalid_text():
    assert parse_date("2024-01-31") == date(2024, 1, 31)
    assert parse_date("not a date") is None
    assert parse_date(None) is None


@pytest.mark.parametrize(
    "is_director, is_officer, is_ten_percent, title, expected",
    [
        (False, True, False, "President & CEO", "CEO"),
        (True, True, False, "Chief Executive Officer", "CEO"),
        (False, True, False, "EVP and Chief Financial Officer", "CFO"),
        (False, True, False, "SVP, CFO", "CFO"),
        (False, True, False, "Chief Operating Officer", "Officer"),
        (True, False, False, "", "Director"),
        (False, False, True, "", "10% Owner"),
        (False, False, False, "", "Other"),
        # "ceo" must be a whole word, not part of another word
        (False, True, False, "Procurement Director", "Officer"),
    ],
)
def test_determine_insider_role(is_director, is_officer, is_ten_percent, title, expected):
    assert determine_insider_role(is_director, is_officer, is_ten_percent, title) == expected
