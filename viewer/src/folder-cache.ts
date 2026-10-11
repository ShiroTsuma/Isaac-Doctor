/** A local binary snapshot, not a persistent permission to scan the source folder. */
export interface FolderRecording {key:string;file:File}
export interface FolderSnapshot {name:string;recordings:FolderRecording[];selectedKey:string}
const databaseName='isaacprof-local',storeName='folders',snapshotKey='selected';
function openDatabase():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(databaseName,1);
    request.onupgradeneeded=()=>{request.result.createObjectStore(storeName);};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    request.onerror=()=>reject(request.error ?? Error('Cannot open local folder cache'));
    request.onblocked=()=>reject(Error('Folder cache is blocked by another tab'));
  });
}
function isSnapshot(value:unknown):value is FolderSnapshot{
  if(!value || typeof value!=='object' || !('name' in value) || typeof value.name!=='string' || !('selectedKey' in value) || typeof value.selectedKey!=='string' || !('recordings' in value) || !Array.isArray(value.recordings))return false;
  return value.recordings.every((recording:unknown)=>!!recording && typeof recording==='object' && 'key' in recording && typeof recording.key==='string' && 'file' in recording && recording.file instanceof File && recording.file.name.toLowerCase().endsWith('.isaacprof'));
}
export async function restoreFolder():Promise<FolderSnapshot|null>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(storeName,'readonly'),request=transaction.objectStore(storeName).get(snapshotKey);
    let result:FolderSnapshot|null=null;
    request.onsuccess=()=>{const value:unknown=request.result;result=isSnapshot(value)?value:null;};
    transaction.oncomplete=()=>{db.close();resolve(result);};
    transaction.onabort=()=>{db.close();reject(transaction.error ?? Error('Cannot restore folder cache'));};
  });
}
export async function saveFolder(snapshot:FolderSnapshot):Promise<void>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(storeName,'readwrite');
    transaction.objectStore(storeName).put(snapshot,snapshotKey);
    transaction.oncomplete=()=>{db.close();resolve();};
    transaction.onabort=()=>{db.close();reject(transaction.error ?? Error('Cannot remember folder (local storage may be full)'));};
  });
}
export async function rememberSelection(key:string):Promise<void>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(storeName,'readwrite'),store=transaction.objectStore(storeName),request=store.get(snapshotKey);
    request.onsuccess=()=>{const snapshot:unknown=request.result;if(isSnapshot(snapshot) && snapshot.recordings.some(recording=>recording.key===key))store.put({...snapshot,selectedKey:key},snapshotKey);};
    transaction.oncomplete=()=>{db.close();resolve();};
    transaction.onabort=()=>{db.close();reject(transaction.error ?? Error('Cannot remember recording selection'));};
  });
}
export async function forgetFolder():Promise<void>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(storeName,'readwrite');
    transaction.objectStore(storeName).delete(snapshotKey);
    transaction.oncomplete=()=>{db.close();resolve();};
    transaction.onabort=()=>{db.close();reject(transaction.error ?? Error('Cannot forget folder cache'));};
  });
}
