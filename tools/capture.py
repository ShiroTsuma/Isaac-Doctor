"""Binary .isaacprof v1/v2/v3 decoder, shared by controlled tests."""
import pathlib
import struct
import zlib

def decode_stream(data):
    if len(data)<40 or struct.unpack_from('<I',data,12)[0]!=40:
        raise ValueError('Invalid streaming header')
    frequency=struct.unpack_from('<Q',data,24)[0]
    if not frequency: raise ValueError('Invalid QPC frequency')
    index_offset=index_size=index_end=-1
    offset=40; metadata=None; events=[]; shots=[]; intervals=[]; counters=[];heap=[];markers=[];inventory=[];context=[];overhead=[];errors=[];presentation=[];waits=[];render_states=[];configuration=None;finalized=False
    while offset+8<=len(data):
        if data[offset:offset+8]==b'IPEND003':
            finalized=offset+32<=len(data) and index_end==offset and struct.unpack_from('<QI',data,offset+8)==(index_offset,index_size);break
        if offset+48>len(data): break
        magic,kind,version,size,count,sequence,minimum,maximum,crc,flags=struct.unpack_from('<IHHIIQQQII',data,offset)
        if magic!=0x4b4e4843 or size>64*1024*1024 or (kind<=19 and version!=1): raise ValueError('Invalid stream block')
        offset+=48
        if offset+size>len(data): break
        payload=data[offset:offset+size];offset+=size
        if zlib.crc32(payload)!=crc: raise ValueError('Streaming checksum failed')
        if kind==5: index_offset=offset-size-48;index_size=size;index_end=offset
        if kind==1: metadata=decode(payload)
        elif kind==2:
            if size!=8+count*64: raise ValueError('Invalid event block')
            for p in range(8,size,64):
                ident,thread,depth,error,parent_metric,span,parent,start,length,self_ticks,frame=struct.unpack_from('<IIHHIQQQQQQ',payload,p)
                events.append([ident,start*1e9/frequency,length*1e9/frequency,self_ticks*1e9/frequency,depth,thread,error])
        elif kind==3:
            time,width,height,encoding,length=struct.unpack_from('<dHHII',payload)
            if encoding!=1 or length!=len(payload)-20 or not payload[20:].startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('Invalid screenshot block')
            shots.append(dict(time_ns=time,width=width,height=height,png=payload[20:]))
        elif kind==7:
            if size!=count*32: raise ValueError('Invalid interval block')
            for p in range(0,size,32):
                ident,start,length,clock,thread=struct.unpack_from('<QQQII',payload,p)
                if not ident or not length or clock not in (1,2): raise ValueError('Invalid interval record')
                intervals.append(dict(id=ident,start=start*1e9/frequency,duration=length*1e9/frequency,kind=clock,thread=thread))
        elif kind in (8,9,10):
            stride={8:72,9:16,10:48}[kind]
            if size!=count*stride or not count or count>4096:raise ValueError('Invalid telemetry block')
            for p in range(0,size,stride):
                values=struct.unpack_from({8:'<QQQQQQQQII',9:'<QQ',10:'<QQQQIIQ'}[kind],payload,p)
                record=dict(zip({8:['ticks','working_set','private_bytes','page_faults','process_user','process_kernel','thread_user','thread_kernel','thread','valid'],9:['ticks','bytes'],10:['ticks','run','room','level','kind','flags','reserved']}[kind],values));record['time_ns']=record.pop('ticks')*1e9/frequency
                {8:counters,9:heap,10:markers}[kind].append(record)
        elif kind in (12,13):
            stride=72 if kind==12 else 64
            if size!=count*stride or not count or count>4096:raise ValueError('Invalid diagnostic block')
            names=['ticks','room','stage','stage_type','room_type','width','height','grid_slots','grids','entities','enemies','tears','projectiles','effects','pickups','valid','reserved'] if kind==12 else ['ticks','calls','samples','wrapper_ticks','observer_ticks','auxiliary_dropped','context_failures','errors_omitted']
            for p in range(0,size,stride):
                record=dict(zip(names,struct.unpack_from('<QiiiiIIIIIIIIIIII' if kind==12 else '<QQQQQQQQ',payload,p)));record['time_ns']=record.pop('ticks')*1e9/frequency
                (context if kind==12 else overhead).append(record)
        elif kind==14:
            if count!=1 or not 32<=size<=20600:raise ValueError('Invalid Lua error block')
            ticks,metric,thread,span=struct.unpack_from('<QIIQ',payload);cursor=24;strings=[]
            for _ in range(2):
                n=struct.unpack_from('<I',payload,cursor)[0];cursor+=4
                if n>16384 or cursor+n>size:raise ValueError('Invalid Lua error string')
                strings.append(payload[cursor:cursor+n].decode('utf-8',errors='replace'));cursor+=n
            if cursor!=size:raise ValueError('Trailing Lua error bytes')
            errors.append(dict(time_ns=ticks*1e9/frequency,metric=metric,thread=thread,span=span,message=strings[0],stack=strings[1]))
        elif kind==16:
            if size!=count*80 or not 1<=count<=2048:raise ValueError('Invalid presentation block')
            for p in range(0,size,80):
                start,length,ident,swap_start,swap,readback_start,readback,cycles,swap_cycles,thread,flags=struct.unpack_from('<QQQQQQQQQII',payload,p)
                if not ident or not thread or not length or flags>7 or start<minimum or start+length>maximum or readback_start<start or readback_start+readback>swap_start or swap_start+swap>start+length or (flags&3)==3 and swap_cycles>cycles:raise ValueError('Invalid presentation timing')
                presentation.append(dict(id=ident,thread=thread,start_ns=start*1e9/frequency,duration_ns=length*1e9/frequency,
                    swap_start_ns=swap_start*1e9/frequency,swap_ns=swap*1e9/frequency,readback_start_ns=readback_start*1e9/frequency,readback_ns=readback*1e9/frequency,
                    cycles=cycles if flags&1 else None,swap_cycles=swap_cycles if flags&2 else None,success=bool(flags&4)))
        elif kind==17:
            if size!=count*40 or not 1<=count<=4096:raise ValueError('Invalid native wait block')
            for p in range(0,size,40):
                start,length,caller,requested,thread,api,result=struct.unpack_from('<QQQIIII',payload,p)
                if not length or not thread or not 1<=api<=6 or start<minimum or start+length>maximum:raise ValueError('Invalid native wait span')
                waits.append(dict(start_ns=start*1e9/frequency,duration_ns=length*1e9/frequency,caller=hex(caller),requested_ms=requested,thread=thread,kind=api,result=result))
        elif kind==18:
            if count!=1 or not 60<=size<=3200:raise ValueError('Invalid render state block')
            values=struct.unpack_from('<QIIIiiiiiII',payload)
            if not values[1] or values[-2]>3 or values[-1]>63:raise ValueError('Invalid render state flags')
            cursor=48;strings=[]
            for _ in range(3):
                if cursor+4>size:raise ValueError('Truncated GL string')
                n=struct.unpack_from('<I',payload,cursor)[0];cursor+=4
                if n>1024 or cursor+n>size:raise ValueError('Invalid GL string')
                strings.append(payload[cursor:cursor+n].decode('utf-8',errors='replace'));cursor+=n
            if cursor!=size:raise ValueError('Trailing render state bytes')
            render_states.append(dict(time_ns=values[0]*1e9/frequency,thread=values[1],width=values[2],height=values[3],viewport=list(values[4:8]),swap_interval=values[8] if values[9]&2 else None,wait_hooks=values[10],vendor=strings[0],renderer=strings[1],version=strings[2]))
        elif kind==19:
            if count!=1 or not 20<=size<=32788:raise ValueError('Invalid native module block')
            base,image_size,n=struct.unpack_from('<QQI',payload)
            if not base or not image_size or base+image_size>2**32 or n>32768 or size!=20+n:raise ValueError('Invalid native module payload')
        elif kind==15:
            cursor=0
            def number():
                nonlocal cursor
                if cursor+4>size:raise ValueError('Truncated capture configuration')
                value=struct.unpack_from('<I',payload,cursor)[0];cursor+=4;return value
            def names():
                nonlocal cursor
                count=number()
                if count>128:raise ValueError('Invalid scope count')
                result=[]
                for _ in range(count):
                    n=number()
                    if not 0<n<=4095 or cursor+n>size:raise ValueError('Invalid scope name')
                    result.append(payload[cursor:cursor+n].decode('utf8'));cursor+=n
                return result
            configuration=dict(zip(['version','channels','startOn','stopOn','startDelayMs','stopDelayMs'],[number() for _ in range(6)]))
            if configuration['version'] not in (1,2):raise ValueError('Unsupported capture configuration version')
            configuration['maxDurationMs']=number() if configuration['version']==2 else 0
            configuration.update(selectedMods=names(),selectedHooks=names())
            if configuration['channels']>8191 or configuration['startOn']>10 or not 1<=configuration['stopOn']<=12 or max(configuration['startDelayMs'],configuration['stopDelayMs'],configuration['maxDurationMs'])>3600000 or cursor!=size:raise ValueError('Invalid capture configuration')
        elif kind==11:
            cursor=4
            def string():
                nonlocal cursor
                if cursor+4>size:raise ValueError('Truncated inventory')
                n=struct.unpack_from('<I',payload,cursor)[0];cursor+=4
                if n>1048576 or cursor+n>size:raise ValueError('Invalid inventory string')
                text=payload[cursor:cursor+n].decode('utf-8');cursor+=n;return text
            interval=struct.unpack_from('<I',payload)[0];game,title,lua=string(),string(),string();n=struct.unpack_from('<I',payload,cursor)[0];cursor+=4
            if interval!=250 or n>300:raise ValueError('Invalid inventory')
            sources=[]
            for _ in range(n):
                row=dict(zip(['mod','source','path','sha256'],[string() for _ in range(4)]));row['status']=struct.unpack_from('<I',payload,cursor)[0];cursor+=4;sources.append(row)
            if cursor!=size:raise ValueError('Trailing inventory bytes')
            inventory.append(dict(interval_ms=interval,game_version=game,window_title=title,lua_module=lua,sources=sources))
    if metadata is None: raise ValueError('No recoverable metadata')
    if configuration is not None:metadata['configuration']=configuration
    metadata['telemetry']=dict(counters=counters,heap=heap,markers=markers,inventory=inventory,context=context,overhead=overhead,errors=errors)
    metadata['binary_version']=3;metadata['complete']=metadata['complete'] and finalized
    metadata['frame_intervals']=intervals
    metadata['presentation']=presentation
    metadata['native_waits']=waits;metadata['render_states']=render_states
    events.sort(key=lambda e:(e[1],e[4]));metadata['timeline']['events']=events;metadata['screenshots']['images']=shots
    metadata['duration_ns']=max(metadata['duration_ns'],max((e[1]+e[2] for e in events),default=0))
    return metadata

