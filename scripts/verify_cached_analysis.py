"""Recompute with original code and authentic cached prices, never fabricated history."""
import sys,pathlib,sqlite3,dataclasses,json
from datetime import date
root=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'vendor'/'insiderpulse'))
from insiderpulse import database
from insiderpulse.lab_api import analyze,encode
from insiderpulse.prices import PriceLoader
from insiderpulse.backtester import run_backtest
conn=database.connect(root/'data'/'insiderpulse'/'insiderpulse.db')
signals=analyze(conn);stored=database.load_signals(conn)
assert [dataclasses.asdict(s) for s in signals]==[dataclasses.asdict(s) for s in stored]
# A private in-memory copy allows cache writes without changing the saved research DB.
copy=sqlite3.connect(':memory:');conn.backup(copy);copy.row_factory=sqlite3.Row
loader=PriceLoader(copy,download_function=lambda ticker,start,end:{d:p for d,p in database.load_prices(conn,ticker).items() if start<=d<=end})
results,missing=run_backtest(signals,loader)
expected=database.load_backtest_results(conn)
bykey=lambda r:(r.source_filing,r.holding_period_days)
a={bykey(r):dataclasses.asdict(r) for r in results};b={bykey(r):dataclasses.asdict(r) for r in expected}
assert a==b,(len(a),len(b))
report={'signals_match_original':len(signals),'historical_backtest_results_recomputed':len(results),'signals_without_results':missing,'data':'Authentic previously downloaded SEC / Yahoo Finance cache','network_requests':0,'scope':'47 signals; 7, 30, 90 calendar-day periods; benchmark SPY','not_tested':'Fresh Yahoo price download or fresh SEC ingestion'}
(root/'docs'/'cached-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
