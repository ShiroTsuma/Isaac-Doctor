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
host = subprocess.Popen([str(binary / 'isaacprof-test-host.exe'), str(root / 'tests/instruction-scenario.lua'), '--graphics'],
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
    _, off = record(2048 | 4096)
    assert not off['instruction_samples'] and not off['sampling_stats'], 'Sampling must be opt-in'
    report, doc = record(2048 | 4096 | 8192)
    samples=doc['instruction_samples'];stats=doc['sampling_stats'][-1]
    assert len(samples)>30, len(samples)
    assert stats['successes']==len(samples) and stats['attempts']>=stats['successes']
    assert not stats['omitted'] and not stats['failed'] and not stats['skipped'], stats
    assert all(s['pause_ns']>=0 and s['cycles'] is not None for s in samples)
    cli=subprocess.run(['node','viewer/scripts/analyze.mts','samples',str(report),'--top','100','--non-interactive'],cwd=root,capture_output=True,text=True,check=True,timeout=30)
    result=json.loads(cli.stdout)['result']
    assert result['count']==len(samples) and result['available'] and result['waitCoverage']
    assert result['coveredWait']>5 and result['outsideCoveredWait']>5, result
    assert any('isaacprof-test-host.exe' in r['location'] for r in result['returns']), 'No caller candidates resolved'
    assert any('isaacprof-test-host.exe' in r['location'] or 'ntdll.dll' in r['location'] for r in result['modules']), 'No native hotspot resolved'
    assert abs(result['pauseTotal']-sum(s['pause_ns'] for s in samples)/1e6)<.001
    assert result['sessionStats']['successes']==len(samples)
    verify=subprocess.run(['node','viewer/scripts/analyze.mts','verify',str(report),'--non-interactive'],cwd=root,capture_output=True,text=True,check=True,timeout=30)
    _, independent = record(8192)
    assert independent['instruction_samples'] and not independent['native_waits'] and not independent['presentation']
    assert independent['sampling_stats'][-1]['successes']==len(independent['instruction_samples']), 'Session counters not reset'
    _, disabled = record(0)
    assert not disabled['instruction_samples'] and not disabled['sampling_stats'], 'Disabled sampler still emitted data'
    assert host.poll() is None, 'Sampler altered owned host semantics or failed to resume'
    print(json.dumps(dict(status='PASS',samples=len(samples),covered_wait=result['coveredWait'],outside_covered_wait=result['outsideCoveredWait'],pause_ms=result['pauseTotal'],max_pause_ms=result['pauseMaximum'],modules=result['modules'],capture=str(report))))

finally:
    if host.poll() is None:
        host.terminate()
    _, errors = host.communicate(timeout=10)
    assert not errors, errors
    output = root / 'build/presentation-qa'
    output.mkdir(exist_ok=True)
    for report in reports:
        report.replace(output / report.name)
