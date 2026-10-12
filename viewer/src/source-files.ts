export interface SourceFile {
  path: string;
  file: File;
}
export interface SourceFolder {
  name: string;
  files: SourceFile[];
}
const normalize = (path: string) =>
  path
    .replace(/^@/, '')
    .replaceAll('\\', '/')
    .toLowerCase()
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
export function matchSources<T extends { path: string }>(source: string, files: T[]): T[] {
  if (!source.startsWith('@')) return [];
  const wanted = normalize(source);
  if (wanted.split('/').includes('..') || !wanted) return [];
  // Prefer a full suffix match. Basename-only matching could open another mod's main.lua.
  let best = 0,
    result: T[] = [];
  const a = wanted.split('/'),
    minimum = Math.min(2, a.length);
  for (const candidate of files) {
    const path = normalize(candidate.path),
      b = path.split('/');
    let score = 0;
    while (
      score < Math.min(a.length, b.length) &&
      a[a.length - 1 - score] === b[b.length - 1 - score]
    )
      score++;
    if (score < minimum) continue;
    if (score > best) {
      best = score;
      result = [candidate];
    } else if (score === best) result.push(candidate);
  }
  return result;
}
const dbName = 'isaacprof-sources';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? Error('Source cache unavailable'));
    request.onblocked = () => reject(Error('Source cache blocked'));
  });
}
export async function sourceCache(value?: SourceFolder | null): Promise<SourceFolder | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', value === undefined ? 'readonly' : 'readwrite'),
      store = tx.objectStore('folders');
    let result: SourceFolder | null = null;
    if (value === undefined) {
      const request = store.get('selected');
      request.onsuccess = () => {
        const saved: unknown = request.result;
        if (
          saved &&
          typeof saved === 'object' &&
          'name' in saved &&
          typeof saved.name === 'string' &&
          'files' in saved &&
          Array.isArray(saved.files) &&
          saved.files.every(
            (f: unknown) =>
              !!f &&
              typeof f === 'object' &&
              'path' in f &&
              typeof f.path === 'string' &&
              'file' in f &&
              f.file instanceof File,
          )
        )
          result = saved as SourceFolder;
      };
    } else if (value === null) store.delete('selected');
    else store.put(value, 'selected');
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? Error('Cannot cache Lua sources'));
    };
  });
}
