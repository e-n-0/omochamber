import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await fs.readFile(new URL('./preload.mjs', import.meta.url), 'utf8');
function loadPreload(url, mainFrame = true) {
  const globals = {};
  const calls = [];
  vm.runInNewContext(source.replace(/^import .* from 'electron';\n/, ''), {
    URL, location: new URL(url),
    process: { isMainFrame: mainFrame, argv: [
      '--omochamber-ui-url=openchamber-ui://app/index.html', '--omochamber-api-origin=http://127.0.0.1:12345',
    ] },
    contextBridge: { exposeInMainWorld: (name, value) => { globals[name] = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(null); } },
  });
  return { globals, calls };
}

test('trusted preload exposes named native operations without raw IPC or Node', async () => {
  const { globals, calls } = loadPreload('openchamber-ui://app/index.html');
  const bridge = globals.__OMOCHAMBER_DESKTOP__;
  assert.deepEqual(Object.keys(bridge).sort(), ['notify', 'openPath', 'revealPath', 'selectFile', 'selectFolder']);
  assert.equal(globals.__OPENCHAMBER_API_BASE_URL__, 'openchamber-ui://app');
  assert.equal(globals.__OPENCHAMBER_LOCAL_ORIGIN__, 'http://127.0.0.1:12345');
  await bridge.selectFolder({ defaultPath: '/fixture' });
  await bridge.notify({ title: 'fixture' });
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['omochamber:invoke', 'selectFolder'], ['omochamber:invoke', 'notify'],
  ]);
  assert.equal(bridge.invoke, undefined);
});

for (const [url, mainFrame] of [
  ['https://foreign.invalid/', true], ['http://127.0.0.1:12345/', true],
  ['file:///fixture/index.html', true], ['openchamber-ui://foreign/index.html', true],
  ['openchamber-ui://app/assets/preview.html', true], ['openchamber-ui://app/index.html', false],
]) {
  test(`preload exposes no local capability for ${url} mainFrame=${mainFrame}`, () => {
    assert.deepEqual(loadPreload(url, mainFrame).globals, {});
  });
}
