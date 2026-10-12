import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  origin = 'http://127.0.0.1:8765';
let vite: ViteDevServer | undefined,
  python: ChildProcess | undefined,
  closing = false,
  owned = false;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function json(
  route: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(origin + route, {
    signal: AbortSignal.timeout(30000),
    ...(body
      ? {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) throw Error(`Controller HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw Error('Invalid controller response');
  return result as Record<string, unknown>;
}
async function shutdown(stopRecording: boolean) {
  const session = await json('/api/session');
  await json('/api/control', { token: session.token, command: 'shutdown', stopRecording });
}
async function close(code = 0) {
  if (closing) return;
  closing = true;
  try {
    if (owned) await shutdown(true);
  } catch (error) {
    console.error(`Controller shutdown: ${message(error)}. Parent monitor will finish cleanup.`);
  } finally {
    await vite?.close();
    process.exit(code);
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void close());
try {
  vite = await createServer({ root: path.join(root, 'viewer') });
  await vite.listen();
  let health: Record<string, unknown> | null = null;
  try {
    health = await json('/api/health');
  } catch {
    /* No existing controller. */
  }
  if (health) {
    if (
      health.app !== 'isaacprof' ||
      typeof health.root !== 'string' ||
      path.resolve(health.root).toLowerCase() !== root.toLowerCase()
    )
      throw Error('Port 8765 belongs to another app.');
    if (health.parent_pid) throw Error('Another managed dev session owns the controller.');
    await shutdown(false);
    for (let i = 0; i < 50; i++) {
      try {
        await json('/api/health');
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        break;
      }
    }
  }
  python = spawn(
    process.env.PYTHON || 'python',
    [
      path.join(root, 'tools/viewer-server.py'),
      '--port',
      '8765',
      '--parent-pid',
      String(process.pid),
    ],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  python.on('error', (error) => {
    console.error(error.message);
    void close(1);
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (closing) break;
    try {
      const next = await json('/api/health');
      if (next.parent_pid === process.pid) {
        ready = true;
        owned = true;
        break;
      }
    } catch {
      /* Wait for the child to bind its listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw Error('Python controller did not start.');
  vite.printUrls();
  console.log(
    `Vite PID ${process.pid} owns Python PID ${python.pid}. Ctrl+C stops recording, flushes capture and closes both.`,
  );
  python.once('exit', () => {
    owned = false;
    console.log(
      'Local controller closed. Analysis remains available; restart pnpm dev to reconnect.',
    );
  });
} catch (error) {
  console.error(message(error));
  await close(1);
}
