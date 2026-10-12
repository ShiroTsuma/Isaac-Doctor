"""Independent GL presentation capture, session reset and disabled-channel behavior."""
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from capture import read_capture

binary = root / 'build/Release'
if b'LUA_REPENTOGON\x00' in (binary / 'Lua5.3.3r.dll').read_bytes():
    raise SystemExit('Refusing production REPENTOGON Lua in the owned test host')
host = subprocess.Popen([str(binary / 'isaacprof-test-host.exe'), str(root / 'tests/presentation-scenario.lua'), '--graphics'],
                        cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
reports = []

def run(*args):
    result = subprocess.run([str(binary / 'isaacprof-injector.exe'), *args, '--pid', str(host.pid)],
                            capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout

def record(mask, screenshots=False):
    args = ['record', '--seconds', '2', '--channels', str(mask)]
    if screenshots:
        args += ['--screenshots', '--screenshot-ms', '250']
    run(*args)
    time.sleep(2.3)
    status = run('status')
    assert '| ready |' in status, status
    report = pathlib.Path(next(line[8:] for line in status.splitlines() if line.startswith('Report: ')))
    reports.append(report)
    return report, read_capture(report)

try:
    assert 'READY' in host.stdout.readline()
    run('attach')
    for _ in range(100):
        if '| ready |' in run('status'):
            break
        time.sleep(.02)
    else:
        raise AssertionError('Host did not become ready')
    report, doc = record(2048 | 4096)
    rows = doc['presentation']
    # Several sequential 1 ms waits can each last one scheduler quantum.
    assert len(rows) > 10, len(rows)
    assert not doc['timeline']['events'] and not doc['frame_intervals'] and not doc['screenshots']['images']
    assert max(r['duration_ns'] for r in rows) > 30_000_000, 'Missed controlled outside-Lua engine delay'
    assert max(r['duration_ns'] - r['swap_ns'] - r['readback_ns'] for r in rows) > 30_000_000
    assert all(r['success'] and r['cycles'] is not None and r['swap_cycles'] <= r['cycles'] for r in rows)
    assert rows[0]['id'] == 1 and all(b['start_ns'] >= a['start_ns'] + a['duration_ns'] for a, b in zip(rows, rows[1:]))
    cli = subprocess.run(['node', 'viewer/scripts/analyze.mts', 'presentation', str(report), '--top', '5', '--non-interactive'],
                         cwd=root, capture_output=True, text=True, check=True, timeout=30)
    result = json.loads(cli.stdout)['result']
    assert result['available'] and result['count'] == len(rows) and len(result['rows']) == 5
    assert result['outside']['maximum'] > 30 and result['gaps'] == 0
    waits = doc['native_waits']
    assert any(r['kind'] == 1 and r['requested_ms'] == 35 and r['duration_ns'] > 30_000_000 for r in waits), 'Controlled sleep was not captured'
    assert set(r['kind'] for r in waits) == {1, 2, 3, 4, 5, 6}, 'Missing native wait API coverage'
    assert all(r['result'] == 258 for r in waits if r['kind'] >= 3 and r['requested_ms'] == 1), 'Changed timeout result'
    assert doc['render_states'] and doc['render_states'][0]['viewport'][2:] == [640, 360]
    assert doc['render_states'][0]['wait_hooks'] == 63
    assert result['waits']['count'] == len(waits) and result['renderStates'][0]['width'] == 640
    assert any('isaacprof-test-host.exe+0x' in r['callSite'] for r in result['waits']['callers']), 'Wait caller module was not resolved'
    wait_cli = subprocess.run(['node', 'viewer/scripts/analyze.mts', 'waits', str(report), '--top', '5', '--non-interactive'], cwd=root, capture_output=True, text=True, check=True, timeout=30)
    assert json.loads(wait_cli.stdout)['result']['count'] == len(waits)
    _, off = record(0)
    assert not off['presentation'], 'Disabled presentation channel still emitted data'
    assert not off['native_waits'] and not off['render_states']
    _, waits_only = record(4096)
    assert waits_only['native_waits'], 'Wait channel incorrectly depends on presentation'
    assert not waits_only['presentation'] and not waits_only['render_states']
    _, second = record(2048, screenshots=True)
    assert second['presentation'][0]['id'] == 1 and second['screenshots']['images'], 'Session reset or separate screenshot option failed'
    assert not second['native_waits'], 'Disabled waits still emitted data'
    assert host.poll() is None, 'Hook altered owned GL host state'
    print('PASS: six wait APIs and controlled delay captured with module offsets; Python/TS agree; Windows results and GL state preserved; reset, independent channels and screenshots verified')
finally:
    if host.poll() is None:
        host.terminate()
    _, errors = host.communicate(timeout=10)
    assert not errors, errors
    output = root / 'build/presentation-qa'
    output.mkdir(exist_ok=True)
    for report in reports:
        report.replace(output / report.name)
