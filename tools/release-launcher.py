"""Visible portable launcher; a monitored child owns the local controller."""
import argparse
import json
import os
import pathlib
import runpy
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import webbrowser


def run_controller():
    sys.argv.remove('--controller')
    runpy.run_module('viewer-server', run_name='__main__')


def main():
    parser = argparse.ArgumentParser(description='Start the portable Isaac Doctor viewer.')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--pid', type=int, help='Controlled test host; otherwise finds the already running game')
    args = parser.parse_args()
    root = pathlib.Path(sys.executable).resolve().parent
    base = f'http://127.0.0.1:{args.port}'

    def request(route, body=None):
        headers = {'Content-Type': 'application/json', 'Origin': base}
        req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body else None, headers=headers)
        with urllib.request.urlopen(req, timeout=25 if body else 2) as response:
            return json.load(response)

    def open_browser():
        if not args.no_browser:
            webbrowser.open(base + '/?session=' + uuid.uuid4().hex)

    try:
        existing = request('/api/health')
    except (OSError, ValueError):
        existing = None
    if existing:
        if existing.get('app') != 'isaacprof' or pathlib.Path(existing.get('root', '')).resolve() != root:
            raise RuntimeError(f'Port {args.port} belongs to another instance. Stop that instance first, or use --port with a different port.')
        if existing.get('parent_pid'):
            print('Isaac Doctor is already running in another window.', flush=True)
            open_browser()
            return 0
        print('Closing the previous background instance before starting this window...', flush=True)
        session = request('/api/session')
        stopped = request('/api/control', {'token': session['token'], 'command': 'shutdown', 'stopRecording': True})
        if not stopped.get('ok'):
            raise RuntimeError(stopped.get('message', 'Could not close the previous instance.'))
        for _ in range(100):
            try:
                request('/api/health')
            except OSError:
                break
            time.sleep(.05)
        else:
            raise RuntimeError('The previous background instance has not closed yet. Try again shortly.')

    print('Isaac Doctor\nStarting the local server...', flush=True)
    log_path = root / 'IsaacDoctor.log'
    command = [sys.executable, '--controller', '--no-browser', '--port', str(args.port), '--parent-pid', str(os.getpid())]
    if args.pid is not None:
        command += ['--pid', str(args.pid)]
    child = None
    with log_path.open('w', encoding='utf-8') as log:
        try:
            child = subprocess.Popen(command, cwd=root, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            for _ in range(200):
                if child.poll() is not None:
                    raise RuntimeError(f'Local server failed to start. Details: {log_path}')
                try:
                    health = request('/api/health')
                    if health.get('parent_pid') == os.getpid():
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.05)
            else:
                raise RuntimeError(f'Local server did not start. Details: {log_path}')
            print(f'Running at {base}\nKeep this window open while using game recording.\nClose this window, press Ctrl+C, or choose Stop local server to stop recording and exit.\nThe game stays running. Closing only the browser tab does not exit Isaac Doctor.', flush=True)
            open_browser()
            while child.poll() is None:
                time.sleep(.1)
            return child.returncode
        except KeyboardInterrupt:
            print('Stopping recording and closing the local server...', flush=True)
            return 0
        finally:
            if child and child.poll() is None:
                try:
                    session = request('/api/session')
                    request('/api/control', {'token': session['token'], 'command': 'shutdown', 'stopRecording': True})
                    child.wait(timeout=25)
                except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                    # When this owner exits, the child's parent monitor also stops recording.
                    print(f'Cleanup will finish in the controller: {error}', flush=True)


if __name__ == '__main__':
    if '--controller' in sys.argv:
        run_controller()
    else:
        try:
            sys.exit(main())
        except (OSError, ValueError, RuntimeError) as error:
            print(f'Isaac Doctor: {error}', file=sys.stderr, flush=True)
            if sys.stdin.isatty():
                try:
                    input('Press Enter to close this window.')
                except (EOFError, KeyboardInterrupt):
                    pass
            sys.exit(1)
