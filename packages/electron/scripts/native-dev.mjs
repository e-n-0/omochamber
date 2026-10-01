#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const requireElectron = createRequire(new URL('../package.json', import.meta.url));

export async function reserveBackendPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function startNativeVite(apiPort) {
  process.env.OMOCHAMBER_API_URL = `http://127.0.0.1:${apiPort}`;
  const webRequire = createRequire(path.join(repository, 'packages/web/package.json'));
  const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
  const uiPort = await reserveBackendPort();
  const vite = await createServer({
    root: path.join(repository, 'packages/web'),
    configFile: path.join(repository, 'packages/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: uiPort, strictPort: true },
  });
  try { await vite.listen(); }
  catch (error) { await vite.close(); throw error; }
  return { vite, url: `http://127.0.0.1:${vite.httpServer.address().port}/` };
}

export function waitForChildExit(child, timeoutMs = 35_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => { clearTimeout(timer); resolve({ code, signal }); };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Owned Electron process did not finish shutdown'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function runNativeDev(argv = process.argv.slice(2)) {
  if (argv.some((value) => value !== '--bundled')) throw new Error('Use native:dev or native:dev:bundled');
  const bundled = argv.includes('--bundled');
  const electronBinary = requireElectron('electron');
  const apiPort = bundled ? 0 : await reserveBackendPort();
  const hmr = bundled ? null : await startNativeVite(apiPort);
  let child;
  const shutdown = () => child?.kill('SIGTERM');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const entry = path.join(repository, 'packages/electron', bundled ? 'dist-bundle/omo/entry.mjs' : 'omo/entry.mjs');
    child = spawn(electronBinary, [entry], {
      cwd: repository, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', OMOCHAMBER_DESKTOP_PORT: String(apiPort),
        OMOCHAMBER_UI_URL: hmr?.url ?? '', OMOCHAMBER_DESKTOP_BUNDLED: bundled ? '1' : '0' },
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) throw new Error(`Electron exited ${result.code ?? result.signal}`);
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = waitForChildExit(child);
        child.kill('SIGTERM');
        try { await exited; }
        catch (error) { child.kill('SIGKILL'); await waitForChildExit(child, 5000); throw error; }
      }
    } finally { await hmr?.vite.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runNativeDev().catch((error) => { console.error('[omochamber] native dev failed:', error); process.exitCode = 1; });
}
