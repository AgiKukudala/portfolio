"""
SEC client: downloads public data from the SEC's EDGAR system.

Three kinds of SEC data are used, none of which need an API key:

1. company_tickers.json  - maps tickers (AAPL) to CIK numbers (320193)
   https://www.sec.gov/files/company_tickers.json
2. Submissions JSON      - every filing a company is involved in
   https://data.sec.gov/submissions/CIK0000320193.json
3. Form 4 XML documents  - the actual insider transaction reports
   https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/<file>.xml

SEC rules we follow (https://www.sec.gov/os/accessing-edgar-data):
  * identify ourselves with a User-Agent header containing contact details
  * stay under 10 requests per second
  * back off and retry politely when the server is busy
"""

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

from insiderpulse import config
from insiderpulse.models import FilingReference

TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/{file_name}"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"

# Status codes that usually mean "try again later" rather than "you did something wrong".
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


class SecRequestError(Exception):
    """A request to the SEC failed permanently (after any retries)."""


class SecNotFoundError(SecRequestError):
    """The SEC returned 404: the document does not exist."""


class SecAccessDeniedError(SecRequestError):
    """The SEC returned 403: missing User-Agent or rate limit exceeded. Stop and wait."""


class SecClient:
    """
    Sends polite HTTP GET requests to the SEC.

    It remembers when the last request was sent so it can wait between
    requests (rate limiting), and it retries temporary failures with a
    growing delay (exponential backoff).

    `session` and `sleep` can be replaced in tests so no real network
    calls or real waiting happen.
    """

    def __init__(self, user_agent: str = config.SEC_USER_AGENT, session=None, sleep=time.sleep):
        self.session = session or requests.Session()
        self.headers = {"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"}
        self.sleep = sleep
        self.last_request_time = 0.0

    def wait_for_rate_limit(self) -> None:
        """Pause just long enough to keep a minimum gap between requests."""
        seconds_since_last = time.monotonic() - self.last_request_time
        if seconds_since_last < config.SEC_SECONDS_BETWEEN_REQUESTS:
            self.sleep(config.SEC_SECONDS_BETWEEN_REQUESTS - seconds_since_last)
        self.last_request_time = time.monotonic()

    def retry_delay(self, attempt: int, response: requests.Response | None) -> float:
        """
        How long to wait before retry number `attempt` (1, 2, 3, ...).

        If the server told us how long to wait (Retry-After header) we obey it;
        otherwise the delay doubles each time: 2s, 4s, 8s, ...
        """
        if response is not None:
            retry_after = response.headers.get("Retry-After", "")
            if retry_after.isdigit():
                return float(retry_after)
        return config.SEC_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))

    def get(self, url: str) -> requests.Response:
        """
        Download `url` and return the successful response.

        Retries on timeouts, connection errors and temporary HTTP errors.
        Raises SecNotFoundError for 404 and SecRequestError for anything
        that still fails after config.SEC_MAX_RETRIES retries.
        """
        last_problem = ""
        for attempt in range(1, config.SEC_MAX_RETRIES + 2):
            self.wait_for_rate_limit()
            response = None
            try:
                response = self.session.get(
                    url, headers=self.headers, timeout=config.SEC_REQUEST_TIMEOUT_SECONDS
                )
            except (requests.Timeout, requests.ConnectionError) as error:
                last_problem = f"network error: {error}"
            else:
                if response.status_code == 200:
                    return response
                if response.status_code == 404:
                    raise SecNotFoundError(f"not found: {url}")
                if response.status_code == 403:
                    # The SEC answers 403 when the User-Agent is missing or when a
                    # client has exceeded the rate limit. Retrying makes it worse.
                    raise SecAccessDeniedError(
                        "SEC refused the request (HTTP 403). Set INSIDERPULSE_USER_AGENT "
                        "to 'Your Name your@email.com' and wait 10 minutes before retrying."
                    )
                if response.status_code not in RETRYABLE_STATUS_CODES:
                    raise SecRequestError(f"HTTP {response.status_code} for {url}")
                last_problem = f"HTTP {response.status_code}"

            if attempt <= config.SEC_MAX_RETRIES:
                delay = self.retry_delay(attempt, response)
                print(f"  SEC request problem ({last_problem}); retrying in {delay:.0f}s...")
                self.sleep(delay)

        raise SecRequestError(f"gave up on {url} after {config.SEC_MAX_RETRIES} retries: {last_problem}")

    def get_json(self, url: str) -> dict:
        """Download `url` and decode it as JSON. Raises SecRequestError if it is not valid JSON."""
        response = self.get(url)
        try:
            return response.json()
        except ValueError as error:
            raise SecRequestError(f"malformed JSON from {url}") from error

    def get_text(self, url: str) -> str:
        """Download `url` and return the body as text."""
        return self.get(url).text


