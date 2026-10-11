import {analysisVersion} from './analysis-cache.ts';
export const analysisLimit=32*1024*1024;
const table=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);return c;});
export function crc32(bytes:Uint8Array){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
const decoder=new TextDecoder(),encoder=new TextEncoder();
export interface CacheLocation {sourceSize:number;payloadSize:number;crc:number;version:number}
export function cacheLocation(trailer:ArrayBuffer,size:number):CacheLocation|null{
  if(trailer.byteLength!==32 || decoder.decode(trailer.slice(0,8))!=='IPACEND1')return null;
  const v=new DataView(trailer),sourceSize=Number(v.getBigUint64(8,true)),payloadSize=v.getUint32(16,true),crc=v.getUint32(20,true),version=v.getUint32(24,true);
  if(!Number.isSafeInteger(sourceSize) || sourceSize<72 || payloadSize>analysisLimit || size!==sourceSize+64+payloadSize || v.getUint32(28,true)!==1)return null;
  return {sourceSize,payloadSize,crc,version};
}
export function encodeSection(payload:Uint8Array<ArrayBuffer>,sourceSize:number,indexCRC:number):Uint8Array<ArrayBuffer>{
  if(payload.length>analysisLimit)throw Error('Analysis appendix exceeds 32 MiB.');
  const bytes=new Uint8Array(payload.length+64),v=new DataView(bytes.buffer);bytes.set(encoder.encode('IPAC0001'));v.setUint32(8,1,true);v.setUint32(12,analysisVersion,true);v.setBigUint64(16,BigInt(sourceSize),true);v.setUint32(24,indexCRC,true);v.setUint32(28,payload.length,true);bytes.set(payload,32);
  const p=32+payload.length;bytes.set(encoder.encode('IPACEND1'),p);v.setBigUint64(p+8,BigInt(sourceSize),true);v.setUint32(p+16,payload.length,true);v.setUint32(p+20,crc32(payload),true);v.setUint32(p+24,analysisVersion,true);v.setUint32(p+28,1,true);return bytes;
}
export function sectionPayload(bytes:ArrayBuffer,location:CacheLocation,indexCRC:number):ArrayBuffer|null{
  const v=new DataView(bytes);if(bytes.byteLength!==location.payloadSize+32 || decoder.decode(bytes.slice(0,8))!=='IPAC0001' || v.getUint32(8,true)!==1 || v.getUint32(12,true)!==location.version || ![1,analysisVersion].includes(location.version) || Number(v.getBigUint64(16,true))!==location.sourceSize || v.getUint32(24,true)!==indexCRC || v.getUint32(28,true)!==location.payloadSize)return null;
  const payload=bytes.slice(32);return crc32(new Uint8Array(payload))===location.crc?payload:null;
}
