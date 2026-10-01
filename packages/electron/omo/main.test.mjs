import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { APP_ORIGIN, IPC_CHANNEL, createNativeDesktop, createUiProtocolHandler, isTrustedSender } from './main.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(overrides = {}) {
  const handlers = new Map();
  const calls = { stops: 0, exits: [], picks: [], opens: [], reveals: [], notifications: [] };
  const app = new EventEmitter();
  app.quit = () => app.emit('before-quit', { preventDefault() {} });
  app.exit = (code) => { calls.exits.push(code); app.emit('will-quit'); };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
    }
    async loadURL(url) {
      this.webContents.mainFrame.url = url;
      if (overrides.loadError) throw overrides.loadError;
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    show() { this.shown = true; }
    focus() {}
  }
  class NativeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(input) { super(); this.input = input; calls.notifications.push(this); }
    show() {
      this.shown = true;
      if (overrides.notificationError) this.emit('failed', {}, overrides.notificationError);
      else if (!overrides.notificationPending) this.emit('show');
    }
    close() { this.emit('close'); }
  }
  const protocol = { handle() {}, unhandle() {} };
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    session: { defaultSession: { protocol, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    dialog: { async showOpenDialog(_window, input) {
      calls.picks.push(input);
      return overrides.pickPromise ? await overrides.pickPromise : overrides.pick ?? { canceled: true, filePaths: [] };
    } },
    shell: {
      async openPath(selected) { calls.opens.push(selected); return overrides.openError ?? ''; },
      showItemInFolder(selected) { calls.reveals.push(selected); },
    },
    Notification: NativeNotification,
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
    net: { fetch: () => Promise.resolve(new Response('')) },
  };
  const server = {
    runtime: 'omo', isReady: () => true, getPort: () => 34567,
    stop: () => { calls.stops++; return overrides.stopPromise ?? Promise.resolve(); },
  };
  const desktop = createNativeDesktop({
    electron,
    startServer: async () => overrides.startPromise ? await overrides.startPromise : server,
    options: { uiUrl: 'http://127.0.0.1:45678/', preloadPath: '/owned/preload.mjs', ...overrides.options },
  });
  const event = () => ({ sender: desktop.getWindow().webContents, senderFrame: desktop.getWindow().webContents.mainFrame });
  return { desktop, event, calls, server, app, handlers };
}

test('only the owned top frame of the exact app can invoke privileged operations', async (t) => {
  const f = fixture();
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const window = f.desktop.getWindow();
  assert.equal(isTrustedSender(f.event(), window, 'http://127.0.0.1:45678/'), true);
  for (const event of [
    { sender: window.webContents, senderFrame: { url: window.webContents.getURL() } },
    { sender: { getURL: () => window.webContents.getURL() }, senderFrame: window.webContents.mainFrame },
    { sender: window.webContents, senderFrame: null },
  ]) {
    assert.equal(isTrustedSender(event, window, 'http://127.0.0.1:45678/'), false);
    await assert.rejects(f.handlers.get(IPC_CHANNEL)(event, 'notify', { title: 'fixture' }), /refused/);
  }
  window.webContents.mainFrame.url = 'http://127.0.0.1:45679/';
  await assert.rejects(f.handlers.get(IPC_CHANNEL)(f.event(), 'selectFolder', {}), /refused/);
  assert.equal(f.calls.picks.length, 0);
  assert.equal(f.calls.notifications.length, 0);
});

test('window disables renderer Node, webviews and foreign navigation', async (t) => {
  const f = fixture();
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const window = f.desktop.getWindow();
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.webviewTag, false);
  assert.deepEqual(window.openHandler({ url: 'https://foreign.invalid' }), { action: 'deny' });
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let prevented = false;
    window.webContents.emit(name, { url: 'https://foreign.invalid/', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test('selected canonical folders grant only their own children, not symlink escapes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-desktop-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selected = path.join(directory, 'selected');
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, 'file.txt'), 'fixture');
  await fs.writeFile(path.join(directory, 'foreign.txt'), 'foreign');
  await fs.symlink(path.join(directory, 'foreign.txt'), path.join(selected, 'link'));
  const f = fixture({ pick: { canceled: false, filePaths: [selected] } });
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const invoke = (command, input) => f.handlers.get(IPC_CHANNEL)(f.event(), command, input);
  await assert.rejects(invoke('openPath', path.join(selected, 'file.txt')), /grant/);
  assert.equal(await invoke('selectFolder', {}), await fs.realpath(selected));
  await invoke('openPath', path.join(selected, 'file.txt'));
  await invoke('revealPath', selected);
  await assert.rejects(invoke('openPath', path.join(selected, 'link')), /grant/);
  assert.deepEqual(f.calls.opens, [await fs.realpath(path.join(selected, 'file.txt'))]);
  assert.deepEqual(f.calls.reveals, [await fs.realpath(selected)]);
});