# ---------------------------------------------------------------------------
# Ticker -> CIK lookup
# ---------------------------------------------------------------------------

def load_ticker_map(client: SecClient, cache_path: Path = config.TICKER_MAP_CACHE_PATH) -> dict:
    """
    Return {"AAPL": (320193, "Apple Inc."), ...} for every SEC-listed ticker.

    Uses the local copy if it is less than TICKER_MAP_MAX_AGE_HOURS old,
    otherwise downloads a fresh one and saves it.
    """
    cache_is_fresh = cache_path.exists() and (
        datetime.now() - datetime.fromtimestamp(cache_path.stat().st_mtime)
        < timedelta(hours=config.TICKER_MAP_MAX_AGE_HOURS)
    )
    if cache_is_fresh:
        raw = json.loads(cache_path.read_text())
    else:
        raw = client.get_json(TICKER_MAP_URL)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(raw))

    # The file looks like {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
    ticker_map = {}
    for entry in raw.values():
        ticker_map[entry["ticker"].upper()] = (int(entry["cik_str"]), entry["title"])
    return ticker_map


# ---------------------------------------------------------------------------
# Listing a company's Form 4 filings
# ---------------------------------------------------------------------------

def build_document_url(cik: int, accession_number: str, primary_document: str) -> str:
    """
    Build the URL of a filing's raw XML document.

    The SEC index points at a styled HTML version such as "xslF345X05/form4.xml".
    Dropping the "xslF345X05/" folder gives the raw XML we can parse.
    """
    raw_document = primary_document.split("/")[-1]
    return ARCHIVE_URL.format(
        cik=cik, accession=accession_number.replace("-", ""), document=raw_document
    )


def extract_form4_filings(
    filing_columns: dict, cik: int, ticker: str, company_name: str, start: date, end: date
) -> list[FilingReference]:
    """
    Pick the Form 4 filings inside [start, end] from one block of submissions data.

    The SEC stores filings "column by column": filing_columns["form"][i],
    filing_columns["filingDate"][i], ... all describe filing number i.
    Amendments ("4/A") are skipped because they repeat an earlier filing.
    """
    try:
        forms = filing_columns["form"]
        filing_dates = filing_columns["filingDate"]
        accession_numbers = filing_columns["accessionNumber"]
        primary_documents = filing_columns["primaryDocument"]
    except KeyError as error:
        raise SecRequestError(f"submissions data is missing the {error} column") from error

    filings = []
    for index, form in enumerate(forms):
        if form != "4":
            continue
        filing_date = date.fromisoformat(filing_dates[index])
        if filing_date < start or filing_date > end:
            continue
        if not primary_documents[index].lower().endswith(".xml"):
            continue  # very old filings were plain text; we only parse XML
        filings.append(
            FilingReference(
                accession_number=accession_numbers[index],
                cik=cik,
                ticker=ticker,
                company_name=company_name,
                form_type=form,
                filing_date=filing_date,
                document_url=build_document_url(cik, accession_numbers[index], primary_documents[index]),
            )
        )
    return filings


def list_form4_filings(
    client: SecClient, cik: int, ticker: str, company_name: str, start: date, end: date
) -> list[FilingReference]:
    """
    Return every Form 4 filed about this company between `start` and `end`.

    The main submissions file holds the most recent ~1,000 filings. Older
    filings live in extra files listed under filings.files; we only download
    the extra files whose date range overlaps the range we want.
    """
    main_file = client.get_json(SUBMISSIONS_URL.format(file_name=f"CIK{cik:010d}.json"))
    try:
        recent = main_file["filings"]["recent"]
        older_files = main_file["filings"].get("files", [])
    except (KeyError, TypeError) as error:
        raise SecRequestError(f"unexpected submissions format for CIK {cik}") from error

    filings = extract_form4_filings(recent, cik, ticker, company_name, start, end)

    for older_file in older_files:
        file_start = date.fromisoformat(older_file["filingFrom"])
        file_end = date.fromisoformat(older_file["filingTo"])
        if file_end < start or file_start > end:
            continue
        older = client.get_json(SUBMISSIONS_URL.format(file_name=older_file["name"]))
        filings.extend(extract_form4_filings(older, cik, ticker, company_name, start, end))

    filings.sort(key=lambda filing: filing.filing_date)
    return filings
