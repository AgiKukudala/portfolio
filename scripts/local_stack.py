"""Start selected local services with independent durable data; Ctrl-C stops children."""
import argparse,os,pathlib,subprocess,signal,sys,time
root=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('mode',choices=['asterkv','insiderpulse','full']);args=p.parse_args()
children=[]
def run(cmd,cwd,env=None):
 children.append(subprocess.Popen(cmd,cwd=cwd,env={**os.environ,**(env or {})}))
try:
 if args.mode in ['asterkv','full']:
  engine=root/'vendor'/'asterkv'
  go=os.environ.get('GO_BIN','go')
  for name in ['node','gateway']:
   subprocess.run([go,'build','-o',str(root/'data'/('asterkv-'+name)),'./cmd/'+name],cwd=engine,check=True)
  for i in range(1,4):
   peers=','.join(f'node{j}=127.0.0.1:{5100+j}' for j in range(1,4) if j!=i)
   run([str(root/'data'/'asterkv-node'),f'--id=node{i}',f'--addr=127.0.0.1:{5100+i}',f'--peers={peers}',f'--data={root}/data/asterkv/node{i}'],root)
  run([str(root/'data'/'asterkv-gateway')],root)
 if args.mode in ['insiderpulse','full']:
  run([sys.executable,'-m','insiderpulse.lab_api'],root/'vendor'/'insiderpulse',{'INSIDERPULSE_LAB_DATA':str(root/'data'/'insiderpulse')})
 print('Local lab services started. Frontend: run npm run dev in another terminal.',flush=True)
 while all(c.poll() is None for c in children):time.sleep(1)
 if any(c.returncode not in (None,0) for c in children):raise SystemExit('A lab process exited. Review its output.')
except KeyboardInterrupt:pass
finally:
 for c in children:
  if c.poll() is None:c.terminate()
 for c in children:
  try:c.wait(timeout=5)
  except subprocess.TimeoutExpired:c.kill()
