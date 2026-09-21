import sys,pathlib,dataclasses,json,threading,urllib.request,urllib.error
from datetime import date
import pytest
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'vendor'/'insiderpulse'))
sys.path.insert(0,str(root/'vendor'/'insiderpulse'/'tests'))
from insiderpulse import lab_api as api,database
from insiderpulse.parser import parse_form4_xml
from test_parser import SAMPLE_FORM4,make_filing
from insiderpulse.sec_client import SecRequestError

@pytest.fixture
def connection():
 c=database.connect(':memory:');c.execute('CREATE TABLE lab_metadata (key TEXT PRIMARY KEY,value TEXT)')
 f=make_filing();database.save_transactions(c,parse_form4_xml(SAMPLE_FORM4,f));database.save_filing(c,f,'parsed')
 yield c
 c.close()

def test_snapshot_matches_original_fields_and_missing(connection):
 d=api.snapshot(connection)
 assert len(d['transactions'])==4
 assert d['transactions'][0]['transaction_value']==50250
 assert d['transactions'][1]['price_per_share'] is None
 assert d['transactions'][1]['transaction_value'] is None
 assert str(d['transactions'][0]['transaction_date'])=='2024-03-04'
 assert str(d['transactions'][0]['filing_date'])=='2024-03-06'
 assert d['signals'][0]['score']==3
 assert d['signals'][0]['cluster_size']==1
 assert d['signals'][0]['related_filings']==[make_filing().accession_number]
 assert d['mode']=='cached' and d['last_successful_refresh'] is None

def test_filters_and_limits(connection):
 d=api.filtered(api.snapshot(connection),{'q':'Example','start':'2024-03-06','end':'2024-03-06','code':'P','limit':'1'})
 assert d['total']==2 and len(d['transactions'])==1
 assert d['transactions'][0]['document_url']==make_filing().document_url
 assert d['latest_record_retrieval']
 assert api.filtered(api.snapshot(connection),{'q':'nothing'})['state']=='empty'

@pytest.mark.parametrize('params',[{'ticker':'https://evil'},{'start':'bad'},{'end':'2000-01-01','start':'2001-01-01'},{'code':'PP'},{'limit':'201'},{'offset':'-1'},{'url':'https://evil'},{'q':'x'*81}])
def test_invalid(params):
 with pytest.raises(ValueError):api.validate(params)

def test_rate_limit():
 api.BUDGET.clear()
 assert all(api.permitted('visitor',lambda:1) for _ in range(60))
 assert not api.permitted('visitor',lambda:1)
 assert api.permitted('visitor',lambda:62)

def test_untrusted_url_and_request_budget():
 client=api.BoundedClient('Test contact@invalid.test')
 with pytest.raises(SecRequestError):client.get('https://evil.invalid/foo')
 client.requests=30
 with pytest.raises(SecRequestError):client.get('https://www.sec.gov/files/company_tickers.json')

def test_upstream_failure_has_observed_progress_only(tmp_path,monkeypatch):
 monkeypatch.setattr(api,'DATA',tmp_path);monkeypatch.setattr(api,'DB',tmp_path/'test.db')
 class Failed:
  def get_json(self,url):raise SecRequestError('upstream unavailable')
 monkeypatch.setattr(api,'CLIENT',Failed());monkeypatch.setattr(api,'JOB',{'state':'running','completed':0})
 api.LOCK.acquire();api.ingest({'ticker':'UNH','start':'2025-05-01','end':'2025-05-02'})
 assert api.JOB['state']=='error' and api.JOB['completed']==0
 assert 'upstream unavailable' in api.JOB['error']
 assert not api.LOCK.locked()

def test_http_invalid_disabled_missing(tmp_path,monkeypatch):
 monkeypatch.setattr(api,'DB',tmp_path/'test.db');monkeypatch.delenv('INSIDERPULSE_ENABLE_INGEST',raising=False)
 api.BUDGET.clear();server=api.Server(('127.0.0.1',0),api.Handler)
 worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
 url=f'http://127.0.0.1:{server.server_port}'
 try:
  assert json.load(urllib.request.urlopen(url+'/api/filings'))['state']=='empty'
  for path,status in [('/api/filings?limit=300',400),('/api/filings?code=P&code=S',400),('/nope',404)]:
   with pytest.raises(urllib.error.HTTPError) as e:urllib.request.urlopen(url+path)
   assert e.value.code==status
  with pytest.raises(urllib.error.HTTPError) as e:urllib.request.urlopen(urllib.request.Request(url+'/api/ingest',data=b'{}'))
  assert e.value.code==503
 finally:server.shutdown();server.server_close()

def test_retry_after_dates_and_long_pause(monkeypatch):
 from datetime import datetime,timezone,timedelta
 from email.utils import format_datetime
 import time
 class Response:
  headers={'Retry-After':format_datetime(datetime.now(timezone.utc)+timedelta(seconds=90))}
 monkeypatch.setattr(api,'COOLDOWN',0)
 client=api.BoundedClient('Test contact@invalid.test');client.deadline=time.monotonic()+120
 with pytest.raises(SecRequestError):client.retry_delay(1,Response())
 assert api.COOLDOWN>time.monotonic()+60


def test_actual_http_rate_limit(tmp_path,monkeypatch):
 monkeypatch.setattr(api,'DB',tmp_path/'test.db');api.BUDGET.clear()
 server=api.Server(('127.0.0.1',0),api.Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
 url=f'http://127.0.0.1:{server.server_port}/health'
 try:
  for _ in range(60):
   with urllib.request.urlopen(url) as response:assert response.status==200
  with pytest.raises(urllib.error.HTTPError) as error:urllib.request.urlopen(url)
  assert error.value.code==429
  assert error.value.headers['Retry-After']=='60'
 finally:server.shutdown();server.server_close();api.BUDGET.clear()
