"""StageAPI native closures: registration, ownership, nesting, errors and reload."""
import pathlib,subprocess,sys,time,json
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tools'))
from capture import read_capture
binary=root/'build/stream-dev/Release'
host=subprocess.Popen([str(binary/'isaacprof-test-host.exe'),str(root/'tests/stageapi-scenario.lua')],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
report=None
def run(*args):
 r=subprocess.run([str(binary/'isaacprof-injector.exe'),*args,'--pid',str(host.pid)],capture_output=True,text=True,timeout=25)
 assert r.returncode==0,r.stdout+r.stderr
 return r.stdout
try:
 assert 'READY' in host.stdout.readline()
 run('attach')
 for _ in range(100):
  if '| ready |' in run('status'):break
  time.sleep(.02)
 else:raise AssertionError('Host did not become ready')
 run('record','--trace','--seconds','2')
 time.sleep(2.4)
 assert host.poll() is None,'StageAPI behavior failed'
 output=run('status');assert '| ready |' in output,output
 report=pathlib.Path(next(line[8:] for line in output.splitlines() if line.startswith('Report: ')))
 doc=read_capture(report);rows=doc['metrics']
 stage=[m for m in rows if m['callback_id'].startswith('StageAPI:') and m['calls']]
 assert stage and all(m['callback_name']==m['callback_id'] for m in stage)
 assert any(m['mod']=='Stage test owner' and m['calls']>10 and m['source'].endswith('tests/scenario.lua') for m in stage)
 assert any(m['mod']=='Stage dynamic owner' and m['calls']>0 for m in stage)
 assert any(m['mod']=='Stage error owner' and m['errors']>0 for m in stage)
 assert any(m['mod']=='Stage multi owner' for m in stage)
 assert any(m['mod']=='Stage in-place owner' for m in stage)
 scopes=[m for m in rows if m['callback_id'].startswith('Function:') and m['calls']]
 assert any(m['mod']=='Function scope owner' and m['callback_id']=='Function:Library.work' for m in scopes)
 assert any(m['callback_id']=='Function:Library.fail' and m['errors']>0 for m in scopes)
 parent=next(m for m in rows if m['mod']=='Stage dispatch')
 assert parent['inclusive_ns']>parent['exclusive_ns']
 ids={m['id'] for m in stage}
 assert any(e[0] in ids and e[4]>=1 for e in doc['timeline']['events'])
 scope_ids={m['id'] for m in scopes}
 assert any(e[0] in scope_ids and e[4]>=1 for e in doc['timeline']['events'])
 catalog=json.loads(run('catalog'));assert 'StageAPI:POST_HUD_RENDER' in catalog['hooks'] and 'Stage test owner' in catalog['mods']
 assert 'Function:Library.work' in catalog['hooks']
 print('PASS: StageAPI and opt-in function scopes use native closures; registration/reload, owner, source, nesting, errors, nil/multiple returns and callback removal preserved')
finally:
 if host.poll() is None:host.terminate()
 _,errors=host.communicate(timeout=10);assert not errors,errors
 if report:
  output=root/'build/stageapi-qa';output.mkdir(exist_ok=True);report.replace(output/report.name)
