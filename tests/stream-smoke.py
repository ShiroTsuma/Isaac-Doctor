"""Controlled x86 host / x64 collector. Never starts Isaac. Artifacts in stream-dev only."""
import pathlib
import struct
import subprocess
import sys
import time
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tools'))
from capture import read_capture,decode
binary=root/'build/stream-dev/Release'
if b'LUA_REPENTOGON\x00' in (binary/'Lua5.3.3r.dll').read_bytes():raise SystemExit('Refusing production Lua')
def host(script,graphics=False):
    p=subprocess.Popen([str(binary/'isaacprof-test-host.exe'),str(script),*(['--graphics'] if graphics else [])],cwd=binary,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    assert 'READY' in p.stdout.readline();return p
def run(p,*args,success=True):
    r=subprocess.run([str(binary/'isaacprof-injector.exe'),*args,'--pid',str(p.pid)],capture_output=True,text=True,timeout=25)
    assert (r.returncode==0)==success,r.stdout+r.stderr
    return r.stdout
def wait(p,state):
    for _ in range(300):
        result=run(p,'status')
        if f'| {state} |' in result:return result
        assert p.poll() is None,'Controlled host exited';time.sleep(.04)
    raise AssertionError(result)
def report(result):return pathlib.Path(next(line[8:] for line in result.splitlines() if line.startswith('Report: ')))
def attach(p):run(p,'attach');wait(p,'ready')
def stop_host(p):
    if p.poll() is None:p.terminate()
    _,error=p.communicate(timeout=10);assert not error,error
p=host(root/'tests/scenario.lua')
try:
    attach(p);run(p,'record','--seconds','2','--trace','--events','128');path=report(wait(p,'ready'));doc=read_capture(path)
    assert doc['binary_version']==3 and doc['complete']
    assert len(doc['timeline']['events'])>128 and not doc['timeline']['dropped_events'],doc['timeline']
    assert len(doc['timeline']['events'])==sum(m['calls'] for m in doc['metrics'])
    assert any(e[4]>0 for e in doc['timeline']['events']) and any(e[6] for e in doc['timeline']['events'])
    assert doc['telemetry']['errors'] and all(e['message']=='Non-string Lua error object' and 'stack traceback' in e['stack'] for e in doc['telemetry']['errors'])
    assert doc['telemetry']['overhead'][-1]['samples']>0
    result=subprocess.run([str(binary/'isaacprof-analyze.exe'),str(path)],capture_output=True,text=True);assert result.returncode==0,result.stderr
    raw=path.read_bytes();partial=decode(raw[:-40]);assert not partial['complete'] and partial['timeline']['events']
    corrupt=bytearray(raw);corrupt[100]^=1
    try:decode(corrupt);raise AssertionError('Corruption accepted')
    except ValueError:pass
    run(p,'record','--seconds','2','--trace','--min-us','1000');filtered=read_capture(report(wait(p,'ready')))
    assert filtered['timeline']['minimum_duration_ns']>=999999 and filtered['timeline']['filtered_events']>0
    assert all(e[2]>=999999 for e in filtered['timeline']['events'])
    assert sum(m['calls'] for m in filtered['metrics'])>len(filtered['timeline']['events'])
    run(p,'record','--seconds','1','--trace','--events','1');overflow=read_capture(report(wait(p,'ready')));assert overflow['timeline']['dropped_events']>0
    print('PASS: streaming beyond buffer capacity, exact complete totals, nesting/errors/coroutines, 1000 us filter keeps aggregates, overflow, CRC rejection, truncated prefix, native analyzer')
finally:stop_host(p)
p=host(root/'tests/recording-scenario.lua',True);trigger=binary/f'isaacprof-test-run-{p.pid}.trigger'
try:
    attach(p);run(p,'record','--seconds','1','--trace','--after-load','--screenshots','--screenshot-ms','250');time.sleep(.2)
    assert '| armed |' in run(p,'status');assert not list((binary/'captures').glob(f'capture-*-pid{p.pid}-*'))
    cancelled=run(p,'stop');assert 'Report: ' not in cancelled;assert not list((binary/'captures').glob(f'capture-*-pid{p.pid}-*'))
    run(p,'record','--seconds','2','--trace','--after-load','--screenshots','--screenshot-ms','250');trigger.write_bytes(b'run loaded');wait(p,'recording');path=report(wait(p,'ready'));doc=read_capture(path)
    assert doc['complete'] and len(doc['screenshots']['images'])>=4
    updates=[f for f in doc['frame_intervals'] if f['kind']==1];renders=[f for f in doc['frame_intervals'] if f['kind']==2]
    assert len(updates)>10 and len(renders)>=2*len(updates)-2
    assert max(f['duration'] for f in renders)>35e6
    telemetry=doc['telemetry'];assert len(telemetry['counters'])>=6 and len(telemetry['heap'])>=6
    assert len(telemetry['context'])>=5
    assert all(s['valid']==7 and s['grids']==3 and s['entities']==5 and s['enemies']==1 and s['effects']==1 and s['projectiles']==1 for s in telemetry['context'])
    assert len({s['room'] for s in telemetry['context']})>1
    assert telemetry['overhead'][-1]['observer_ticks']>0 and telemetry['overhead'][-1]['context_failures']==0
    assert telemetry['errors'] and 'stack traceback' in telemetry['errors'][0]['stack']
    assert all(s['valid']==7 and s['working_set']>0 and s['private_bytes']>0 for s in telemetry['counters'])
    assert all(s['bytes']>0 for s in telemetry['heap'])
    assert {1,3,4,5,6}.issubset({m['kind'] for m in telemetry['markers']})
    assert telemetry['inventory'] and any(s['mod']=='Render stall test' for chunk in telemetry['inventory'] for s in chunk['sources'])
    assert not any(m['mod']=='IsaacProf lifecycle' for m in doc['metrics'])
    (binary/'frame-capture-path.txt').write_text(str(path),encoding='utf-8')
    print(f'PASS: armed cancellation creates no capture; deferred recording and {len(doc["screenshots"]["images"])} PNGs in streaming blocks')
finally:
    stop_host(p);trigger.unlink(missing_ok=True)
fast=binary/'fast-scenario.lua'
fast.write_text((root/'tests/scenario.lua').read_text()+"\nIsaac.AddCallback({Name='Fast stream test'}, 'FAST', function() end)\nfunction TestTick() for i=1,12000 do Isaac.RunCallback('FAST') end end\n",encoding='utf-8')
p=host(fast)
try:
    attach(p);run(p,'record','--seconds','8','--trace','--events','250000');path=report(wait(p,'ready'))
    # Count block headers without materializing millions of Python objects.
    total=0;offset=40;raw=path.read_bytes()
    while raw[offset:offset+8]!=b'IPEND003':
        _,kind,_,size,count,*_=struct.unpack_from('<IHHIIQQQII',raw,offset)
        if kind==2:total+=count
        offset+=48+size
    assert total>250000,total
    print(f'PASS: high-volume collector retained {total:,} events ({path.stat().st_size/1024/1024:.1f} MiB). Fixture: {path}')
    (binary/'large-capture-path.txt').write_text(str(path),encoding='utf-8')
finally:stop_host(p)
