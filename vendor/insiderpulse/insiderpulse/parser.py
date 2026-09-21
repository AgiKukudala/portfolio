"""
Parser: turns the raw Form 4 XML text from the SEC into Transaction objects.

A Form 4 is the form an insider files within two business days of trading
their company's stock. Since 2003 it is filed as XML with this shape:

    <ownershipDocument>
      <issuer>            ... the company ...
      <reportingOwner>    ... the insider and their role ...
      <nonDerivativeTable>  rows about actual shares (buys, sales, grants)
      <derivativeTable>     rows about options, warrants, etc.
    </ownershipDocument>

All XML-specific code stays in this file. The rest of the program only
sees clean Transaction objects.
"""

import re
import xml.etree.ElementTree as ElementTree
from datetime import date

from insiderpulse.models import FilingReference, Transaction

# What each SEC transaction code means (from the official Form 4 instructions).
TRANSACTION_CODE_LABELS = {
    "P": "Open-market purchase",
    "S": "Open-market sale",
    "A": "Grant or award",
    "M": "Option exercise",
    "X": "Option exercise",
    "C": "Conversion of derivative",
    "F": "Tax withholding",
    "G": "Gift",
    "D": "Disposition to issuer",
    "J": "Other acquisition or disposition",
    "I": "Discretionary transaction",
    "W": "Will or inheritance",
    "K": "Equity swap",
    "V": "Voluntarily reported",
    "E": "Expiration of short derivative",
    "H": "Expiration of long derivative",
    "L": "Small acquisition",
    "O": "Out-of-the-money exercise",
    "U": "Tender of shares in change of control",
    "Z": "Voting trust deposit or withdrawal",
}


class FilingParseError(Exception):
    """Raised when a filing's XML is broken or missing required parts."""


def describe_transaction_code(code: str) -> str:
    """Turn an SEC letter code such as 'P' into a readable label."""
    return TRANSACTION_CODE_LABELS.get(code, "Unknown")


def parse_number(text: str | None) -> float | None:
    """Convert text like '1,500' or '12.34' to a float. Returns None if empty or invalid."""
    if text is None:
        return None
    cleaned = text.strip().replace(",", "").replace("$", "")
    if cleaned == "":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_date(text: str | None) -> date | None:
    """Convert '2024-03-05' (sometimes '2024-03-05-05:00') to a date. None if invalid."""
    if text is None:
        return None
    try:
        return date.fromisoformat(text.strip()[:10])
    except ValueError:
        return None


def parse_flag(text: str | None) -> bool:
    """Form 4 yes/no flags are written as 'true', '1', 'false', '0' or left out."""
    if text is None:
        return False
    return text.strip().lower() in ("true", "1")


def get_text(element: ElementTree.Element, path: str) -> str | None:
    """
    Read the text at `path` inside `element`.

    Most Form 4 fields wrap their text in a <value> child, e.g.
    <transactionShares><value>100</value></transactionShares>,
    so we look there first, then at the element itself.
    """
    for candidate in (path + "/value", path):
        found = element.find(candidate)
        if found is not None and found.text is not None and found.text.strip() != "":
            return found.text.strip()
    return None


def determine_insider_role(
    is_director: bool, is_officer: bool, is_ten_percent_owner: bool, officer_title: str
) -> str:
    """
    Pick the single most senior role for an insider.

    Priority: CEO > CFO > other Officer > Director > 10% Owner > Other.
    CEO/CFO are recognized from the free-text officer title.
    """
    title = officer_title.lower()
    if "chief executive" in title or re.search(r"\bceo\b", title):
        return "CEO"
    if "chief financial" in title or re.search(r"\bcfo\b", title):
        return "CFO"
    if is_officer:
        return "Officer"
    if is_director:
        return "Director"
    if is_ten_percent_owner:
        return "10% Owner"
    return "Other"


