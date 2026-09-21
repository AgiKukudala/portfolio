"""Bounded, single-worker HTTP adapter. Original CLI and analysis are unchanged."""
import dataclasses
import json
import os
import re
import sqlite3
import requests
from contextlib import closing
import threading
import time
from collections import OrderedDict
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from insiderpulse import config, database
from insiderpulse.clusters import assign_cluster_sizes, find_cluster_insiders
from insiderpulse.filters import filter_open_market_purchases, combine_purchases_into_signals
from insiderpulse.scoring import score_signals
from insiderpulse.parser import parse_form4_xml
from insiderpulse.sec_client import SecClient, SecRequestError, SecAccessDeniedError, load_ticker_map, list_form4_filings

DATA = Path(os.environ.get('INSIDERPULSE_LAB_DATA', 'data/lab'))
DB = DATA / 'insiderpulse.db'
LOCK = threading.Lock()
CLIENT = None
JOB = {'state': 'idle', 'completed': 0}
BUDGET = OrderedDict()
BUDGET_LOCK = threading.Lock()
COOLDOWN = 0.0


def now():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(type(value).__name__)


def connect():
    conn = database.connect(DB)
    conn.execute('PRAGMA max_page_count=16384')  # 64 MiB at default page size
    conn.execute('CREATE TABLE IF NOT EXISTS lab_metadata (key TEXT PRIMARY KEY, value TEXT)')
    return conn


def analyze(conn):
    signals = combine_purchases_into_signals(filter_open_market_purchases(database.load_transactions(conn)))
    assign_cluster_sizes(signals)
    score_signals(signals)
    return signals


def snapshot(conn):
    filings = {r['accession_number']: dict(r) for r in conn.execute('SELECT * FROM filings')}
    rows = []
    for t in database.load_transactions(conn):
        f = filings.get(t.source_filing, {})
        rows.append({**dataclasses.asdict(t), 'transaction_value': t.transaction_value,
                     'document_url': f.get('document_url'), 'cik': f.get('cik'),
                     'retrieved_at': f.get('processed_at'), 'form_type': f.get('form_type')})
    signals = analyze(conn)
    enriched = []
    for s in signals:
        peers = [p for p in signals if p.ticker == s.ticker]
        names = find_cluster_insiders(s, peers, config.CLUSTER_WINDOW_DAYS)
        related = [p.source_filing for p in peers if p.filing_date <= s.filing_date
                   and abs((p.transaction_date-s.transaction_date).days) <= config.CLUSTER_WINDOW_DAYS]
        enriched.append({**dataclasses.asdict(s), 'cluster_insiders': sorted(names), 'related_filings': related})
    refreshed = conn.execute("SELECT value FROM lab_metadata WHERE key='last_refresh'").fetchone()
    latest = max((f['processed_at'] for f in filings.values()), default=None)
    return {'mode': 'cached', 'source': 'SEC EDGAR / original InsiderPulse SQLite cache',
            'last_successful_refresh': refreshed[0] if refreshed else None,
            'latest_record_retrieval': latest, 'timestamp_note': 'Legacy processed_at timestamps have no timezone; preserved as recorded.',
            'transactions': rows, 'signals': enriched,
            'backtests': database.load_backtest_results(conn),
            'price_downloads': [dict(r) for r in conn.execute('SELECT * FROM price_downloads ORDER BY downloaded_at DESC LIMIT 30')],
            'limitations': ['Form 4/A amendments skipped', 'Ownership type and footnotes not retained',
                             'Roles normalized; joint owner names joined', 'Clusters identify insiders by exact name, not owner CIK',
                             'Same-day filing order unavailable; cluster timing uses dates only', 'Cluster counts cover available cache only; bounded scans may omit activity'],
            'rules': {'window_days': config.CLUSTER_WINDOW_DAYS, 'minimum_insiders': config.CLUSTER_MIN_INSIDERS,
                      'minimum_value': 0, 'role_points': config.ROLE_POINTS, 'size_points': config.SIZE_POINTS,
                      'cluster_bonus': config.CLUSTER_BONUS_POINTS}}


def validate(params):
    allowed = {'ticker', 'q', 'start', 'end', 'code', 'limit', 'offset'}
    if set(params)-allowed:
        raise ValueError('Unknown filter')
    ticker = params.get('ticker', '').upper()
    if ticker and not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,9}', ticker):
        raise ValueError('Invalid ticker')
    q = params.get('q', '').strip()
    if len(q) > 80: raise ValueError('Search is limited to 80 characters')
    start = date.fromisoformat(params['start']) if params.get('start') else date(2000, 1, 1)
    end = date.fromisoformat(params['end']) if params.get('end') else date.today()
    if start > end or end > date.today(): raise ValueError('Invalid filing-date range')
    code = params.get('code', '')
    if code and not re.fullmatch('[A-Z]', code): raise ValueError('Invalid transaction code')
    limit, offset = int(params.get('limit', 100)), int(params.get('offset', 0))
    if not 1 <= limit <= 200 or not 0 <= offset <= 50000: raise ValueError('Invalid pagination')
    return ticker, q, start, end, code, limit, offset


