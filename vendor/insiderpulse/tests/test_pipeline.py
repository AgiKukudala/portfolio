"""
End-to-end test of collect -> score -> backtest -> report with a fake SEC
client and a fake price source. No internet access is used.
"""

from datetime import date, timedelta

from insiderpulse import database, pipeline
from insiderpulse.prices import PriceLoader

CIK = 12345


def form4_xml(insider: str, title: str, code: str, trade_date: str, shares: int, price: float) -> str:
    """Build a minimal Form 4 with one stock transaction."""
    disposed = "D" if code == "S" else "A"
    return f"""<ownershipDocument>
  <issuer><issuerCik>{CIK:010d}</issuerCik><issuerName>Example Corp</issuerName></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>{insider}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>{title}</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable><nonDerivativeTransaction>
    <securityTitle><value>Common Stock</value></securityTitle>
    <transactionDate><value>{trade_date}</value></transactionDate>
    <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>{shares}</value></transactionShares>
      <transactionPricePerShare><value>{price}</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>{disposed}</value></transactionAcquiredDisposedCode>
    </transactionAmounts>
  </nonDerivativeTransaction></nonDerivativeTable>
</ownershipDocument>"""


# Three filings: CEO buys, CFO buys (cluster), an officer sells.
FILINGS = [
    ("0000000001-24-000001", "2024-01-05", "ceo.xml", form4_xml("Ann CEO", "Chief Executive Officer", "P", "2024-01-03", 10_000, 50.0)),
    ("0000000001-24-000002", "2024-01-09", "cfo.xml", form4_xml("Bob CFO", "Chief Financial Officer", "P", "2024-01-08", 2_000, 51.0)),
    ("0000000001-24-000003", "2024-01-10", "coo.xml", form4_xml("Cy COO", "Chief Operating Officer", "S", "2024-01-09", 500, 52.0)),
]


class FakeSecClient:
    """Answers the same get_json/get_text calls as SecClient, from local data."""

    def __init__(self):
        self.requested = []
        self.documents = {}
        for accession, _, document, xml in FILINGS:
            url = f"https://www.sec.gov/Archives/edgar/data/{CIK}/{accession.replace('-', '')}/{document}"
            self.documents[url] = xml

    def get_json(self, url):
        self.requested.append(url)
        if url.endswith("company_tickers.json"):
            return {"0": {"cik_str": CIK, "ticker": "EXMP", "title": "Example Corp"}}
        return {"filings": {"recent": {
            "form": ["4", "4", "4"],
            "filingDate": [filed for _, filed, _, _ in FILINGS],
            "accessionNumber": [accession for accession, _, _, _ in FILINGS],
            "primaryDocument": [f"xslF345X05/{document}" for _, _, document, _ in FILINGS],
        }, "files": []}}

    def get_text(self, url):
        self.requested.append(url)
        return self.documents[url]


def fake_prices(ticker, start, end):
    """Stock rises 0.1% per day, SPY 0.05% per day, weekdays only."""
    daily_growth = {"EXMP": 1.001, "SPY": 1.0005}[ticker]
    prices = {}
    day = date(2023, 12, 1)
    price = 100.0
    while day <= date(2024, 12, 31):
        if day.weekday() < 5:
            price *= daily_growth
            if start <= day <= end:
                prices[day] = price
        day += timedelta(days=1)
    return prices


def test_full_pipeline(tmp_path):
    connection = database.connect(":memory:")
    client = FakeSecClient()

    inserted = pipeline.collect(connection, client, ["EXMP"], date(2024, 1, 1), date(2024, 12, 31),
                                ticker_map_path=tmp_path / "tickers.json")
    assert inserted == 3

    # Running collect again downloads no filing documents and stores nothing new.
    documents_before = sum(1 for url in client.requested if url.endswith(".xml"))
    assert pipeline.collect(connection, client, ["EXMP"], date(2024, 1, 1), date(2024, 12, 31),
                            ticker_map_path=tmp_path / "tickers.json") == 0
    assert sum(1 for url in client.requested if url.endswith(".xml")) == documents_before

    signals = pipeline.score(connection, minimum_value=0)
    assert [s.insider_role for s in signals] == ["CEO", "CFO"]      # the sale is filtered out
    assert signals[0].score == 3 + 2                                 # CEO + $500,000
    assert signals[1].cluster_size == 2
    assert signals[1].score == 2 + 1 + 3                             # CFO + $102,000 + cluster

    loader = PriceLoader(connection, download_function=fake_prices, today=date(2024, 12, 31))
    pipeline.backtest(connection, loader, [7, 30, 90], minimum_score=0)
    results = database.load_backtest_results(connection)
    assert len(results) == 6
    assert all(r.stock_return > r.benchmark_return for r in results)

    text = pipeline.report(connection, None, None, None, minimum_score=0, focus_period=30)
    assert "Transactions analyzed:                3" in text
    assert "Qualifying purchases (signals):       2" in text
    assert "90-DAY RESULTS (2 signals)" in text
    assert "Win rate vs SPY:" in text and "100.0%" in text
