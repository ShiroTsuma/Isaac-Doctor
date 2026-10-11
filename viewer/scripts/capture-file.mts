import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {BinarySource} from '../src/stream.ts';

/** Positioned reads reuse one descriptor. No whole-file materialization. */
export class CaptureFile implements BinarySource {
  reads=0;readBytes=0;
  readonly handle:FileHandle;readonly size:number;readonly modified:number;readonly maxReadBytes:number;readonly writable:boolean;
  private constructor(handle:FileHandle,size:number,modified:number,maxReadBytes:number,writable:boolean){this.handle=handle;this.size=size;this.modified=modified;this.maxReadBytes=maxReadBytes;this.writable=writable;}
  static async open(path:string,maxReadBytes=Infinity,writable=false){
    const handle=await open(path,writable?'r+':'r');
    try{const stat=await handle.stat();if(!stat.isFile())throw Error('Capture must be a regular file.');return new CaptureFile(handle,stat.size,stat.mtimeMs,maxReadBytes,writable);}
    catch(error){await handle.close();throw error;}
  }
  slice(start=0,end=this.size){return {arrayBuffer:()=>this.read(start,end)};}
  private async read(start:number,end:number):Promise<ArrayBuffer>{
    if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<start || end>this.size)throw Error('Read outside capture bounds.');
    const size=end-start;if(this.readBytes+size>this.maxReadBytes)throw Error('Read budget exceeded. Narrow the time range or increase --max-read-mib.');
    this.reads++;this.readBytes+=size;
    const bytes=new Uint8Array(size);let offset=0;
    while(offset<size){const result=await this.handle.read(bytes,offset,size-offset,start+offset);if(!result.bytesRead)throw Error('Capture was truncated during analysis.');offset+=result.bytesRead;}
    return bytes.buffer;
  }
  async unchanged(){const stat=await this.handle.stat();if(stat.size!==this.size || stat.mtimeMs!==this.modified)throw Error('Capture changed during analysis. Stop recording and retry with a stable file.');}
  async writeAppendix(sourceSize:number,appendix:Uint8Array){
    if(!this.writable)throw Error('Capture was opened read-only.');
    if(!Number.isSafeInteger(sourceSize) || sourceSize<72 || sourceSize>this.size || this.size-sourceSize>32*1048576+64 || appendix.length>32*1048576+64)throw Error('Invalid analysis write bounds.');
    await this.unchanged();const previous=new Uint8Array(await this.read(sourceSize,this.size));await this.unchanged();
    const write=async(bytes:Uint8Array)=>{let offset=0;while(offset<bytes.length){const {bytesWritten}=await this.handle.write(bytes,offset,bytes.length-offset,sourceSize+offset);if(!bytesWritten)throw Error('Analysis write made no progress.');offset+=bytesWritten;}};
    try{await write(appendix);await this.handle.truncate(sourceSize+appendix.length);await this.handle.sync();}
    catch(error){try{await write(previous);await this.handle.truncate(this.size);await this.handle.sync();}catch{throw Error('Analysis write and rollback failed. Native recording prefix was preserved; reopen to recover it.');}throw error;}
    return sourceSize+appendix.length;
  }
  close(){return this.handle.close();}
}
