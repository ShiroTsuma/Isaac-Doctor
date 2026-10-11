"""Serve built viewer assets only; recordings are read locally by the browser."""
import argparse
import sys
import webbrowser
import urllib.request
import json
import pathlib
import secrets
import subprocess
import threading
import ctypes
import re
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

packaged = getattr(sys, 'frozen', False)
root = pathlib.Path(sys.executable).resolve().parent if packaged else pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=8765)
parser.add_argument('--no-browser', action='store_true', help='Do not automatically open a browser in the portable release')
parser.add_argument('--pid', type=int, help='Controlled test host only; default searches the already running Isaac process')
parser.add_argument('--parent-pid', type=int, help='Managed Vite owner; stop recording and close server when this process ends')
args = parser.parse_args()
assets = root / 'viewer/dist'
token = secrets.token_urlsafe(32)
controller_lock = threading.Lock()
injector = root / ('bin' if packaged else 'build/Release') / 'isaacprof-injector.exe'

def stop_recording():
    status = control('status')
    if status['state'] in ('recording', 'armed'):
        stopped = control('stop')
        if not stopped['ok']:
            raise RuntimeError(stopped['message'])

def control(command, options=None):
    arguments = [str(injector), command]
    if args.pid is not None:
        arguments += ['--pid', str(args.pid)]
    if command == 'record':
        values = options or {}
        seconds, interval = values.get('seconds', 15), values.get('screenshotMs', 500)
        minimum = values.get('minimumUs', 0)
        if type(minimum) is not int or not 0 <= minimum <= 1000000:
            raise ValueError('Minimum duration must be 0..1000000 microseconds')
        if type(seconds) is not int or not 1 <= seconds <= 3600 or type(interval) is not int or not 250 <= interval <= 10000:
            raise ValueError('Duration must be 1..3600 s; screenshot interval 250..10000 ms')
        arguments += ['--seconds', str(seconds), '--trace', '--screenshot-ms', str(interval), '--min-us', str(minimum)]
        for key, flag in [('afterLoad', '--after-load'), ('screenshots', '--screenshots')]:
            value = values.get(key, False)
            if type(value) is not bool:
                raise ValueError(f'{key} must be a boolean')
            if value and (key != 'afterLoad' or 'startOn' not in values):
                arguments.append(flag)
        mask = values.get('channels', 2047)
        if type(mask) is not int or mask < 0 or mask & ~2047:
            raise ValueError('Invalid capture channel mask')
        arguments += ['--channels', str(mask)]
        for key, flag in [('selectedMods', '--mod'), ('selectedHooks', '--hook')]:
            names = values.get(key, [])
            if not isinstance(names, list) or len(names) > 128 or any(not isinstance(name, str) or not name or any(c in name for c in '\r\n\0') for name in names):
                raise ValueError(f'Invalid {key} scope')
            if sum(len(name.encode('utf8')) + 1 for name in names) >= 4096:
                raise ValueError(f'{key} exceeds 4095 UTF-8 bytes')
            for name in names:
                arguments += [flag, name]
        triggers = {'immediate', 'run-load', 'room-entry', 'level-entry', 'projectile', 'tear', 'effect', 'npc', 'damage', 'run-end', 'game-exit', 'duration', 'manual'}
        for key, flag in [('startOn', '--start-on'), ('stopOn', '--stop-on')]:
            if key not in values:
                continue
            value = values[key]
            if not isinstance(value, str) or value not in triggers or (key == 'startOn' and value in {'duration', 'manual'}) or (key == 'stopOn' and value == 'immediate'):
                raise ValueError(f'Invalid {key} trigger')
            arguments += [flag, value]
        for key, flag in [('startDelayMs', '--start-delay-ms'), ('stopDelayMs', '--stop-delay-ms')]:
            value = values.get(key, 0)
            if type(value) is not int or not 0 <= value <= 3600000:
                raise ValueError(f'{key} must be 0..3600000 ms')
            arguments += [flag, str(value)]
    with controller_lock:
        result = subprocess.run(arguments, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=25,
                                creationflags=subprocess.CREATE_NO_WINDOW)
    if command == 'catalog':
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())
        catalog = json.loads(result.stdout)
        return {'ok': True, **catalog}
    output = result.stdout.strip()
    lines = output.splitlines()
    state = lines[0].split(' | ')[1] if lines and ' | ' in lines[0] else 'disconnected'
    report = next((line[8:] for line in lines if line.startswith('Report: ')), '')
    message = '\n'.join(line for line in lines[1:] if not line.startswith(('Report: ', 'Triggers: '))) or result.stderr.strip()
    available = next((line[10:].split(',') for line in lines if line.startswith('Triggers: ')), [])
    progress = re.search(r'Collecting profile: (\d+) ms / (\d+) ms', message)
    return {'ok': result.returncode == 0, 'state': state, 'message': message, 'report': report,
            'elapsedMs': int(progress[1]) if progress else 0, 'durationMs': int(progress[2]) if progress else 0,
            'availableTriggers': available, 'captureScope': True}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(assets), **kwargs)

    def end_headers(self):
        if not urlsplit(self.path).path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass

    def reply(self, body, content='application/json', status=200):
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = urlsplit(self.path)
        if route.path == '/api/health':
            self.reply(json.dumps({'app': 'isaacprof', 'root': str(root), 'parent_pid': args.parent_pid}).encode())
        elif route.path == '/api/session':
            self.reply(json.dumps({'token': token}).encode())
        elif route.path == '/api/catalog':
            try:
                self.reply(json.dumps(control('catalog')).encode())
            except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
                self.reply(json.dumps({'ok': False, 'message': str(error)}).encode(), status=400)
        elif route.path == '/api/status':
            try:
                self.reply(json.dumps(control('status')).encode())
            except (OSError, subprocess.SubprocessError) as error:
                self.reply(json.dumps({'ok': False, 'state': 'disconnected', 'message': str(error), 'report': ''}).encode())
        elif route.path.startswith('/api/'):
            self.send_error(404)
        else:
            # Ignore validators from another release served at the same localhost URL.
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != '/api/control':
            self.send_error(404); return
        # Only this local UI may control the injector. No general commands, paths,
        # uploads, game launch or game termination are exposed.
        origin = self.headers.get('Origin', '')
        allowed = {f'http://127.0.0.1:{args.port}', f'http://localhost:{args.port}', 'http://127.0.0.1:5173', 'http://localhost:5173'}
        if origin not in allowed or self.headers.get('Sec-Fetch-Site') == 'cross-site' or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_error(403); return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536:
                raise ValueError('Invalid control request size')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict) or not secrets.compare_digest(str(body.get('token', '')), token):
                self.send_error(403); return
            command = body.get('command')
            if command not in ('attach', 'record', 'stop', 'shutdown'):
                raise ValueError('Unsupported control command')
            if command == 'shutdown':
                stop_capture = body.get('stopRecording', False)
                if type(stop_capture) is not bool:
                    raise ValueError('stopRecording must be a boolean')
                if stop_capture:
                    stop_recording()
                restart = 'IsaacDoctor.exe' if packaged else 'open-profiler.ps1'
                message = f'Local server stopped. Loaded analysis stays available. Start {restart}, then reload this page to reconnect. ' + ('Recording stopped and saved.' if stop_capture else 'Native recording is unaffected.')
                self.reply(json.dumps({'ok': True, 'state': 'server-stopped', 'message': message, 'report': ''}).encode())
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self.reply(json.dumps(control(command, body)).encode())
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
            self.reply(json.dumps({'ok': False, 'state': 'error', 'message': str(error), 'report': ''}).encode(), status=400)

