"""Copy audited local engines into a standalone build context; no network/publishing."""
import pathlib, subprocess, shutil, json
root=pathlib.Path(__file__).resolve().parents[1]
base=pathlib.Path.home()
provenance={}
for name,extra in [('insiderpulse','insiderpulse/lab_api.py'),('asterkv','cmd/gateway/main.go')]:
 src=base/name
 files=subprocess.check_output(['git','ls-files'],cwd=src,text=True).splitlines()+[extra]
 for file in files:
  if file.startswith(('docs/','.github/')): continue
  target=root/'vendor'/name/file
  target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(src/file,target)
 provenance[name]={'repository':subprocess.check_output(['git','remote','get-url','origin'],cwd=src,text=True).strip(),'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=src,text=True).strip(),'addition':extra}
(root/'docs'/'sources.json').write_text(json.dumps(provenance,indent=2)+'\n')