def filtered(data, params):
    ticker, q, start, end, code, limit, offset = validate(params)
    rows = [r for r in data['transactions'] if (not ticker or r['ticker'] == ticker)
            and (not q or q.lower() in (r['ticker']+' '+r['company_name']).lower())
            and start.isoformat() <= str(r['filing_date']) <= end.isoformat()
            and (not code or r['transaction_code'] == code)]
    rows.sort(key=lambda r: (str(r['filing_date']), r['source_filing']), reverse=True)
    ids = {r['source_filing'] for r in rows[offset:offset+limit]}
    selected = [s for s in data['signals'] if s['source_filing'] in ids]
    related = {fid for s in selected for fid in s['related_filings']}
    result = {**data, 'transactions': rows[offset:offset+limit], 'total': len(rows), 'offset': offset,
              'signals': [s for s in data['signals'] if s['source_filing'] in ids | related],
              'backtests': [r for r in data['backtests'] if (r.source_filing if dataclasses.is_dataclass(r) else r['source_filing']) in ids]}
    result['state'] = 'empty' if not rows else 'cached'
    result['stale'] = True  # Historical cache; no implicit upstream freshness claim.
    return result


class BoundedSession(requests.Session):
    def get(self, url, **kwargs):
        # Do not follow redirects to an unvalidated host; cap decompressed bodies.
        response = super().get(url, **kwargs, stream=True, allow_redirects=False)
        chunks = []
        size = 0
        try:
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 8_000_000:
                    raise SecRequestError('Upstream document exceeds 8 MB limit')
                chunks.append(chunk)
            response._content = b''.join(chunks)
            response._content_consumed = True
            return response
        finally:
            response.close()


class BoundedClient(SecClient):
    """One shared SEC client, used only while holding the global ingestion lock."""
    def __init__(self, ua):
        super().__init__(ua, session=BoundedSession())
        self.requests = 0
        self.deadline = 0
    def get(self, url):
        global COOLDOWN
        p = urlsplit(url)
        if p.scheme != 'https' or p.hostname not in {'www.sec.gov', 'data.sec.gov'} or p.port:
            raise SecRequestError('Unapproved upstream URL')
        if time.monotonic() < COOLDOWN: raise SecRequestError('SEC cooldown is active')
        if self.requests >= 30 or time.monotonic() > self.deadline:
            raise SecRequestError('Bounded ingestion budget reached')
        self.requests += 1
        try:
            return super().get(url)
        except SecAccessDeniedError:
            COOLDOWN = time.monotonic() + 600
            raise
    def retry_delay(self, attempt, response):
        global COOLDOWN
        delay = super().retry_delay(attempt, response)
        if response is not None:
            value = response.headers.get('Retry-After', '')
            if value and not value.isdigit():
                try:
                    retry_at = parsedate_to_datetime(value)
                    delay = max(0, (retry_at-datetime.now(timezone.utc)).total_seconds())
                except (TypeError, ValueError):
                    pass
        if delay > 20 or time.monotonic()+delay > self.deadline:
            COOLDOWN = time.monotonic() + delay
            raise SecRequestError('Upstream asked for a longer pause; retry later')
        return delay


def ingest(params):
    global JOB, CLIENT
    conn = None
    try:
        config.SEC_SECONDS_BETWEEN_REQUESTS = 0.25
        config.SEC_MAX_RETRIES = 2
        config.SEC_REQUEST_TIMEOUT_SECONDS = 10
        if CLIENT is None: CLIENT = BoundedClient(os.environ['INSIDERPULSE_USER_AGENT'])
        CLIENT.requests, CLIENT.deadline = 0, time.monotonic()+120
        ticker, _, start, end, _, _, _ = validate(params)
        mapping = load_ticker_map(CLIENT, DATA/'company_tickers.json')
        if ticker not in mapping: raise ValueError('Ticker not in SEC identifier mapping')
        cik, name = mapping[ticker]
        filings = list_form4_filings(CLIENT, cik, ticker, name, start, end)
        conn = connect()
        if conn.execute('SELECT COUNT(*) FROM transactions').fetchone()[0] >= 50000:
            raise ValueError('Cache capacity reached; operator maintenance required')
        JOB.update(total=min(20, len(filings)), truncated=len(filings)>20)
        for filing in filings[:20]:
            if not database.filing_already_processed(conn, filing.accession_number, ticker):
                xml = CLIENT.get_text(filing.document_url)
                if len(xml) > 2_000_000: raise ValueError('Filing exceeds size limit')
                transactions = parse_form4_xml(xml, filing)
                if len(transactions)>1000: raise ValueError('Filing has too many rows')
                database.save_transactions(conn, transactions)
                database.save_filing(conn, filing, 'parsed')
                conn.execute('UPDATE filings SET processed_at=? WHERE accession_number=? AND ticker=?',
                             (now(), filing.accession_number, ticker))
                conn.commit()
            JOB['completed'] += 1
        timestamp = now()
        conn.execute("INSERT OR REPLACE INTO lab_metadata VALUES ('last_refresh', ?)", (timestamp,))
        conn.commit()
        JOB.update(state='partial' if JOB['truncated'] else 'complete', finished_at=timestamp)
    except Exception as e:
        JOB.update(state='partial' if JOB['completed'] else 'error', error=str(e), finished_at=now())
    finally:
        if conn: conn.close()
        LOCK.release()


