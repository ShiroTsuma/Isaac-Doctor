"""Exercise real x86 DLL injection, callback semantics, capture and analyzer."""
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root/'tools'))
from capture import read_capture
binary = root / 'build' / (sys.argv[1] if len(sys.argv) > 1 else 'Release')
# Production REPENTOGON Lua has a launcher guard in DllMain. Do not load that
# DLL into this standalone host or spoof the launcher's environment marker.
lua_binary = binary / 'Lua5.3.3r.dll'
if b'LUA_REPENTOGON\x00' in lua_binary.read_bytes():
    raise SystemExit('Production REPENTOGON DLL detected. Test it only in a game started by REPENTOGONLauncher.')
host = subprocess.Popen([str(binary / 'isaacprof-test-host.exe'), str(root / 'tests/scenario.lua')],
                        cwd=binary, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def run(*args, success=True):
    result = subprocess.run([str(binary / 'isaacprof-injector.exe'), *args, '--pid', str(host.pid)],
                            capture_output=True, text=True, timeout=25)
    if (result.returncode == 0) != success:
        raise AssertionError(f'{args}: {result.returncode}\n{result.stdout}\n{result.stderr}')
    return result.stdout

try:
    time.sleep(0.5)
    assert host.poll() is None, 'host failed before injection'
    print(run('attach'))
    for _ in range(100):
        output = run('status')
        if '| ready |' in output:
            break
        assert '| failed |' not in output, output
        time.sleep(0.1)
    else:
        raise AssertionError('instrumentation never became ready')
    print(output)
    print(run('record', '--seconds', '2', '--trace'))
    assert 'ERROR: A capture is already running' in run('record', '--seconds', '2', success=False)
    time.sleep(2.5)
    assert host.poll() is None, 'host callback semantics failed'
    output = run('status')
    print(output)
    captures = sorted((binary / 'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))
    assert captures
    document = read_capture(captures[-1])
    assert captures[-1].read_bytes().startswith(b'ISAACPRF')
    assert document['complete'] and document['schema_version'] == 1
    assert document['duration_ns'] > 1e9
    rows = document['metrics']
    slow = next(r for r in rows if r['mod']=='Slow test mod' and r['callback_id']=='1')
    child = next(r for r in rows if r['mod']=='Nested test mod')
    bad = next(r for r in rows if r['mod']=='Error test mod')
    # Start/stop may occur between the parent's and child's calls.
    assert slow['calls'] > 5 and abs(child['calls']-slow['calls']) <= 2
    assert slow['inclusive_ns'] > slow['exclusive_ns'] > 0
    assert bad['errors']==bad['calls'] and bad['calls'] > 5
    assert all(r['line'] > 0 and 'scenario.lua' in r['source'] for r in rows)
    assert not any(r['callback_id']=='4' for r in rows)
    assert any(r['callback_id']=='PREEXISTING' and r['calls']>5 for r in rows)
    assert document['lua_version']==504 and document['lua'].endswith('Lua5.3.3r.dll')
    assert document['mode']=='native-callback-wall-time' and document['skipped_coroutine_calls']>0
    assert not any(r['callback_id']=='YIELD' for r in rows)
    timeline = document['timeline']
    assert timeline['enabled'] and timeline['version']==1 and timeline['dropped_events']==0
    events = timeline['events']
    assert len(events)==sum(r['calls'] for r in rows)
    assert events==sorted(events, key=lambda e:(e[1],e[4]))
    by_id = {r['id']:r for r in rows}
    assert all(e[0] in by_id and 0<=e[3]<=e[2] and e[1]>=0 and e[1]+e[2]<=document['duration_ns'] for e in events)
    parent = next(e for e in events if e[0]==slow['id'])
    assert any(e[0]==child['id'] and e[4]==parent[4]+1 and e[1]>=parent[1] and e[1]+e[2]<=parent[1]+parent[2] for e in events)
    assert sum(e[6] for e in events if e[0]==bad['id'])==bad['errors']
    analysis = subprocess.run([str(binary/'isaacprof-analyze.exe'), str(captures[-1]), '--callbacks'],
                              capture_output=True, text=True, timeout=5)
    assert analysis.returncode==0, analysis.stderr
    print(analysis.stdout)
    # Repeated sessions must reset counters and produce distinct files.
    print(run('record', '--seconds', '10', '--trace', '--events', '3'))
    time.sleep(0.25)
    print(run('stop'))
    assert len(list((binary/'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))) == 2
    capped = read_capture(sorted((binary/'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))[-1])
    # --events limits the pending ring, not total retained events in a stream.
    assert capped['timeline']['capacity']==3 and len(capped['timeline']['events'])>3
    measured=sum(r['calls'] for r in capped['metrics'])
    assert len(capped['timeline']['events'])+capped['timeline']['dropped_events']==measured
    print(run('record', '--seconds', '10', '--trace', '--min-us', '1000000'))
    time.sleep(0.25)
    print(run('stop'))
    filtered = read_capture(sorted((binary/'captures').glob(f'capture-*-pid{host.pid}-*.isaacprof'))[-1])
    assert not filtered['timeline']['events'] and filtered['timeline']['filtered_events']>0
    # Malformed/unrecognized capture versions must not silently appear valid.
    invalid = binary/'invalid-test.isaacprof'
    invalid.write_bytes(b'ISAACPRF'+(999).to_bytes(4,'little'))
    rejected = subprocess.run([str(binary/'isaacprof-analyze.exe'), str(invalid)], capture_output=True, text=True)
    assert rejected.returncode != 0
    invalid.write_bytes(captures[-1].read_bytes()[:-1])
    rejected = subprocess.run([str(binary/'isaacprof-analyze.exe'), str(invalid)], capture_output=True, text=True)
    # Streaming readers salvage valid snapshots when the terminal index is
    # truncated, explicitly distinguishing them from complete recordings.
    assert rejected.returncode == 0 and 'partial snapshot' in rejected.stdout
    invalid.unlink()
    print('PASS: native wrappers, callback semantics, nested timeline, event limits/filtering, sessions, analyzer')
finally:
    if host.poll() is None:
        host.terminate()
    stdout, stderr = host.communicate(timeout=10)
    if stderr:
        print(stderr, file=sys.stderr)
