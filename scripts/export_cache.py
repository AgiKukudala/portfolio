import pathlib,sys,json,hashlib,sqlite3,datetime
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'vendor'/'insiderpulse'))
from insiderpulse.lab_api import snapshot,encode
source=pathlib.Path(sys.argv[1])
conn=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
# Work on a separate backup; never change the original research database.
target=root/'data'/'insiderpulse';target.mkdir(parents=True,exist_ok=True)
copy=sqlite3.connect(target/'insiderpulse.db');conn.backup(copy);copy.row_factory=sqlite3.Row
copy.execute('CREATE TABLE IF NOT EXISTS lab_metadata (key TEXT PRIMARY KEY,value TEXT)')
data=snapshot(copy)
data['provenance']={'source_file':'insiderpulse/data/insiderpulse.db','sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'exported_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'retrieval_timezone':'not recorded by original CLI','synthetic':False}
(root/'public'/'insider-cache.json').write_text(json.dumps(data,default=encode,allow_nan=False))
print('Exported',len(data['transactions']),'real cached rows')
