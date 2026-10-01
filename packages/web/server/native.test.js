import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { startWebUiServer } from './native.js';
import { createNativeSettings } from './lib/omo/settings.js';
import { createFoundationFixture } from './lib/omo/session-service.fixtures.js';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from './lib/terminal/terminal-ws-protocol.js';

const run = promisify(execFile);
const resources = [];
async function fixture(options = {}) {
  const native = await createFoundationFixture();
  const dataDir = path.join(native.root, 'app');
  const settings = createNativeSettings({ dataDir });
  const project = await settings.addProject({ path: native.project });
  const uiDirectory = path.join(native.root, 'ui');
  await fs.mkdir(uiDirectory);
  await fs.writeFile(path.join(uiDirectory, 'index.html'), '<!doctype html><title>OmoChamber fixture</title>');
  const f = { native, dataDir, project, settings, server: null };
  resources.push(f);
  f.server = await startWebUiServer({
    port: 0, runtime: native.runtime, service: native.service, settings, dataDir, uiDirectory,
    uiPassword: 'native-password', ...options,
  });
  f.baseUrl = `http://127.0.0.1:${f.server.getPort()}`;
  f.request = (url, method = 'GET', body, headers = {}) => fetch(`${f.baseUrl}${url}`, {
    method, headers: { Origin: f.baseUrl, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return f;
}
afterEach(async () => {
  for (const f of resources.splice(0)) {
    await f.server?.stop();
    const receipt = await f.native.cleanup();
    expect(receipt.serverClosed).toBe(true);
    await expect(fs.access(f.native.root)).rejects.toThrow();
  }
});
async function login(f) {
  const response = await f.request('/auth/session', 'POST', { password: 'native-password' });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function rejection(url, headers) {
  const socket = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Upgrade did not settle')); }, 5_000);
    socket.once('unexpected-response', (_req, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.once('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('Unexpected accepted upgrade')); });
    socket.on('error', () => {});
  });
}
function terminalFrames(socket) {
  const queue = [];
  const waiters = [];
  socket.on('message', (data) => {
    const frame = readTerminalWsControlFrame(data);
    const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(frame); }
    else queue.push(frame);
  });
  return async () => {
    if (queue.length) return queue.shift();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('Terminal event did not arrive'));
      }, 5_000) };
      waiters.push(waiter);
    });
  };
}

