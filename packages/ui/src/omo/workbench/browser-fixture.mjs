// Owned, no-provider QA. This does not change the application entrypoint.
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { startWebUiServer } from '../../../../web/server/native.js';
import { createNativeSettings } from '../../../../web/server/lib/omo/settings.js';
import { createFoundationFixture } from '../../../../web/server/lib/omo/session-service.fixtures.js';

const scope = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const native = await createFoundationFixture();
const dataDir = path.join(native.root, 'app');
const uiDirectory = path.join(native.root, 'ui');
const profile = path.join(native.root, 'browser-profile');
let server;
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await server?.stop();
    const receipt = await native.cleanup();
    assert(receipt.serverClosed);
    await assert.rejects(access(native.root));
    console.log('CLEANUP', JSON.stringify({ ...receipt, fixtureRootRemoved: true, profileRemoved: true }));
  })();
  return stopping;
}
try {
  await mkdir(profile);
  await writeFile(path.join(native.project, 'qa.txt'), 'native workbench bytes\n');
  const second = path.join(native.root, 'second-project');
  await mkdir(second);
  await writeFile(path.join(second, 'qa.txt'), 'second directory bytes\n');
  const settings = createNativeSettings({ dataDir });
  await settings.addProject({ path: native.project, name: 'QA' });
  await settings.addProject({ path: second, name: 'QA second' });
  await settings.update({ theme: 'flexoki-dark' });
  await build({
    configFile: false, root: scope, cacheDir: path.join(native.root, 'vite-cache'),
    publicDir: path.join(repository, 'packages/web/public'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(repository, 'packages/ui/src') } },
    css: { postcss: repository },
    define: { global: 'globalThis', 'process.env': '{}', __APP_VERSION__: JSON.stringify('workbench-fixture') },
    build: { outDir: uiDirectory, emptyOutDir: true, rollupOptions: { input: path.join(scope, 'workbench.fixture.html') } },
    worker: { format: 'es' },
  });
  server = await startWebUiServer({ port: 0, runtime: native.runtime, service: native.service, settings, dataDir, uiDirectory, uiPassword: '' });
  console.log('READY', JSON.stringify({
    url: `http://127.0.0.1:${server.getPort()}/workbench.fixture.html`,
    profile, project: native.project, second, root: native.root,
  }));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (input) => { if (input.includes('stop')) void stop().then(() => process.exit(0)); });
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
} catch (error) {
  await stop();
  throw error;
}
