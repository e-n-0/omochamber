import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import { test } from 'node:test';
import { reserveBackendPort, waitForChildExit } from '../scripts/native-dev.mjs';

test('native manifest selects only the native shell and staged UI', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.main, './dist-bundle/omo/entry.mjs');
  assert.equal(manifest.build.appId, 'dev.omochamber.desktop');
  assert.deepEqual(manifest.build.files, [
    'dist-bundle/omo/entry.mjs', 'dist-bundle/omo/main.mjs', 'dist-bundle/omo/preload.mjs',
  ]);
  assert.equal(manifest.build.extraResources[0].from, 'dist-bundle/omo/web-dist');
  assert.equal(manifest.build.extraResources.some((resource) => resource.to === 'opencode-cli'), false);
  assert.equal(manifest.build.afterPack, undefined);
  assert.equal(manifest.build.publish, undefined);
  assert.equal(manifest.scripts['native:build'], 'bun run native:bundle');
  assert.equal(manifest.scripts['native:dev'], 'node ./scripts/native-dev.mjs');
});

test('development backend port is loopback ephemeral and released before Electron starts', async () => {
  const port = await reserveBackendPort();
  assert(port > 0 && port < 65536);
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => listener.close(resolve));
});

test('owned child exit is subscribed before signaling and yields its real status', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const exited = waitForChildExit(child);
  child.emit('exit', 0, null);
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('owned child exit deadline is deterministic and does not signal foreign processes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const exited = waitForChildExit(child, 1000);
  const failed = assert.rejects(exited, /shutdown/);
  t.mock.timers.tick(1000);
  await failed;
  assert.equal(child.listenerCount('exit'), 0);
});
