"""Compare identical no-op callbacks without DLL, idle, and during capture."""
import json
import pathlib
import statistics
import subprocess
import time
import sys

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root/'tools'))
from capture import read_capture
binary = root / 'build' / (sys.argv[1] if len(sys.argv)>1 else 'Release')
if b'LUA_REPENTOGON\x00' in (binary/'Lua5.3.3r.dll').read_bytes():
    raise SystemExit('Production Lua must only run through REPENTOGONLauncher.')
request, result = binary/'benchmark-request.txt', binary/'benchmark-result.txt'
for path in (request, result):
    path.unlink(missing_ok=True)
host = subprocess.Popen([str(binary/'isaacprof-test-host.exe'), str(root/'tests/benchmark.lua')], cwd=binary,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def command(*args):
    completed = subprocess.run([str(binary/'isaacprof-injector.exe'), *args, '--pid', str(host.pid)],
                               capture_output=True, text=True, timeout=25)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return completed.stdout

def measure(stage):
    result.unlink(missing_ok=True)
    request.write_text(stage, encoding='ascii')
    deadline = time.monotonic() + 15
    while not result.exists():
        assert host.poll() is None, 'host exited during benchmark'
        assert time.monotonic() < deadline, 'benchmark timeout'
        time.sleep(0.05)
    rows = result.read_text().splitlines()
    assert rows[0] == stage
    samples = [float(row) for row in rows[1:]]
    return {'median_ns_per_call': statistics.median(samples), 'samples_ns_per_call': samples}

try:
    time.sleep(0.3)
    measured = {'baseline': measure('baseline')}
    command('attach')
    for _ in range(100):
        if '| ready |' in command('status'):
            break
        time.sleep(0.1)
    else:
        raise AssertionError('profiler never became ready')
    measured['idle'] = measure('idle')
    command('record', '--seconds', '30')
    measured['recording'] = measure('recording')
    command('stop')
    baseline = measured['baseline']['median_ns_per_call']
    for stage in ('idle', 'recording'):
        measured[stage]['added_ns_per_call'] = measured[stage]['median_ns_per_call'] - baseline
    report = sorted((binary/'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))[-1]
    version = read_capture(report)['profiler_version']
    document = {'profiler_version': version, 'mode': 'aggregate-only', 'workload': 'no-op callback, 7 batches of 200000 calls',
                'limitations': 'Synthetic host; os.clock resolution and scheduling affect results. Not a gameplay FPS estimate.',
                'results': measured}
    (root/'build/benchmark-native.json').write_text(json.dumps(document, indent=2), encoding='utf-8')
    print(json.dumps(document, indent=2))
finally:
    if host.poll() is None:
        host.terminate()
    _, stderr = host.communicate(timeout=10)
    for path in (request, result):
        path.unlink(missing_ok=True)
    if stderr:
        print(stderr)
