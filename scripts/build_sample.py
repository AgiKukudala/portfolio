"""Preview only: reuse the original synthetic parser test, with no SEC link."""
import sys,pathlib,json,dataclasses
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'vendor'/'insiderpulse'))
sys.path.insert(0,str(root/'vendor'/'insiderpulse'/'tests'))
from test_parser import SAMPLE_FORM4,make_filing
from insiderpulse.parser import parse_form4_xml
from insiderpulse.filters import filter_open_market_purchases,combine_purchases_into_signals
from insiderpulse.clusters import assign_cluster_sizes
from insiderpulse.scoring import score_signals
from insiderpulse.lab_api import encode
rows=parse_form4_xml(SAMPLE_FORM4,make_filing())
signals=combine_purchases_into_signals(filter_open_market_purchases(rows));assign_cluster_sizes(signals);score_signals(signals)
data={'mode':'sample','source':'Synthetic Example Corp fixture from original tests/test_parser.py','transactions':[{**dataclasses.asdict(t),'transaction_value':t.transaction_value,'document_url':None,'cik':None,'retrieved_at':None} for t in rows],'signals':[{**dataclasses.asdict(s),'related_filings':[s.source_filing]} for s in signals],'backtests':[]}
(root/'public'/'insider-sample.json').write_text(json.dumps(data,default=encode))