def permitted(ip, clock=time.monotonic):
    with BUDGET_LOCK:
        current = clock()
        for key in list(BUDGET):
            if current-BUDGET[key][0] > 60: del BUDGET[key]
        if ip not in BUDGET:
            if len(BUDGET) >= 2048: return False
            BUDGET[ip] = [current, 0]
        BUDGET[ip][1] += 1
        return BUDGET[ip][1] <= 60


class Handler(BaseHTTPRequestHandler):
    def send(self, status, value):
        body = json.dumps(value, default=encode, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if status == 429: self.send_header('Retry-After', '60')
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if not permitted(self.client_address[0]): return self.send(429, {'state':'rate-limited'})
        path = urlsplit(self.path)
        try:
            if len(self.path)>2048: raise ValueError('Query too long')
            query = parse_qs(path.query, keep_blank_values=True)
            if any(len(v)!=1 for v in query.values()): raise ValueError('Repeated filter')
            params = {k:v[0] for k,v in query.items()}
            if path.path == '/health': return self.send(200, {'state':'ready','service':'InsiderPulse API'})
            if path.path == '/api/status': return self.send(200, {'job':JOB, 'ingestion_enabled': enabled(), 'backtest_execution':False})
            if path.path == '/api/filings':
                validate(params)
                with closing(connect()) as conn: result = filtered(snapshot(conn), params)
                return self.send(200, result)
            return self.send(404, {'state':'unavailable'})
        except ValueError as e: return self.send(400, {'state':'error','error':str(e)})
        except Exception: return self.send(503, {'state':'unavailable','error':'Cache unavailable or incompatible'})
    def do_POST(self):
        global JOB
        if not permitted(self.client_address[0]): return self.send(429, {'state':'rate-limited'})
        if self.path != '/api/ingest': return self.send(404, {'state':'unavailable'})
        if not enabled(): return self.send(503, {'state':'unavailable','error':'Operator must configure SEC contact and enable ingestion'})
        # Operator token is never sent to or stored by the portfolio frontend.
        import hmac
        if not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+os.environ['INSIDERPULSE_OPERATOR_TOKEN']):
            return self.send(403, {'state':'unavailable','error':'Operator authorization required'})
        try:
            n = int(self.headers.get('Content-Length','0'))
            if not 0 < n <= 1024: raise ValueError('Invalid body size')
            params = json.loads(self.rfile.read(n))
            if not isinstance(params, dict) or set(params) != {'ticker','start','end'}: raise ValueError('ticker, start and end required')
            ticker, _, start, end, _, _, _ = validate(params)
            if not ticker or (end-start).days > 31: raise ValueError('One ticker and at most 31 days required')
        except (ValueError, TypeError, AttributeError) as e: return self.send(400, {'state':'error','error':str(e)})
        if not LOCK.acquire(blocking=False): return self.send(409, {'state':'busy','job':JOB})
        JOB = {'state':'running','completed':0,'started_at':now(),'ticker':ticker}
        threading.Thread(target=ingest,args=(params,),daemon=True).start()
        return self.send(202, {'job':JOB})


def enabled():
    ua = os.environ.get('INSIDERPULSE_USER_AGENT','')
    return (os.environ.get('INSIDERPULSE_ENABLE_INGEST') == '1' and '@' in ua
            and 'example.com' not in ua and bool(os.environ.get('INSIDERPULSE_OPERATOR_TOKEN')))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(16)
    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.close()
            return
        super().process_request(request,address)
    def process_request_thread(self, request, address):
        request.settimeout(15)
        try: super().process_request_thread(request,address)
        finally: self.slots.release()


if __name__ == '__main__':
    DATA.mkdir(parents=True, exist_ok=True)
    with closing(connect()): pass
    Server((os.environ.get('LAB_HOST','127.0.0.1'), int(os.environ.get('LAB_PORT','8011'))), Handler).serve_forever()
