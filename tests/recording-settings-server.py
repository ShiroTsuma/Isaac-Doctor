"""Owned controller only: JSON settings survive restart and enforce token/origin checks."""
import copy
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from recording_settings import DEFAULTS
with socket.socket() as socket_probe:
    socket_probe.bind(('127.0.0.1', 0))
    port = socket_probe.getsockname()[1]
origin = f'http://127.0.0.1:{port}'

def request(route, body=None):
    req = urllib.request.Request(origin + route, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Origin': origin, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

with tempfile.TemporaryDirectory() as directory:
    settings = pathlib.Path(directory) / 'settings.json'
    saved = {'version': 1, 'recording': copy.deepcopy(DEFAULTS)}
    saved['recording'].update(channels=8192, seconds=6, selectedMods=['Unicode 日本語'])
    for iteration in range(2):
        server = subprocess.Popen([sys.executable, str(root / 'tools/viewer-server.py'), '--port', str(port), '--settings-file', str(settings)],
                                  cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                try:
                    session = request('/api/session')
                    break
                except OSError:
                    time.sleep(.05)
            else:
                raise AssertionError('Owned test server did not start')
            if iteration == 0:
                assert request('/api/settings')['settings'] is None
                assert request('/api/settings', {'token': session['token'], 'settings': saved})['settings'] == saved
                for token, value, code in [('invalid', saved, 403), (session['token'], {'version': 2}, 400)]:
                    try:
                        request('/api/settings', {'token': token, 'settings': value})
                        raise AssertionError('Invalid request accepted')
                    except urllib.error.HTTPError as error:
                        assert error.code == code
            assert request('/api/settings')['settings'] == saved
            request('/api/control', {'token': session['token'], 'command': 'shutdown'})
            assert server.wait(timeout=10) == 0
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)
            errors = server.stderr.read()
            assert not errors, errors
print('PASS: authenticated settings API, exact JSON/Unicode persisted across controller restart, invalid request leaves file unchanged; no game commands')
