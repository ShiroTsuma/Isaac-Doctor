import { recordingOrder } from './recording-files.ts';
export type CaptureDirectory = FileSystemDirectoryHandle & {
  queryPermission: (descriptor: {
    mode: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
  requestPermission: (descriptor: {
    mode: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
};
export interface CaptureEntry {
  key: string;
  file: File;
  handle: FileSystemFileHandle;
}
export async function captureEntries(
  directory: CaptureDirectory,
): Promise<CaptureEntry[]> {
  if ((await directory.queryPermission({ mode: 'read' })) !== 'granted') {
    throw Error('Reconnect the captures folder to restore browser permission.');
  }
  const files: CaptureEntry[] = [];

  async function visit(folder: FileSystemDirectoryHandle, prefix: string) {
    for await (const handle of folder.values()) {
      const key = prefix + handle.name;
      if (handle.kind === 'directory') {
        await visit(handle, key + '/');
      } else if (handle.name.toLowerCase().endsWith('.isaacprof')) {
        files.push({ key, file: await handle.getFile(), handle });
      }
    }
  }

  await visit(directory, '');
  return files.sort(recordingOrder);
}
export async function savedCaptureDirectory(
  value?: CaptureDirectory | null,
): Promise<CaptureDirectory | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('isaacprof-handles', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(r.error ?? Error('Cannot open folder handle storage'));
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      'handles',
      value === undefined ? 'readonly' : 'readwrite',
    );
    const store = tx.objectStore('handles');
    let result: CaptureDirectory | null = null;
    if (value === undefined) {
      const r = store.get('captures');
      r.onsuccess = () => {
        const handle: unknown = r.result;
        if (
          handle &&
          typeof handle === 'object' &&
          'kind' in handle &&
          handle.kind === 'directory' &&
          'getFileHandle' in handle &&
          typeof handle.getFileHandle === 'function' &&
          'queryPermission' in handle &&
          typeof handle.queryPermission === 'function'
        ) {
          result = handle as CaptureDirectory;
        }
      };
    } else if (value) {
      store.put(value, 'captures');
    } else {
      store.delete('captures');
    }
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? Error('Cannot remember capture folder'));
    };
  });
}
export function captureFileName(report: string) {
  const name = report.split(/[\\/]/).at(-1) ?? '';
  if (!/^capture-[\w-]+\.isaacprof$/i.test(name)) {
    throw Error('Controller did not return a valid recording filename.');
  }
  return name;
}
export async function completedCapture(
  directory: CaptureDirectory,
  report: string,
) {
  if ((await directory.queryPermission({ mode: 'read' })) !== 'granted') {
    throw Error('Reconnect the captures folder to restore browser permission.');
  }
  try {
    return await (
      await directory.getFileHandle(captureFileName(report))
    ).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw Error(
        `Recording not found in ${directory.name}. Choose the captures folder shown in recording status.`,
        { cause: error },
      );
    }
    throw error;
  }
}
