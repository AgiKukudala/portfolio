"""
Data models: the plain Python objects that move through the pipeline.

    FilingReference  -> "there is a Form 4 at this URL" (from the SEC index)
    Transaction      -> one row of a Form 4 (a buy, sale, grant, ...)
    Signal           -> one insider's open-market purchase from one filing,
                        with all its purchase rows combined, plus a score
    PricePoint       -> a closing price on a specific trading day
    BacktestResult   -> what happened to the stock after one signal

They are dataclasses: classes that only hold data. Python writes the
__init__ and __repr__ methods for us.
"""

from dataclasses import dataclass, field
from datetime import date


def calculate_transaction_value(
    shares: float | None, price_per_share: float | None
) -> float | None:
    """Return shares x price, or None if either number is missing."""
    if shares is None or price_per_share is None:
        return None
    return shares * price_per_share


@dataclass
class FilingReference:
    """A Form 4 filing listed in the SEC index, before we download it."""

    accession_number: str   # SEC's unique ID for the filing, e.g. 0001140361-26-036226
    cik: int                # SEC's ID number for the company (issuer)
    ticker: str
    company_name: str
    form_type: str
    filing_date: date
    document_url: str       # where the raw XML document lives


@dataclass
class Transaction:
    """One transaction row reported in a Form 4 filing."""

    company_name: str
    ticker: str
    insider_name: str
    insider_role: str           # CEO, CFO, Officer, Director, 10% Owner, Other
    transaction_date: date | None
    filing_date: date           # the day the public could see the filing
    transaction_code: str       # SEC letter code: P = purchase, S = sale, ...
    transaction_type: str       # human-readable version of the code
    acquired_or_disposed: str   # "A" = shares acquired, "D" = shares disposed
    is_derivative: bool         # True for options/warrants, False for actual stock
    security_title: str
    shares: float | None
    price_per_share: float | None
    source_filing: str          # accession number of the filing it came from
    line_number: int            # position of this row inside the filing

    @property
    def transaction_value(self) -> float | None:
        """Dollar value of the transaction: shares x price per share."""
        return calculate_transaction_value(self.shares, self.price_per_share)


@dataclass
class Signal:
    """
    One insider's open-market purchase, as reported in one filing.

    A single purchase is often split across several Form 4 rows (for example
    1,000 shares at $10.01 and 500 shares at $10.03). We combine those rows so
    one buying decision counts once, with its total shares and total value.
    """

    ticker: str
    company_name: str
    insider_name: str
    insider_role: str
    transaction_date: date      # latest purchase date in the filing
    filing_date: date
    shares: float
    average_price: float
    total_value: float
    source_filing: str
    cluster_size: int = 1       # distinct insiders buying in the cluster window
    score: int = 0
    score_breakdown: list[str] = field(default_factory=list)


@dataclass
class PricePoint:
    """A closing price and the trading day it belongs to."""

    trade_date: date
    price: float


@dataclass
class BacktestResult:
    """How the stock and the benchmark moved after one signal."""

    ticker: str
    insider_name: str
    insider_role: str
    transaction_date: date
    filing_date: date
    source_filing: str
    total_value: float
    insider_score: int
    cluster_size: int
    holding_period_days: int
    entry_date: date
    exit_date: date
    starting_price: float
    ending_price: float
    stock_return: float
    benchmark_ticker: str
    benchmark_return: float
    benchmark_adjusted_return: float
