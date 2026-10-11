"""Real injection, deferred trigger, GL/PBO screenshots, binary readers and control API."""
import io
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tools'))
from capture import read_capture
binary=root/'build/Release'
if b'LUA_REPENTOGON\x00' in (binary/'Lua5.3.3r.dll').read_bytes():
    raise SystemExit('Refusing production REPENTOGON Lua in test host')
host=subprocess.Popen([str(binary/'isaacprof-test-host.exe'),str(root/'tests/recording-scenario.lua'),'--graphics'],cwd=binary,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
trigger=binary/f'isaacprof-test-run-{host.pid}.trigger'
server=None
def run(*args):
    result=subprocess.run([str(binary/'isaacprof-injector.exe'),*args,'--pid',str(host.pid)],capture_output=True,text=True,timeout=25)
    assert result.returncode==0,result.stdout+result.stderr
    return result.stdout
def wait_state(state):
    for _ in range(100):
        output=run('status')
        if f'| {state} |' in output:return output
        assert host.poll() is None,'host failed: '+host.stderr.read()
        time.sleep(.05)
    raise AssertionError('State timeout: '+output)
def request(route,body=None,origin='http://127.0.0.1:8766'):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request('http://127.0.0.1:8766'+route,data=data,headers={'Origin':origin,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
try:
    assert 'READY' in host.stdout.readline()
    run('attach');wait_state('ready')
    run('record','--after-load','--seconds','2','--trace','--screenshots','--screenshot-ms','250');time.sleep(.35)
    assert '| armed |' in run('status')
    assert not list((binary/'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))
    run('stop');assert '| ready |' in run('status')
    run('record','--after-load','--seconds','2','--trace','--screenshots','--screenshot-ms','250')
    trigger.write_bytes(b'run loaded');wait_state('recording');output=wait_state('ready')
    report=next(line[8:] for line in output.splitlines() if line.startswith('Report: '))
    document=read_capture(report);assert document['binary_version']==2 and document['complete']
    assert 1.9e9<=document['duration_ns']<=2.5e9
    shots=document['screenshots'];assert len(shots['images'])>=4,shots
    assert all(0<=shot['time_ns']<=document['duration_ns'] and shot['width']==320 and shot['height']==180 for shot in shots['images'])
    try:
        from PIL import Image
        image=Image.open(io.BytesIO(shots['images'][0]['png'])).convert('RGB')
        assert image.getpixel((100,20))==(0,0,255) and image.getpixel((100,160))==(255,0,0),'PNG orientation/color changed'
    except ImportError:
        pass
    assert sum(m['calls'] for m in document['metrics'])>5
    analysis=subprocess.run([str(binary/'isaacprof-analyze.exe'),report],capture_output=True,text=True)
    assert analysis.returncode==0,analysis.stderr
    server=subprocess.Popen([sys.executable,str(root/'tools/viewer-server.py'),'--port','8766','--pid',str(host.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: session=request('/api/session');break
        except OSError:time.sleep(.05)
    else:raise AssertionError('Control server did not start')
    for body,origin in [({'token':session['token'],'command':'record'},'https://untrusted.example'),({'token':'wrong','command':'record'},'http://127.0.0.1:8766')]:
        try:request('/api/control',body,origin);raise AssertionError('Unauthorized request accepted')
        except urllib.error.HTTPError as error:assert error.code==403
    started=request('/api/control',{'token':session['token'],'command':'record','seconds':2,'afterLoad':True,'screenshots':True,'screenshotMs':250})
    assert started['ok'] and started['state'] in ('armed','recording'),started
    time.sleep(.3)
    stopped=request('/api/control',{'token':session['token'],'command':'stop'});assert stopped['ok'] and stopped['state']=='ready'
    assert read_capture(stopped['report'])['complete']
    print(f'PASS: deferred run trigger, cancel without file, duration excludes menu, {len(shots["images"])} real GPU PNGs, orientation, binary v2 analyzer, local browser recording/stop API, origin/token checks. Capture: {report}')
finally:
    if server:server.terminate();server.wait(timeout=10)
    if host.poll() is None:host.terminate()
    _,errors=host.communicate(timeout=10)
    if errors:print(errors,file=sys.stderr)
    trigger.unlink(missing_ok=True)
