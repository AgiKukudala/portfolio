"""
Purchase filter: decides which transactions are real open-market purchases,
and combines the purchase rows of each filing into one Signal.

Why this matters: most Form 4 rows are NOT an insider choosing to spend their
own money. Grants, option exercises and tax withholding happen automatically
as part of pay. Only code "P" (open-market or private purchase) means the
insider paid market price for the shares.
"""

from insiderpulse.models import Signal, Transaction

# Readable categories used by classify_transaction() and the report.
OPEN_MARKET_PURCHASE = "Open-market purchase"
SALE = "Sale"
OPTION_EXERCISE = "Option exercise"
GRANT_OR_AWARD = "Grant or award"
TAX_WITHHOLDING = "Tax withholding"
GIFT = "Gift"
OTHER = "Other"


def is_open_market_purchase(transaction: Transaction) -> bool:
    """
    Return True only for a genuine open-market purchase of stock.

    Every rule below must pass:
      1. SEC code is "P" (purchase). Grants are "A", exercises "M", sales "S".
      2. It is a stock row, not an option/derivative row.
      3. Shares were acquired ("A"), not disposed.
      4. Shares and price are present and positive, so a dollar value exists.
      5. The transaction date is known.
    """
    if transaction.transaction_code != "P":
        return False
    if transaction.is_derivative:
        return False
    if transaction.acquired_or_disposed != "A":
        return False
    if transaction.shares is None or transaction.shares <= 0:
        return False
    if transaction.price_per_share is None or transaction.price_per_share <= 0:
        return False
    if transaction.transaction_date is None:
        return False
    return True


def classify_transaction(transaction: Transaction) -> str:
    """Put a transaction into one readable category (used for reporting counts)."""
    if is_open_market_purchase(transaction):
        return OPEN_MARKET_PURCHASE
    code = transaction.transaction_code
    if code == "S":
        return SALE
    if code in ("M", "X", "O"):
        return OPTION_EXERCISE
    if code == "A":
        return GRANT_OR_AWARD
    if code == "F":
        return TAX_WITHHOLDING
    if code == "G":
        return GIFT
    return OTHER


def filter_open_market_purchases(transactions: list[Transaction]) -> list[Transaction]:
    """Keep only the transactions that pass is_open_market_purchase()."""
    return [transaction for transaction in transactions if is_open_market_purchase(transaction)]


def combine_purchases_into_signals(purchases: list[Transaction]) -> list[Signal]:
    """
    Group purchase rows by the filing they came from and build one Signal per filing.

    Input:  open-market purchase Transactions (already filtered).
    Output: Signals sorted by filing date, with total shares, total dollar value
            and the average price paid. Scores are filled in later by scoring.py.
    """
    rows_by_filing: dict[str, list[Transaction]] = {}
    for purchase in purchases:
        rows_by_filing.setdefault(purchase.source_filing, []).append(purchase)

    signals = []
    for filing_id, rows in rows_by_filing.items():
        total_shares = sum(row.shares for row in rows)
        total_value = sum(row.transaction_value for row in rows)
        first_row = rows[0]
        signals.append(
            Signal(
                ticker=first_row.ticker,
                company_name=first_row.company_name,
                insider_name=first_row.insider_name,
                insider_role=first_row.insider_role,
                transaction_date=max(row.transaction_date for row in rows),
                filing_date=first_row.filing_date,
                shares=total_shares,
                average_price=total_value / total_shares,
                total_value=total_value,
                source_filing=filing_id,
            )
        )

    signals.sort(key=lambda signal: (signal.filing_date, signal.ticker, signal.source_filing))
    return signals


def filter_by_minimum_value(signals: list[Signal], minimum_value: float) -> list[Signal]:
    """Drop purchases smaller than `minimum_value` dollars."""
    return [signal for signal in signals if signal.total_value >= minimum_value]
