"""Test an extracted portable release against an owned Lua host, never Isaac."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from capture import read_capture
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=pathlib.Path)
args = parser.parse_args()
output = root / 'build/release-smoke' / str(time.time_ns())
with zipfile.ZipFile(args.archive) as archive:
    forbidden = ('isaacprof-test-host.exe', 'Lua5.3.3r.dll', '.isaacprof', '.pdb')
    assert not any(name.endswith(forbidden) for name in archive.namelist())
    archive.extractall(output)
package = output / 'IsaacDoctor'
binary = root / 'build/stream-dev/Release'
assert b'LUA_REPENTOGON\0' not in (binary / 'Lua5.3.3r.dll').read_bytes()
host = subprocess.Popen([str(binary / 'isaacprof-test-host.exe'), str(root / 'tests/scenario.lua')],
                        cwd=binary, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
server = None
port = 8772
base = f'http://127.0.0.1:{port}'
legacy_stopped = threading.Event()


class LegacyController(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, value):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply({'token': 'legacy-test'} if self.path == '/api/session' else
                   {'app': 'isaacprof', 'root': str(package), 'parent_pid': None})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert body == {'token': 'legacy-test', 'command': 'shutdown', 'stopRecording': True}
        legacy_stopped.set()
        self.reply({'ok': True, 'state': 'server-stopped'})
        threading.Thread(target=self.server.shutdown, daemon=True).start()


legacy = ThreadingHTTPServer(('127.0.0.1', port), LegacyController)
def serve_legacy():
    try:
        legacy.serve_forever()
    finally:
        legacy.server_close()
threading.Thread(target=serve_legacy, daemon=True).start()

def request(route, body=None):
    headers = {'Content-Type': 'application/json', 'Origin': base}
    req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body else None, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

try:
    assert 'READY' in host.stdout.readline()
    # Only the bundled runtime is available through PATH.
    env = {**os.environ, 'PATH': str(package / '_internal')}
    server = subprocess.Popen([str(package / 'IsaacDoctor.exe'), '--no-browser', '--port', str(port), '--pid', str(host.pid)],
                              cwd=output, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(200):
        try:
            health = request('/api/health')
            if health.get('parent_pid') == server.pid:
                break
            time.sleep(.05)
        except OSError:
            assert server.poll() is None, 'Portable controller exited during startup'
            time.sleep(.05)
    else:
        raise AssertionError('Portable controller did not bind its port')
    assert pathlib.Path(health['root']).resolve() == package.resolve()
    assert legacy_stopped.is_set(), 'An unowned older background server must be stopped before the visible launcher takes ownership'
    assert health['parent_pid']==server.pid, 'Visible launcher must own the background controller'
    def check_assets():
        req=urllib.request.Request(base,headers={'If-Modified-Since':'Fri, 01 Jan 2099 00:00:00 GMT'})
        with urllib.request.urlopen(req,timeout=5) as response:
            assert response.status==200 and response.headers['Cache-Control']=='no-store'
            html=response.read().decode()
            assert 'Isaac Doctor' in html
        for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"',html):
            with urllib.request.urlopen(base+asset,timeout=5) as response:
                assert response.status==200 and response.headers['Cache-Control']=='no-store'
    check_assets()
    token = request('/api/session')['token']
    from recording_settings import DEFAULTS
    saved_preferences = {'version': 1, 'recording': {**DEFAULTS, 'seconds': 6, 'channels': 8192}}
    initial = request('/api/settings')
    assert initial['settings'] is None
    assert pathlib.Path(initial['path']) == package / 'isaac-doctor.settings.json'
    assert request('/api/settings', {'token': token, 'settings': saved_preferences})['settings'] == saved_preferences
    assert json.loads((package / 'isaac-doctor.settings.json').read_text()) == saved_preferences
    def command(name, **values):
        result = request('/api/control', {'token': token, 'command': name, **values})
        assert result['ok'], result
        return result
    command('attach')
    for _ in range(200):
        if request('/api/status')['state'] == 'ready':
            break
        time.sleep(.05)
    else:
        raise AssertionError('Controlled host not ready')
    command('record', seconds=None, startOn='immediate', stopOn='manual', stopDelayMs=None, maxDurationMs=250, screenshots=False)
    for _ in range(100):
        status=request('/api/status')
        if status['state']=='ready':break
        time.sleep(.02)
    else:raise AssertionError('Native maximum did not stop collection')
    limited=read_capture(status['report'])
    assert limited['configuration']['maxDurationMs']==250 and limited['configuration']['stopDelayMs']==0
    assert 230e6 <= limited['duration_ns'] <= 500e6
    command('record', seconds=30, startOn='immediate', stopOn='duration', screenshots=False)
    time.sleep(.4)
    report = request('/api/status')['report']
    assert pathlib.Path(report).is_relative_to(package / 'bin/captures')
    result = command('shutdown', stopRecording=True)
    assert result['state'] == 'server-stopped' and 'IsaacDoctor.exe' in result['message'] and '.ps1' not in result['message']
    assert server.wait(timeout=20) == 0
    assert host.poll() is None, 'Shutdown must leave the host alive'
    doc = read_capture(report)
    assert doc['complete'] and .1e9 < doc['duration_ns'] < 5e9
    # Restart at the same origin after UI shutdown, then simulate closing the EXE window.
    server=subprocess.Popen([str(package/'IsaacDoctor.exe'),'--no-browser','--port',str(port),'--pid',str(host.pid)],cwd=output,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    for _ in range(200):
        try:
            if request('/api/health')['parent_pid']==server.pid:break
        except OSError:pass
        assert server.poll() is None
        time.sleep(.05)
    else:raise AssertionError('Release did not restart')
    check_assets()
    token=request('/api/session')['token']
    assert request('/api/settings')['settings'] == saved_preferences, 'Portable restart lost capture settings'
    # Reopening the executable reuses this owner, without an extra background server.
    reopened=subprocess.run([str(package/'IsaacDoctor.exe'),'--no-browser','--port',str(port)],cwd=output,env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=10)
    assert reopened.returncode==0 and 'already running' in reopened.stdout
    assert request('/api/health')['parent_pid']==server.pid
    command('record',seconds=30,startOn='immediate',stopOn='duration',screenshots=False)
    time.sleep(.4)
    report=request('/api/status')['report']
    server.terminate();server.wait(timeout=10)
    for _ in range(200):
        try:request('/api/health')
        except OSError:break
        time.sleep(.05)
    else:raise AssertionError('Controller survived closing its visible owner')
    assert host.poll() is None
    doc=read_capture(report)
    assert doc['complete'] and .1e9 < doc['duration_ns'] < 5e9
    print('PASS: portable startup without external runtimes, UI shutdown, cache-safe restart, repeated launch reuse and owner termination finalize recording and exit the controller')

finally:
    legacy.shutdown()
    legacy.server_close()
    for process in [server, host]:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
