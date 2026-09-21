"""
Tests for sec_client.py. No real network calls are made: a FakeSession
hands back pre-programmed responses, and sleeping is replaced by a list
that records how long the client *would* have waited.
"""

from datetime import date

import pytest
import requests

from insiderpulse.sec_client import (
    SecClient,
    SecNotFoundError,
    SecRequestError,
    build_document_url,
    extract_form4_filings,
    list_form4_filings,
)


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text="", headers=None):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self.headers = headers or {}

    def json(self):
        if self._json_data is None:
            raise ValueError("not JSON")
        return self._json_data


class FakeSession:
    """Returns (or raises) the queued outcomes in order and records each URL requested."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.requested_urls = []
        self.sent_headers = []

    def get(self, url, headers=None, timeout=None):
        self.requested_urls.append(url)
        self.sent_headers.append(headers)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def make_client(outcomes):
    sleeps = []
    session = FakeSession(outcomes)
    client = SecClient(user_agent="Test tester@example.com", session=session, sleep=sleeps.append)
    return client, session, sleeps


# --- HTTP behavior ---------------------------------------------------------

def test_successful_request_sends_user_agent():
    client, session, _ = make_client([FakeResponse(text="hello")])

    assert client.get_text("https://sec.example/doc") == "hello"
    assert session.sent_headers[0]["User-Agent"] == "Test tester@example.com"


def test_temporary_server_error_is_retried_with_backoff():
    client, session, sleeps = make_client([FakeResponse(503), FakeResponse(503), FakeResponse(text="ok")])

    assert client.get_text("https://sec.example/doc") == "ok"
    assert len(session.requested_urls) == 3
    assert 2.0 in sleeps and 4.0 in sleeps       # delay doubles


def test_rate_limit_response_obeys_retry_after_header():
    client, _, sleeps = make_client([FakeResponse(429, headers={"Retry-After": "7"}), FakeResponse(text="ok")])

    client.get_text("https://sec.example/doc")
    assert 7.0 in sleeps


def test_timeout_is_retried():
    client, session, _ = make_client([requests.Timeout("slow"), FakeResponse(text="ok")])

    assert client.get_text("https://sec.example/doc") == "ok"
    assert len(session.requested_urls) == 2


def test_not_found_is_not_retried():
    client, session, _ = make_client([FakeResponse(404)])

    with pytest.raises(SecNotFoundError):
        client.get("https://sec.example/missing")
    assert len(session.requested_urls) == 1


def test_forbidden_is_not_retried():
    client, session, _ = make_client([FakeResponse(403)])

    with pytest.raises(SecRequestError):
        client.get("https://sec.example/doc")
    assert len(session.requested_urls) == 1


def test_client_gives_up_after_max_retries():
    client, session, _ = make_client([FakeResponse(500)] * 10)

    with pytest.raises(SecRequestError, match="gave up"):
        client.get("https://sec.example/doc")
    assert len(session.requested_urls) == 5       # 1 attempt + 4 retries


def test_malformed_json_raises_clear_error():
    client, _, _ = make_client([FakeResponse(text="<html>oops</html>")])

    with pytest.raises(SecRequestError, match="malformed JSON"):
        client.get_json("https://sec.example/data.json")


# --- filing lists ----------------------------------------------------------

def test_build_document_url_points_at_raw_xml():
    url = build_document_url(320193, "0001140361-26-036226", "xslF345X06/form4.xml")
    assert url == "https://www.sec.gov/Archives/edgar/data/320193/000114036126036226/form4.xml"


SUBMISSION_COLUMNS = {
    "form": ["4", "8-K", "4/A", "4", "4"],
    "filingDate": ["2024-05-01", "2024-05-02", "2024-05-03", "2023-06-01", "2024-07-01"],
    "accessionNumber": ["0000000001-24-000001", "x", "y", "0000000001-23-000009", "0000000001-24-000002"],
    "primaryDocument": ["xslF345X05/a.xml", "b.htm", "xslF345X05/c.xml", "xslF345X05/d.xml", "e.xml"],
}


def test_extract_form4_filings_keeps_only_form4_in_date_range():
    filings = extract_form4_filings(
        SUBMISSION_COLUMNS, 1, "EXMP", "Example Corp", date(2024, 1, 1), date(2024, 12, 31)
    )
    # 8-K skipped, 4/A amendment skipped, 2023 filing outside range
    assert [f.accession_number for f in filings] == ["0000000001-24-000001", "0000000001-24-000002"]
    assert filings[0].filing_date == date(2024, 5, 1)


def test_extract_form4_filings_rejects_missing_columns():
    with pytest.raises(SecRequestError):
        extract_form4_filings({"form": ["4"]}, 1, "EXMP", "Example", date(2024, 1, 1), date(2024, 12, 31))


def test_list_form4_filings_only_downloads_overlapping_older_files():
    main_file = {
        "filings": {
            "recent": SUBMISSION_COLUMNS,
            "files": [
                {"name": "old-2020.json", "filingFrom": "2019-01-01", "filingTo": "2020-12-31"},
                {"name": "old-2024.json", "filingFrom": "2023-01-01", "filingTo": "2024-02-01"},
            ],
        }
    }
    older = {
        "form": ["4"],
        "filingDate": ["2024-01-15"],
        "accessionNumber": ["0000000001-24-000000"],
        "primaryDocument": ["f.xml"],
    }
    client, session, _ = make_client([FakeResponse(json_data=main_file), FakeResponse(json_data=older)])

    filings = list_form4_filings(client, 1, "EXMP", "Example Corp", date(2024, 1, 1), date(2024, 12, 31))

    assert len(session.requested_urls) == 2
    assert session.requested_urls[1].endswith("old-2024.json")
    assert [f.filing_date for f in filings] == [date(2024, 1, 15), date(2024, 5, 1), date(2024, 7, 1)]
