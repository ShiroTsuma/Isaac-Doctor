export type AnalysisHandle=FileSystemFileHandle & {
  queryPermission:(options:{mode:'readwrite'})=>Promise<PermissionState>;
  requestPermission:(options:{mode:'readwrite'})=>Promise<PermissionState>;
};
export async function saveAnalysis(handle:FileSystemFileHandle,original:File,sourceSize:number,appendix:Uint8Array<ArrayBuffer>,signal?:AbortSignal):Promise<File>{
  signal?.throwIfAborted();
  const fresh=await handle.getFile();
  if(fresh.size!==original.size || fresh.lastModified!==original.lastModified)throw Error('Recording changed during analysis. Reopen it before saving derived data.');
  if(sourceSize<72 || sourceSize>fresh.size)throw Error('Invalid analysis write position.');
  signal?.throwIfAborted();
  const writer=await handle.createWritable({keepExistingData:true});
  const abort=()=>{void writer.abort().catch(()=>undefined);};
  signal?.addEventListener('abort',abort,{once:true});
  try{signal?.throwIfAborted();await writer.seek(sourceSize);signal?.throwIfAborted();await writer.write(appendix);signal?.throwIfAborted();await writer.truncate(sourceSize+appendix.byteLength);signal?.throwIfAborted();await writer.close();}
  catch(error){await writer.abort().catch(()=>undefined);throw error;}
  finally{signal?.removeEventListener('abort',abort);}
  return handle.getFile();
}
