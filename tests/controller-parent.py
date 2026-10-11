"""Parent death stops a real controlled capture and exits Python; never starts Isaac."""
import json
import pathlib
import subprocess
import sys
import time
import urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tools'))
from capture import read_capture
binary=root/'build/stream-dev/Release'
host=subprocess.Popen([str(binary/'isaacprof-test-host.exe'),str(root/'tests/scenario.lua')],cwd=binary,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
parent=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
server=None
def run(*args):
    r=subprocess.run([str(binary/'isaacprof-injector.exe'),*args,'--pid',str(host.pid)],capture_output=True,text=True,timeout=25)
    assert r.returncode==0,r.stdout+r.stderr;return r.stdout
try:
    assert 'READY' in host.stdout.readline();run('attach')
    for _ in range(100):
        if '| ready |' in run('status'):break
        time.sleep(.05)
    server=subprocess.Popen([sys.executable,str(root/'tools/viewer-server.py'),'--port','8768','--parent-pid',str(parent.pid),'--pid',str(host.pid)],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
    for _ in range(100):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8768/api/health',timeout=1) as r:health=json.load(r)
            assert health['parent_pid']==parent.pid;break
        except OSError:time.sleep(.05)
    output=run('record','--seconds','30','--trace');report=next(line[8:] for line in output.splitlines() if line.startswith('Report: '));time.sleep(.4)
    parent.terminate();parent.wait(timeout=10)
    assert server.wait(timeout=20)==0
    assert '| ready |' in run('status');doc=read_capture(report);assert doc['complete'] and .1e9<doc['duration_ns']<5e9
    print('PASS: forced parent termination stops controlled recording, finalizes binary capture, exits Python and leaves host alive')
finally:
    for p in [parent,server,host]:
        if p and p.poll() is None:p.terminate();p.wait(timeout=10)
