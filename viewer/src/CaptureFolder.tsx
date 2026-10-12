import { useEffect, useRef, useState } from 'react';
import {
  captureEntries,
  completedCapture,
  savedCaptureDirectory,
} from './capture-folder.ts';
import type { CaptureDirectory, CaptureEntry } from './capture-folder.ts';
import type { RecordingStatus } from './RecordingControls.tsx';
type PickerWindow = Window & {
  showDirectoryPicker?: (options: {
    id: string;
    mode: 'readwrite';
  }) => Promise<CaptureDirectory>;
};
export default function CaptureFolder({
  status,
  open,
  onFiles,
}: {
  status: RecordingStatus | null;
  open: (file: File, handle: FileSystemFileHandle) => Promise<void>;
  onFiles: (name: string, files: CaptureEntry[]) => void;
}) {
  const [directory, setDirectory] = useState<CaptureDirectory | null>(null);
  const [message, setMessage] = useState(
    'Connect captures folder once to open completed recordings automatically.',
  );
  const [busy, setBusy] = useState(false);
  const observed = useRef(false);
  const baseline = useRef('');
  const opened = useRef('');
  const opening = useRef(false);
  const scanning = useRef(false);
  const signature = useRef('');
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentState = status?.state;
  const report = status?.report;
  const updatedAt = status?.updatedAt;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const epoch = generation.current;
    void savedCaptureDirectory()
      .then(async (handle) => {
        if (!active || generation.current !== epoch || !handle) {
          return;
        }
        setDirectory(handle);
        const permission = await handle.queryPermission({ mode: 'read' });
        if (active && generation.current === epoch) {
          setMessage(
            permission === 'granted'
              ? `${handle.name}: automatic local reads enabled`
              : `${handle.name}: reconnect to restore browser permission`,
          );
        }
      })
      .catch(() => {
        if (active) {
          setMessage('Folder handles cannot be remembered in this browser.');
        }
      });
    return () => {
      active = false;
    };
  }, []);
  // Enumerate the live directory without caching capture bytes in IndexedDB.
  useEffect(() => {
    if (
      !directory ||
      scanning.current ||
      currentState === 'recording' ||
      currentState === 'armed' ||
      currentState === 'saving'
    ) {
      return;
    }
    const epoch = generation.current;
    scanning.current = true;
    void captureEntries(directory)
      .then((files) => {
        if (!mounted.current || epoch !== generation.current) {
          return;
        }
        const next = JSON.stringify(
          files.map(({ key, file }) => [key, file.size, file.lastModified]),
        );
        if (next !== signature.current) {
          signature.current = next;
          onFiles(directory.name, files);
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && epoch === generation.current) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Cannot refresh captures folder',
          );
        }
      })
      .finally(() => {
        scanning.current = false;
      });
  }, [directory, currentState, updatedAt, onFiles]);
  useEffect(() => {
    if (currentState === 'recording' || currentState === 'armed') {
      observed.current = true;
      return;
    }
    if (!observed.current) {
      baseline.current = report ?? '';
    }
    // Ready may precede the report filename. Retain the pending session.
    if (
      currentState !== 'ready' ||
      !observed.current ||
      !report ||
      report === baseline.current ||
      report === opened.current ||
      !directory ||
      opening.current
    ) {
      return;
    }
    const epoch = generation.current;
    opening.current = true;
    void completedCapture(directory, report)
      .then(async (file) => {
        if (!mounted.current || epoch !== generation.current) {
          return;
        }
        const handle = await directory.getFileHandle(file.name);
        if (!mounted.current || epoch !== generation.current) {
          return;
        }
        observed.current = false;
        opened.current = report;
        setMessage(`Opening ${file.name} locally\u2026`);
        await open(file, handle);
        if (mounted.current && epoch === generation.current) {
          setMessage(`${directory.name}: automatic local reads enabled`);
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && epoch === generation.current) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Cannot open completed recording',
          );
        }
      })
      .finally(() => {
        opening.current = false;
      });
  }, [currentState, report, directory, open, updatedAt]);

  async function connect(change = false) {
    const epoch = ++generation.current;
    setBusy(true);
    signature.current = '';
    try {
      const picker = window as PickerWindow;
      if (!picker.showDirectoryPicker) {
        throw Error(
          'Persistent folder access requires Chrome or Edge. Use Open folder to read a snapshot.',
        );
      }
      const handle =
        directory && !change
          ? directory
          : await picker.showDirectoryPicker({
              id: 'isaacprof-captures',
              mode: 'readwrite',
            });
      if (
        (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted'
      ) {
        throw Error(
          'Folder permission was not granted. Read/write access lets the viewer persist prepared analysis.',
        );
      }
      setDirectory(handle);
      await savedCaptureDirectory(handle);
      setMessage(`${handle.name}: automatic local reads enabled`);
      const files = await captureEntries(handle);
      if (epoch !== generation.current) {
        return;
      }
      signature.current = JSON.stringify(
        files.map(({ key, file }) => [key, file.size, file.lastModified]),
      );
      onFiles(handle.name, files);
      if (status?.state === 'ready' && status.report && !opening.current) {
        const file = await completedCapture(handle, status.report);
        if (epoch !== generation.current) {
          return;
        }
        observed.current = false;
        opened.current = status.report;
        await open(file, await handle.getFileHandle(file.name));
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage(
          error instanceof Error ? error.message : 'Cannot connect folder',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="capture-folder-controls">
      <button
        id="connect-captures"
        disabled={busy}
        onClick={() => void connect()}
      >
        {directory ? 'Reconnect captures folder' : 'Connect captures folder'}
      </button>
      {directory && (
        <>
          <button disabled={busy} onClick={() => void connect(true)}>
            Change
          </button>
        </>
      )}
      <output id="capture-folder-status" title={message}>
        {message}
      </output>
    </div>
  );
}
