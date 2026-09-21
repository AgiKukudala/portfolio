import urllib.request,urllib.error,json,uuid,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
session=str(uuid.uuid4())
def command(op,session=session,**kwargs):
 body={'op':op,'key':'smoke','value':'','expected':'','session':session,'request':str(uuid.uuid4()),**kwargs}
 request=urllib.request.Request('http://127.0.0.1:8010/api/command',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 return json.load(urllib.request.urlopen(request,timeout=5))
request_id=str(uuid.uuid4())
first=command('put',value='first',request=request_id)
assert first['result']['success']
assert command('put',value='first',request=request_id)['result']==first['result']
assert command('get')['result']['value']=='first'
assert not command('get',session=str(uuid.uuid4()))['result']['found']
assert command('cas',expected='first',value='second')['result']['success']
assert not command('cas',expected='first',value='third')['result']['success']
assert command('delete')['result']['success']
assert not command('get')['result']['found']
try:command('shell')
except urllib.error.HTTPError as e:assert e.code==400
else:raise AssertionError('invalid operation accepted')
report={'backend':'real three-node AsterKV via Go HTTP gateway','passed':['PUT/GET','stable request deduplication','random browser namespace isolation','atomic CAS success and mismatch','DELETE and missing GET','invalid operation rejected']}
(root/'docs'/'aster-api-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
