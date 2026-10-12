import { useEffect, useMemo, useRef, useState } from 'react';
import { matchSources, sourceCache } from './source-files.ts';
import type { SourceFolder } from './source-files.ts';
import type {
  Metric,
  WorkerClient,
  WorkerOperations,
  LoadedTrace,
  CaptureInventory,
} from './types.ts';
import './source.css';
type Preview = WorkerOperations['source']['result'];
export default function SourceContext({
  metric,
  request,
  capture,
}: {
  metric?: Metric;
  request: WorkerClient['request'];
  capture?: LoadedTrace;
}) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<SourceFolder | null>(null),
    [status, setStatus] = useState(''),
    [choice, setChoice] = useState(''),
    [preview, setPreview] = useState<{ path: string; line: number; data: Preview } | null>(null),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  const [inventory, setInventory] = useState<{
    capture: LoadedTrace;
    data: CaptureInventory | null;
  } | null>(null);
  useEffect(() => {
    if (!capture || !open) return;
    let active = true;
    void request('inventory', null)
      .then((data) => {
        if (active) setInventory({ capture, data });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [capture, open, request]);
  useEffect(() => {
    let active = true;
    void sourceCache()
      .then((saved) => {
        if (active && !generation.current && saved) {
          setFolder(saved);
          setStatus('Restored local Lua snapshot; select again after changing mods.');
        }
      })
      .catch(() => {
        if (active) setStatus('Source cache unavailable; select a folder for this session.');
      });
    return () => {
      active = false;
    };
  }, []);
  const matches = useMemo(
    () => (metric && folder ? matchSources(metric.source, folder.files) : []),
    [metric, folder],
  );
  const file = matches.length === 1 ? matches[0] : matches.find((f) => f.path === choice);
  useEffect(() => {
    if (!open || !file || !metric) return;
    let active = true;
    void request('source', { file: file.file, line: metric.line })
      .then((data) => {
        if (active) {
          setPreview({ path: file.path, line: metric.line, data });
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : 'Cannot read source');
          setPreview(null);
        }
      });
    return () => {
      active = false;
    };
  }, [open, file, metric, request]);
  function select(files: File[]) {
    if (!files.length) return;
    generation.current++;
    const lua = files
        .filter((f) => f.name.toLowerCase().endsWith('.lua'))
        .map((file) => ({ path: file.webkitRelativePath || file.name, file })),
      name = files[0].webkitRelativePath.split('/')[0] || 'Sources',
      next = { name, files: lua };
    setFolder(next);
    setChoice('');
    setError('');
    const bytes = lua.reduce((sum, f) => sum + f.file.size, 0);
    setStatus(`${lua.length.toLocaleString()} Lua files · local snapshot`);
    if (bytes <= 64 * 1024 * 1024)
      void sourceCache(next).catch(() =>
        setStatus('Connected for this session; could not remember sources in local storage.'),
      );
    else {
      setStatus('Connected for this session; Lua sources exceed the 64 MiB cache limit.');
      void sourceCache(null).catch(() => undefined);
    }
  }
  const shown =
    preview && file && preview.path === file.path && preview.line === metric?.line
      ? preview.data
      : null;
  const identity =
    inventory?.capture === capture
      ? inventory?.data?.sources.find((s) => s.mod === metric?.mod && s.source === metric.source)
      : undefined;
  return (
    <details
      className="source-context"
      aria-label="Lua source context"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary id="source-context-toggle">
        Source context{' '}
        <span className="quiet">{folder ? folder.name : 'connect mods repository / folder'}</span>
      </summary>
      <div className="source-header">
        <span className="toolbar-fill" />
        <button
          className="small-button"
          id="connect-sources"
          onClick={() => {
            if (input.current) {
              input.current.value = '';
              input.current.click();
            }
          }}
        >
          {folder ? 'Change source folder' : 'Connect mods / Isaac folder'}
        </button>
        {folder && (
          <button
            className="small-button"
            onClick={() => {
              generation.current++;
              setFolder(null);
              setPreview(null);
              void sourceCache(null).catch(() => setStatus('Could not clear source cache.'));
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      <input
        id="source-folder-input"
        ref={input}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => select(Array.from(e.target.files ?? []))}
      />
      {folder && (
        <div className="source-note">
          {folder.name} · {status}
        </div>
      )}
      {!metric ? (
        <div className="source-note">
          Connect the mods repository / folder, then select a callback to preview its code.
        </div>
      ) : !folder ? (
        <div className="source-note">
          Connect the mods repository, mods folder, or a single mod to show the actual Lua fragment
          here. Files are read locally.
        </div>
      ) : !matches.length ? (
        <div className="source-note">
          No matching Lua file for {metric.source}. Choose a folder containing this mod. Dynamic Lua
          strings have no file context.
        </div>
      ) : (
        <>
          {matches.length > 1 && (
            <label className="source-choice">
              Several files match — choose explicitly{' '}
              <select
                aria-label="Choose source file"
                value={matches.some((f) => f.path === choice) ? choice : ''}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">Select source…</option>
                {matches.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          {file && (
            <div className="source-note source-path" title={`${file.path}:${metric.line}`}>
              {file.path}:{metric.line} · function definition; local code may have changed since
              recording
            </div>
          )}
          {file && (
            <div className="source-note" title={identity?.sha256}>
              Source identity:{' '}
              {!identity?.sha256
                ? 'no recorded hash'
                : !shown?.sha256
                  ? 'checking local SHA-256…'
                  : shown.sha256 === identity.sha256
                    ? 'matches recorded disk snapshot'
                    : 'CHANGED since recorded disk snapshot — definition lines may have moved'}
              . Hashes describe files on disk, not loaded bytecode.
            </div>
          )}
          {error && (
            <div className="source-note" role="alert">
              {error}
            </div>
          )}
          {file && (
            <div
              className="source-code"
              tabIndex={0}
              aria-label="Source code with line numbers"
              aria-busy={!shown && !error}
            >
              {shown ? (
                <>
                  {shown.lines.map((line, i) => (
                    <div
                      className={
                        shown.start + i === metric.line ? 'source-line definition' : 'source-line'
                      }
                      key={shown.start + i}
                    >
                      <span className="line-number">{shown.start + i}</span>
                      <code>{line || ' '}</code>
                    </div>
                  ))}
                  {(metric.line < 1 || metric.line > shown.total) && (
                    <div className="source-note">Recorded line is outside this file.</div>
                  )}
                </>
              ) : (
                <div className="source-note source-loading" role="status">
                  {error || 'Reading source fragment…'}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </details>
  );
}
