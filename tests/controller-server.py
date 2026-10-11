"""Own test server; no game commands are executed."""
import json
import pathlib
import subprocess
import sys
import time
import urllib.request
import urllib.error
root=pathlib.Path(__file__).resolve().parents[1]
port=8767
server=subprocess.Popen([sys.executable,str(root/'tools/viewer-server.py'),'--port',str(port)],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
def request(body=None,origin=None):
    data=json.dumps(body).encode() if body else None
    r=urllib.request.Request(f'http://127.0.0.1:{port}/api/control' if body else f'http://127.0.0.1:{port}/api/session',data=data,headers={'Content-Type':'application/json','Origin':origin or f'http://127.0.0.1:{port}'})
    with urllib.request.urlopen(r,timeout=10) as response:return json.load(response)
try:
    for _ in range(100):
        try:session=request();break
        except OSError:time.sleep(.05)
    else:raise AssertionError('Test server did not start')
    page=urllib.request.Request(f'http://127.0.0.1:{port}/',headers={'If-Modified-Since':'Fri, 01 Jan 2099 00:00:00 GMT'})
    with urllib.request.urlopen(page,timeout=5) as response:
        assert response.status==200 and response.headers['Cache-Control']=='no-store'
        assert b'<html' in response.read()
    for body,origin,code in [({'token':'bad','command':'shutdown'},None,403),({'token':session['token'],'command':'shutdown'},'https://untrusted.example',403),({'token':session['token'],'command':'record','minimumUs':1.5},None,400),({'token':session['token'],'command':'record','minimumUs':-1},None,400), *[({'token':session['token'],'command':'record',key:value},None,400) for key,value in [('startOn','manual'),('stopOn','immediate'),('startDelayMs',-1),('stopDelayMs',1.5),('stopDelayMs',True),('channels',True),('channels',2048),('selectedMods','A'),('selectedHooks',['bad\nname']),('selectedMods',['x'*4095]),('selectedHooks',['A']*129)]]]:
        try:request(body,origin);raise AssertionError('Invalid control request accepted')
        except urllib.error.HTTPError as e:assert e.code==code
    result=request({'token':session['token'],'command':'shutdown'},'http://127.0.0.1:5173');assert result['ok'] and result['state']=='server-stopped'
    assert server.wait(timeout=10)==0
    print('PASS: exact origin/token checks, invalid minimum rejected before injection, Vite origin accepted, authenticated shutdown exits Python')
finally:
    if server.poll() is None:server.terminate();server.wait(timeout=10)
    errors=server.stderr.read();assert not errors,errors