test('file selection does not grant siblings and cancelled dialogs grant nothing', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-desktop-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'one.txt');
  const sibling = path.join(directory, 'two.txt');
  await fs.writeFile(file, 'one');
  await fs.writeFile(sibling, 'two');
  const f = fixture({ pick: { canceled: false, filePaths: [file] } });
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const invoke = (command, input) => f.handlers.get(IPC_CHANNEL)(f.event(), command, input);
  await invoke('selectFile', {});
  await invoke('revealPath', file);
  await assert.rejects(invoke('openPath', sibling), /grant/);
});

test('native operations parse narrow payloads and reject unknown commands', async (t) => {
  const f = fixture();
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const invoke = (command, input) => f.handlers.get(IPC_CHANNEL)(f.event(), command, input);
  for (const [command, input] of [['selectFolder', { properties: ['openFile'] }], ['notify', { title: '', body: 'x' }],
    ['notify', { title: 'fixture', silent: true }], ['openPath', 'relative'], ['spawn', {}]]) {
    await assert.rejects(invoke(command, input));
  }
  assert.deepEqual(await invoke('notify', { title: 'fixture', body: 'local' }), { supported: true });
  assert.deepEqual(f.calls.notifications[0].input, { title: 'fixture', body: 'local' });
  assert.equal(f.calls.notifications[0].shown, true);
  assert.equal(await invoke('selectFolder', {}), null);
});

test('late picker completion after foreign navigation cannot issue a grant', async (t) => {
  const picking = deferred();
  const f = fixture({ pickPromise: picking.promise });
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const result = f.handlers.get(IPC_CHANNEL)(f.event(), 'selectFolder', {});
  f.desktop.getWindow().webContents.mainFrame.url = 'https://foreign.invalid/';
  picking.resolve({ canceled: false, filePaths: [os.tmpdir()] });
  await assert.rejects(result, /refused/);
});

test('OS notification refusal rejects the caller rather than claiming delivery', async (t) => {
  const f = fixture({ notificationError: 'fixture denied' });
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  await assert.rejects(f.handlers.get(IPC_CHANNEL)(f.event(), 'notify', { title: 'fixture' }), /fixture denied/);
});

test('unconfirmed notification delivery has a deterministic bounded deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ notificationPending: true });
  t.after(() => f.desktop.stop());
  await f.desktop.start();
  const notice = f.handlers.get(IPC_CHANNEL)(f.event(), 'notify', { title: 'fixture' });
  const failed = assert.rejects(notice, /not confirmed/);
  t.mock.timers.tick(10_000);
  await failed;
  assert.equal(f.calls.notifications[0].listenerCount('show'), 0);
});

test('quit waits for the owned server and PTY cleanup once', async () => {
  const cleanup = deferred();
  const f = fixture({ stopPromise: cleanup.promise });
  await f.desktop.start();
  f.app.quit();
  f.app.quit();
  assert.deepEqual(f.calls.exits, []);
  cleanup.resolve();
  await f.desktop.stop();
  await Promise.resolve();
  assert.equal(f.calls.stops, 1);
  assert.deepEqual(f.calls.exits, [0]);
  assert.equal(f.desktop.getWindow().isDestroyed(), true);
  assert.equal(f.handlers.has(IPC_CHANNEL), false);
});