if __name__ == '__main__':
    if not (assets / 'index.html').is_file():
        parser.error('Viewer assets are missing. Extract the complete release archive, or build from source.')
    if packaged:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/api/health', timeout=2) as response:
                health = json.load(response)
            if health.get('app') == 'isaacprof' and pathlib.Path(health.get('root', '')).resolve() == root:
                if not args.no_browser:
                    webbrowser.open(f'http://127.0.0.1:{args.port}')
                sys.exit(0)
        except (OSError, ValueError):
            pass
    with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
        if args.parent_pid:
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            parent = kernel.OpenProcess(0x100000, False, args.parent_pid)
            if not parent:
                parser.error('Cannot monitor the controller owner process')
            def watch_parent():
                try:
                    kernel.WaitForSingleObject(parent, 0xffffffff)
                    try:
                        stop_recording()
                    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                        print(f'Could not stop recording: {error}', flush=True)
                    server.shutdown()
                finally:
                    kernel.CloseHandle(parent)
            threading.Thread(target=watch_parent, daemon=True).start()
        if packaged and not args.no_browser:
            webbrowser.open(f'http://127.0.0.1:{args.port}')
        else:
            print(f'IsaacProf viewer: http://127.0.0.1:{args.port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            if args.parent_pid:
                try:
                    stop_recording()
                except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                    print(f'Could not stop recording: {error}', flush=True)