def decode(data):
    if len(data)>=12 and data[:8]==b'ISAACPRF' and struct.unpack_from('<I',data,8)[0]==3:
        return decode_stream(data)
    view = memoryview(data)
    offset = 0
    def get(fmt):
        nonlocal offset
        size = struct.calcsize('<'+fmt)
        if offset+size > len(view):
            raise ValueError('Truncated capture')
        value = struct.unpack_from('<'+fmt, view, offset)
        offset += size
        return value[0] if len(value)==1 else value
    def string():
        nonlocal offset
        size=get('I')
        if size>1048576 or offset+size>len(view):
            raise ValueError('Invalid capture string')
        value=bytes(view[offset:offset+size]).decode('utf-8', errors='replace')
        offset+=size
        return value
    if get('8s')!=b'ISAACPRF':
        raise ValueError('Unsupported binary capture format')
    binary_version=get('I')
    if binary_version not in (1,2): raise ValueError('Unsupported binary capture version')
    flags,pid,lua=get('III')
    duration,frequency=get('dQ')
    registered,metric_count,event_count,capacity=get('IIII')
    if metric_count>100000 or event_count>2000000:
        raise ValueError('Invalid capture counts')
    dropped,skipped,entries,overflow,filtered=get('QQQQQ')
    minimum=get('d')
    version,exe,lua_path=string(),string(),string()
    metrics=[]
    for _ in range(metric_count):
        ident,line,calls,errors,inclusive,exclusive,mean,maximum=get('IiQQdddd')
        mod,callback_id,callback_name,source,function=[string() for _ in range(5)]
        metrics.append(dict(id=ident,line=line,calls=calls,errors=errors,inclusive_ns=inclusive,exclusive_ns=exclusive,
                            mean_ns=mean,max_ns=maximum,mod=mod,callback_id=callback_id,callback_name=callback_name,source=source,function=function))
    if offset+event_count*36>len(view):
        raise ValueError('Invalid capture event block size')
    events=[]
    for _ in range(event_count):
        ident,depth,error,thread,start,length,exclusive=get('IHHIddd')
        events.append([ident,start,length,exclusive,depth,thread,error])
    screenshots=[]
    interval=omitted=overhead=0
    if binary_version==2:
        shot_count,interval,omitted,overhead=get('IIIQ')
        if shot_count>240: raise ValueError('Invalid screenshot count')
        for _ in range(shot_count):
            time,width,height,encoding,size=get('dHHII')
            if not 0<=time<=duration or not 0<width<=320 or not 0<height<=240 or encoding!=1 or not 8<=size<=1048576 or offset+size>len(view):
                raise ValueError('Invalid screenshot record')
            png=bytes(view[offset:offset+size]);offset+=size
            if not png.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('Invalid screenshot PNG')
            screenshots.append(dict(time_ns=time,width=width,height=height,png=png))
    if offset!=len(view): raise ValueError('Trailing capture bytes')
    return dict(format='isaacprof',schema_version=1,profiler_version=version,pid=pid,architecture='x86',lua_version=lua,
                exe=exe,lua=lua_path,duration_ns=duration,qpc_frequency=frequency,registered_metrics=registered,
                dropped_calls=dropped,skipped_coroutine_calls=skipped,host_lua_entries=entries,complete=bool(flags&1),
                mode='native-callback-wall-time',metrics=metrics,binary_version=binary_version,
                screenshots=dict(interval_ms=interval,omitted=omitted,overhead_ns=overhead,images=screenshots),
                timeline=dict(version=1,enabled=bool(flags&2),capacity=capacity,dropped_events=overflow,filtered_events=filtered,
                              minimum_duration_ns=minimum,columns=['metric_id','start_ns','duration_ns','exclusive_ns','depth','thread_id','error'],events=events))

def read_capture(path):
    return decode(pathlib.Path(path).read_bytes())