test('quit during startup waits for the handle without opening a window', async () => {
  const startup = deferred();
  const f = fixture({ startPromise: startup.promise });
  const starting = f.desktop.start();
  const stopping = f.desktop.stop();
  assert.equal(f.calls.stops, 0);
  startup.resolve(f.server);
  await Promise.all([starting, stopping]);
  assert.equal(f.calls.stops, 1);
  assert.equal(f.desktop.getWindow(), undefined);
});

test('partial window startup failure releases the server and privileged handler', async () => {
  const f = fixture({ loadError: new Error('fixture load failure') });
  await assert.rejects(f.desktop.start(), /fixture load failure/);
  await f.desktop.stop();
  assert.equal(f.calls.stops, 1);
  assert.equal(f.desktop.getWindow().isDestroyed(), true);
  assert.equal(f.handlers.has(IPC_CHANNEL), false);
});

test('server startup rejection leaves no window or server cleanup target', async () => {
  const f = fixture({ startPromise: Promise.reject(new Error('fixture startup')) });
  await assert.rejects(f.desktop.start(), /fixture startup/);
  await f.desktop.stop();
  assert.equal(f.calls.stops, 0);
  assert.equal(f.desktop.getWindow(), undefined);
});

test('missing staged assets fail within startup and await owned cleanup', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-desktop-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture({ options: { uiUrl: undefined, uiDirectory: path.join(directory, 'missing') } });
  await assert.rejects(f.desktop.start(), { code: 'ENOENT' });
  await f.desktop.stop();
  assert.equal(f.calls.stops, 1);
  assert.equal(f.desktop.getWindow(), undefined);
  assert.equal(f.handlers.has(IPC_CHANNEL), false);
});

test('packaged scheme refuses outside files and preserves API request fidelity', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-desktop-scheme-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ui = path.join(directory, 'ui');
  await fs.mkdir(ui);
  await fs.writeFile(path.join(ui, 'index.html'), '<div>fixture</div>');
  await fs.writeFile(path.join(directory, 'outside.txt'), 'private');
  await fs.symlink(path.join(directory, 'outside.txt'), path.join(ui, 'link'));
  const requests = [];
  const handler = await createUiProtocolHandler({ uiDirectory: ui, apiOrigin: 'http://127.0.0.1:34567',
    fetchFile: () => assert.fail('API traffic is not a file request'),
    fetchHttp: async (url, input) => { requests.push({ url, input }); return new Response('fixture'); } });
  assert.equal((await handler(new Request(`${APP_ORIGIN}/link`))).status, 403);
  assert.equal((await handler(new Request(`${APP_ORIGIN}/missing`))).status, 404);
  assert.equal((await handler(new Request('openchamber-ui://foreign/index.html'))).status, 403);
  await handler(new Request(`${APP_ORIGIN}/api/omo/settings?x=1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', authorization: 'Bearer fixture',
      cookie: 'omo_ui_session_fixture=selected' }, body: '{"theme":"system"}',
  }));
  assert.equal(requests[0].url, 'http://127.0.0.1:34567/api/omo/settings?x=1');
  assert.equal(requests[0].input.method, 'PATCH');
  assert.equal(requests[0].input.headers.get('origin'), APP_ORIGIN);
  assert.equal(requests[0].input.headers.get('authorization'), 'Bearer fixture');
  assert.equal(requests[0].input.headers.get('cookie'), 'omo_ui_session_fixture=selected');
  assert.equal(Buffer.from(requests[0].input.body).toString(), '{"theme":"system"}');
  assert.equal((await handler(new Request(`${APP_ORIGIN}/api/omo/status`, { headers: { origin: 'https://foreign.invalid' } }))).status, 403);
});

test('packaged proxy reads a real loopback backend without requiring browser CORS headers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-desktop-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    if (request.headers.origin !== APP_ORIGIN) { response.writeHead(403); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ authenticated: true, disabled: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const handler = await createUiProtocolHandler({
    uiDirectory: directory, apiOrigin: `http://127.0.0.1:${server.address().port}`,
    fetchFile: () => assert.fail('HTTP proxy must not use Chromium file transport'),
  });
  const response = await handler(new Request(`${APP_ORIGIN}/auth/session`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  assert.deepEqual(await response.json(), { authenticated: true, disabled: true });
});