def read_reporting_owners(root: ElementTree.Element) -> tuple[str, str]:
    """
    Return (insider_name, insider_role) for the filing.

    Occasionally several owners file one joint Form 4 (for example a fund
    and its manager). We join their names and keep the most senior role.
    """
    owners = root.findall("reportingOwner")
    if not owners:
        raise FilingParseError("filing has no <reportingOwner>")

    names = []
    is_director = is_officer = is_ten_percent_owner = False
    titles = []
    for owner in owners:
        name = get_text(owner, "reportingOwnerId/rptOwnerName")
        if name:
            names.append(name)
        relationship = owner.find("reportingOwnerRelationship")
        if relationship is None:
            continue
        is_director = is_director or parse_flag(get_text(relationship, "isDirector"))
        is_officer = is_officer or parse_flag(get_text(relationship, "isOfficer"))
        is_ten_percent_owner = is_ten_percent_owner or parse_flag(
            get_text(relationship, "isTenPercentOwner")
        )
        titles.append(get_text(relationship, "officerTitle") or "")

    if not names:
        raise FilingParseError("reporting owner has no name")

    role = determine_insider_role(is_director, is_officer, is_ten_percent_owner, " ".join(titles))
    return " / ".join(names), role


def parse_transaction_row(
    row: ElementTree.Element,
    is_derivative: bool,
    line_number: int,
    filing: FilingReference,
    insider_name: str,
    insider_role: str,
) -> Transaction:
    """Convert one <nonDerivativeTransaction> or <derivativeTransaction> into a Transaction."""
    code = get_text(row, "transactionCoding/transactionCode") or ""
    return Transaction(
        company_name=filing.company_name,
        ticker=filing.ticker,
        insider_name=insider_name,
        insider_role=insider_role,
        transaction_date=parse_date(get_text(row, "transactionDate")),
        filing_date=filing.filing_date,
        transaction_code=code,
        transaction_type=describe_transaction_code(code),
        acquired_or_disposed=get_text(row, "transactionAmounts/transactionAcquiredDisposedCode") or "",
        is_derivative=is_derivative,
        security_title=get_text(row, "securityTitle") or "",
        shares=parse_number(get_text(row, "transactionAmounts/transactionShares")),
        price_per_share=parse_number(get_text(row, "transactionAmounts/transactionPricePerShare")),
        source_filing=filing.accession_number,
        line_number=line_number,
    )


def parse_form4_xml(xml_text: str, filing: FilingReference) -> list[Transaction]:
    """
    Parse one Form 4 XML document into a list of Transaction objects.

    Inputs:  the raw XML text, and the FilingReference describing where it came from.
    Output:  one Transaction per transaction row (stock rows first, then derivative rows).
             An empty list if the filing is about a different company (see below)
             or reports holdings only.
    Raises:  FilingParseError if the XML is malformed or missing required sections.
    """
    try:
        root = ElementTree.fromstring(xml_text.strip())
    except ElementTree.ParseError as error:
        raise FilingParseError(f"invalid XML: {error}") from error

    if root.tag != "ownershipDocument":
        raise FilingParseError(f"unexpected root element <{root.tag}>")

    # A company's SEC filing list also contains Form 4s where the company itself
    # is the *buyer* of another company's stock. Those are not insider trades in
    # this company, so we skip them.
    issuer_cik = parse_number(get_text(root, "issuer/issuerCik"))
    if issuer_cik is None:
        raise FilingParseError("filing has no issuer CIK")
    if int(issuer_cik) != filing.cik:
        return []

    insider_name, insider_role = read_reporting_owners(root)

    transactions = []
    line_number = 0
    table_paths = [
        ("nonDerivativeTable/nonDerivativeTransaction", False),
        ("derivativeTable/derivativeTransaction", True),
    ]
    for path, is_derivative in table_paths:
        for row in root.findall(path):
            transactions.append(
                parse_transaction_row(row, is_derivative, line_number, filing, insider_name, insider_role)
            )
            line_number += 1
    return transactions