describe('native server composition', () => {
  test('serves native handle, login assets, scoped HTTP and native APIs with actual auth and origin gates', async () => {
    const f = await fixture();
    expect(f.server.runtime).toBe('omo');
    expect(f.server.isReady()).toBe(true);
    expect(f.server.httpServer.address().address).toBe('127.0.0.1');
    expect((await f.request('/')).status).toBe(200);
    expect((await f.request('/api/omo/status')).status).toBe(401);
    expect((await f.request('/auth/session')).status).toBe(401);
    expect((await f.request('/auth/session', 'POST', { password: 'wrong' })).status).toBe(401);
    const cookie = await login(f);
    expect((await f.request('/auth/session', 'GET', undefined, { Cookie: cookie })).status).toBe(200);
    const response = await f.request('/api/omo/status', 'GET', undefined, { Cookie: cookie });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.protocolVersion).toBe(1);
    expect(JSON.stringify(status)).not.toContain(f.native.socketPath);
    expect(JSON.stringify(status)).not.toContain('SECRET');
    expect((await f.request('/api/omo/status', 'GET', undefined, { Cookie: cookie, Origin: 'https://evil.test' })).status).toBe(403);
    expect((await f.request('/api/omo/status', 'GET', undefined, { Cookie: cookie, 'X-Forwarded-Host': 'evil.test' })).status).toBe(403);
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${f.baseUrl}/api/omo/status`, { headers: { Cookie: cookie, Host: 'evil.test' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once('error', reject);
    });
    expect(reboundStatus).toBe(403);
    expect((await f.request('/api/omo/settings', 'PATCH', { theme: 'dark' }, { Cookie: cookie, Origin: '' })).status).toBe(403);
    expect((await f.request('/api/omo/settings', 'PATCH', { fontSize: -1 }, { Cookie: cookie })).status).toBe(400);
    const file = path.join(f.native.project, 'qa.txt');
    expect((await f.request(`/api/fs/write?directory=${encodeURIComponent(f.native.project)}`, 'POST', { path: file, content: 'native' }, { Cookie: cookie })).status).toBe(200);
    const read = await f.request(`/api/fs/read?directory=${encodeURIComponent(f.native.project)}&path=${encodeURIComponent(file)}`, 'GET', undefined, { Cookie: cookie });
    expect(await read.text()).toBe('native');
    const snapshot = await f.native.attach();
    expect((await f.request(`/api/omo/projects/${f.project.id}`, 'DELETE', undefined, { Cookie: cookie })).status).toBe(409);
    expect((await f.request(`/api/omo/sessions/${snapshot.sessionKey}/snapshot`, 'GET', undefined, { Cookie: cookie })).status).toBe(200);
    expect((await f.request('/api/session-goal', 'GET', undefined, { Cookie: cookie })).status).toBe(404);
    // Native password auth never creates legacy JWT/passkey persistence.
    expect(await fs.readdir(f.dataDir)).toEqual(['settings.json']);
  });
  test('rejects unauthenticated and foreign-origin terminal upgrades even without a password', async () => {
    const f = await fixture();
    const url = f.baseUrl.replace('http:', 'ws:') + '/api/terminal/ws';
    expect(await rejection(url, { Origin: f.baseUrl })).toBe(401);
    const cookie = await login(f);
    expect(await rejection(url, { Origin: 'https://evil.test', Cookie: cookie })).toBe(403);
    expect(await rejection(url, { Cookie: cookie })).toBe(403);
    const unlocked = await fixture({ uiPassword: '' });
    expect(await rejection(unlocked.baseUrl.replace('http:', 'ws:') + '/api/terminal/ws', { Origin: 'https://evil.test' })).toBe(403);
    expect(await rejection(unlocked.baseUrl.replace('http:', 'ws:') + '/api/unknown/ws', { Origin: unlocked.baseUrl })).toBe(404);
  });
  test('runs a real PTY, authenticates URL tokens, guards workspace use and closes only owned resources', async () => {
    const ownedPids = [];
    const f = await fixture({ localServiceOptions: { terminalOptions: {
      async loadPtyProvider() {
        const pty = await import('node-pty');
        return { backend: 'node-pty', spawn(...args) {
          const child = pty.spawn(...args);
          ownedPids.push(child.pid);
          return child;
        } };
      },
    } } });
    const cookie = await login(f);
    const mint = await f.request('/auth/url-token', 'POST', {}, { Cookie: cookie });
    expect(mint.status).toBe(200);
    const { token } = await mint.json();
    const socket = new WebSocket(`${f.baseUrl.replace('http:', 'ws:')}/api/terminal/ws?oc_url_token=${token}`, { headers: { Origin: f.baseUrl } });
    const nextFrame = terminalFrames(socket);
    await once(socket, 'open');
    expect((await nextFrame()).t).toBe('hello');
    const created = await f.request('/api/terminal/create', 'POST', {
      sessionId: 'owned-pty', cwd: f.native.project, cols: 80, rows: 24, shell: 'sh',
      mode: 'command', command: "printf 'OMO_TERMINAL_OK\\n'",
    }, { Cookie: cookie });
    expect(created.status).toBe(200);
    socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'owned-pty' }));
    let output = '';
    let exited = false;
    while (!output.includes('OMO_TERMINAL_OK') || !exited) {
      const frame = await nextFrame();
      if (frame.t === 'snapshot') { output += frame.history; exited ||= frame.status === 'exited'; }
      if (frame.t === 'output') output += frame.d;
      if (frame.t === 'exit') exited = true;
    }
    const health = await f.request('/health');
    expect(await health.json()).toEqual({ runtime: 'omo', ready: true });
    const live = await f.request('/api/terminal/create', 'POST', {
      sessionId: 'live-owned-pty', cwd: f.native.project, cols: 80, rows: 24, shell: 'sh',
    }, { Cookie: cookie });
    expect((await live.json()).status).toBe('running');
    socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: 'live-owned-pty' }));
    while ((await nextFrame()).t !== 'snapshot') { /* Drain queued command output before the live snapshot. */ }
    const nativeSnapshot = await f.native.attach();
    const port = f.server.getPort();
    const closed = once(socket, 'close');
    const stopping = f.server.stop();
    expect(f.server.stop()).toBe(stopping);
    await stopping;
    await closed;
    expect(f.server.isReady()).toBe(false);
    expect(f.server.httpServer.listening).toBe(false);
    for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    expect(f.native.frames.some((frame) => ['shutdown', 'close_session', 'delete_session'].includes(frame.type))).toBe(false);
    // The retained host is still listening after the GUI disconnects.
    const probe = net.createConnection(f.native.socketPath);
    await once(probe, 'connect');
    probe.destroy();
    expect(nativeSnapshot.durableSessionId).toBe('durable-parent');
  });
  test('cleans failed bind startup and rejects network listeners before constructing a native service', async () => {
    const f = await fixture();
    let closed = 0;
    await expect(startWebUiServer({
      port: f.server.getPort(), dataDir: f.dataDir, settings: f.settings, runtime: f.native.runtime,
      service: { async close() { closed += 1; } },
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(closed).toBe(1);
    await expect(startWebUiServer({ host: '0.0.0.0' })).rejects.toThrow('loopback');
    await expect(startWebUiServer({ port: -1 })).rejects.toThrow('port');
  });
  test('imports native composition and direct CLI without any legacy runtime modules', async () => {
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({resolve(specifier, context, next) {
        if (/@opencode\\/|\\/lib\\/(opencode|session-goal|scheduled-tasks)\\//.test(specifier)) throw new Error('Forbidden legacy import: ' + specifier);
        return next(specifier, context);
      }});
      const native = await import('./server/native.js');
      const cli = await import('./bin/omochamber.js');
      const result = await cli.runNativeCli(['--help','--json']);
      if (typeof native.startWebUiServer !== 'function' || result.exitCode !== 0) process.exitCode = 1;
    `;
    const result = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..') });
    expect(JSON.parse(result.stdout).status).toBe('ok');
  });
});
