"""Real x86 injection / x64 collector test. Starts owned Lua hosts only."""
import json
import datetime
import os
import pathlib
import re
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tools'))
from capture import read_capture
binary = root / 'build/stream-dev/Release'
dll = pathlib.Path(os.environ.get('ISAACPROF_TEST_DLL', binary / 'isaacprof.dll'))
host = subprocess.Popen([str(binary / 'isaacprof-test-host.exe'), str(root / 'tests/trigger-scenario.lua')], cwd=binary, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
assert 'READY' in host.stdout.readline()
event_file = binary / f'isaacprof-events-{host.pid}.trigger'
reports = []

def run(*arguments, success=True):
    result = subprocess.run([str(binary / 'isaacprof-injector.exe'), *arguments, '--pid', str(host.pid)], capture_output=True, text=True, encoding='utf8', timeout=25)
    assert (result.returncode == 0) == success, result.stdout + result.stderr
    return result.stdout + result.stderr

def wait(state):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        result = run('status')
        if f'| {state} |' in result:
            return result
        time.sleep(.015)
    raise AssertionError(result)

def event(name):
    pending_event=event_file.with_suffix('.pending')
    pending_event.write_text(name, encoding='ascii')
    pending_event.replace(event_file)
    deadline = time.monotonic() + 2
    while event_file.exists() and time.monotonic() < deadline:
        time.sleep(.002)
    assert not event_file.exists(), 'Controlled event was not consumed'

def complete(output):
    path = pathlib.Path(next(line[8:] for line in output.splitlines() if line.startswith('Report: ')))
    reports.append(path)
    doc = read_capture(path)
    assert doc['complete'] and doc['profiler_version'] == '0.11.0'
    match = re.fullmatch(r'capture-(\d{4}-\d\d-\d\d)_([\d-]+)Z-pid(\d+)-(\d+)\.isaacprof', path.name)
    assert match and int(match[3]) == host.pid, path.name
    date, hour, minute, second, millis = match[1], *match[2].split('-')
    timestamp = datetime.datetime.fromisoformat(f'{date}T{hour}:{minute}:{second}.{millis}+00:00')
    assert abs((datetime.datetime.now(datetime.timezone.utc) - timestamp).total_seconds()) < 60
    return doc

try:
    run('attach', '--dll', str(dll)); status = wait('ready')
    assert 'Triggers: immediate,run-load,room-entry,level-entry,projectile,tear,effect,npc,damage,run-end,game-exit,duration,manual' in status
    catalog=json.loads(run('catalog'))
    assert 'Unicode m\u00f3d' in catalog['mods']
    assert 'Trigger payload' in catalog['mods'] and 'MC_POST_RENDER' in catalog['hooks'], catalog
    run('record','--trace','--channels','12','--stop-on','manual')
    time.sleep(.2);doc=complete(run('stop'))
    assert doc['configuration']['channels']==12 and not doc['metrics'] and not doc['timeline']['events']
    assert {f['kind'] for f in doc['frame_intervals']}=={1,2}
    assert all(not value for value in doc['telemetry'].values()), doc['telemetry']
    run('record','--trace','--channels','3','--mod','Trigger payload','--hook','MC_POST_RENDER','--stop-on','manual')
    time.sleep(.2);doc=complete(run('stop'))
    assert doc['configuration']['selectedMods']==['Trigger payload'] and doc['configuration']['selectedHooks']==['MC_POST_RENDER']
    assert doc['metrics'] and all(m['mod']=='Trigger payload' and m['callback_name']=='MC_POST_RENDER' for m in doc['metrics'])
    assert doc['timeline']['events'] and not doc['frame_intervals'] and all(not value for value in doc['telemetry'].values())
    run('record','--trace','--channels','3','--mod','Unknown mod','--hook','1','--stop-on','manual')
    time.sleep(.06);doc=complete(run('stop'));assert not doc['metrics'] and not doc['timeline']['events']
    run('record','--trace','--channels','3','--mod','Unicode m\u00f3d','--hook','2','--stop-on','manual')
    time.sleep(.08);doc=complete(run('stop'));assert len(doc['metrics'])==1 and doc['metrics'][0]['mod']=='Unicode m\u00f3d'
    assert doc['configuration']['selectedMods']==['Unicode m\u00f3d']
    print('PASS: live callback catalog, FPS/UPS-only capture, intersecting mod/hook filters, binary capture scope')
    for name in ['immediate', 'run-load', 'room-entry', 'level-entry', 'projectile', 'tear', 'effect', 'npc', 'damage', 'run-end', 'game-exit']:
        run('record', '--trace', '--start-on', name, '--stop-on', 'manual')
        if name not in ['immediate', 'run-load']:
            assert '| armed |' in run('status');event(name)
        wait('recording');doc = complete(run('stop'))
        if name not in ['immediate', 'run-load']:
            assert any(m['callback_name'] == {'room-entry':'MC_POST_NEW_ROOM','level-entry':'MC_POST_NEW_LEVEL','projectile':'MC_POST_PROJECTILE_INIT','tear':'MC_POST_TEAR_INIT','effect':'MC_POST_EFFECT_INIT','npc':'MC_POST_NPC_INIT','damage':'MC_ENTITY_TAKE_DMG','run-end':'MC_POST_GAME_END','game-exit':'MC_PRE_GAME_EXIT'}[name] and m['calls'] for m in doc['metrics']), 'Trigger payload was omitted'
    print('PASS: all 11 start triggers, triggering callback included, supported capabilities, UTC filenames')
    for name in ['run-load', 'room-entry', 'level-entry', 'projectile', 'tear', 'effect', 'npc', 'damage', 'run-end', 'game-exit']:
        run('record', '--trace', '--start-on', 'immediate', '--stop-on', name, '--stop-delay-ms', '100')
        if name != 'run-load':event(name)
        doc = complete(wait('ready'));assert doc['duration_ns'] >= 90e6
    print('PASS: all 10 event stop conditions and stop delay')
    run('record', '--trace', '--start-on', 'projectile', '--start-delay-ms', '300', '--stop-on', 'projectile', '--stop-delay-ms', '250')
    start = time.monotonic();event('projectile');time.sleep(.1);event('projectile');wait('recording')
    elapsed = time.monotonic() - start;assert .28 <= elapsed <= .48, elapsed
    event('projectile');time.sleep(.1);event('projectile');doc = complete(wait('ready'))
    assert 230e6 <= doc['duration_ns'] <= 420e6, doc['duration_ns']
    print('PASS: start/stop delays latch once; same-event stop waits for another occurrence')
    run('record', '--start-on', 'immediate', '--start-delay-ms', '1000')
    assert '| armed |' in run('status');assert 'Report: ' not in run('stop');time.sleep(.15);assert '| ready |' in run('status')
    run('record', '--trace', '--seconds', '1', '--stop-delay-ms', '120')
    doc = complete(wait('ready'));assert 1100e6 <= doc['duration_ns'] <= 1300e6, doc['duration_ns']
    print('PASS: cancellation during start delay, duration plus stop delay, manual Stop remains immediate')
    run('record', '--trace', '--seconds', '1', '--stop-on', 'manual')
    time.sleep(1.15);assert '| recording |' in run('status');doc=complete(run('stop'))
    assert doc['configuration']['maxDurationMs']==0 and doc['duration_ns']>1e9
    for stop_on in ['manual','projectile']:
        run('record','--trace','--stop-on',stop_on,'--stop-delay-ms','5000','--max-duration-ms','250')
        doc=complete(wait('ready'));assert 230e6 <= doc['duration_ns'] <= 450e6, doc['duration_ns']
        assert doc['configuration']['version']==2 and doc['configuration']['maxDurationMs']==250
        assert doc['configuration']['stopDelayMs']==(0 if stop_on=='manual' else 5000)
    run('record','--trace','--stop-on','projectile','--stop-delay-ms','100','--max-duration-ms','2000')
    event('projectile');doc=complete(wait('ready'));assert 90e6 <= doc['duration_ns'] <= 350e6
    run('record','--trace','--stop-on','projectile','--stop-delay-ms','5000','--max-duration-ms','250')
    event('projectile');doc=complete(wait('ready'));assert 230e6 <= doc['duration_ns'] <= 450e6
    run('record','--trace','--start-on','projectile','--start-delay-ms','200','--stop-on','manual','--max-duration-ms','250')
    start=time.monotonic();event('projectile');doc=complete(wait('ready'))
    assert time.monotonic()-start>=.42 and 230e6 <= doc['duration_ns'] <= 450e6
    run('record','--trace','--stop-on','manual','--max-duration-ms','2000')
    time.sleep(.1);doc=complete(run('stop'));assert doc['duration_ns']<1e9
    print('PASS: manual has no implicit duration; independent maximum stops missing events or long delays; collection-only clock and immediate manual Stop')
    for arguments in [('--max-duration-ms','-1'),('--max-duration-ms','1.5'),('--max-duration-ms','3600001'),('--start-on','duration'),('--stop-on','immediate'),('--start-delay-ms','-1'),('--stop-delay-ms','1.5'),('--after-load','--start-on','projectile')]:
        run('record', *arguments, success=False)
    print('PASS: invalid/ambiguous trigger configuration rejected')
finally:
    if host.poll() is None:host.terminate()
    _, errors = host.communicate(timeout=10);assert not errors, errors
    event_file.unlink(missing_ok=True)
    # Only this owned PID's artifacts; keep test recordings out of the user's list.
    target = root / 'build/capture-trigger-qa';target.mkdir(exist_ok=True)
    for report in reports:
        assert f'-pid{host.pid}-' in report.name and report.resolve().is_relative_to(root / 'build')
        report.replace(target / report.name)
