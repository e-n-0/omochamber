#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { reserveBackendPort, startNativeVite, waitForChildExit } from '../../packages/electron/scripts/native-dev.mjs';
import { createTerminalWsControlFrame, readTerminalWsControlFrame } from '../../packages/web/server/lib/terminal/terminal-ws-protocol.js';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const execute = promisify(execFile);
const requireElectron = createRequire(path.join(repository, 'packages/electron/package.json'));

export function parseDesktopQaArgs(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    mode: { type: 'string', default: 'hmr' },
    'evidence-dir': { type: 'string' },
    'manual-pickers': { type: 'boolean', default: false },
    'skip-os-capture': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  const mode = z.enum(['hmr', 'bundled']).parse(values.mode);
  return {
    mode, evidenceDir: path.resolve(repository, values['evidence-dir'] ?? `.tmp/omochamber-evidence/product/desktop/${mode}`),
    manualPickers: values['manual-pickers'], skipOsCapture: values['skip-os-capture'], help: values.help,
  };
}

/** Subscribe before the action; exit and timeout cannot masquerade as readiness. */
export function matchingLine(child, stream, expression, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-64 * 1024);
      const match = expression.exec(buffer);
      if (match) finish(null, match);
    };
    const onExit = (code, signal) => finish(new Error(`Electron exited before expected event: ${code ?? signal}`));
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error('Electron event deadline exceeded')), timeoutMs);
    stream.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

class InspectorClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Electron inspector disconnected'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection deadline')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); }, { once: true });
    });
    return new InspectorClient(socket);
  }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector deadline: ${method}`)); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

async function nativeHostPids() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,args='], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => /(?:rpc-entry\.js|host-lifecycle\.js|cli-main\.js|dist\/cli\.js host)/.test(line))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]));
}

async function assertPortClosed(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Owned port ${port} remains open`)); });
    socket.once('error', (error) => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(error); });
  });
}

async function captureOsWindow(pid, destination) {
  if (process.platform !== 'darwin') throw new Error('OS window capture is implemented only for macOS QA');
  const script = `ObjC.import('CoreGraphics');
    if (!$.CGPreflightScreenCaptureAccess()) throw Error('Screen Recording permission denied');
    var windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID));
    var owned = windows.filter(function(w) { return w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0; });
    if (owned.length !== 1) throw Error('Expected one owned OS window');
    JSON.stringify(owned[0]);`;
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10_000 });
  const window = JSON.parse(stdout);
  await execute('/usr/sbin/screencapture', ['-x', '-l', String(window.kCGWindowNumber), destination], { timeout: 10_000 });
  return { pid, windowId: window.kCGWindowNumber, file: destination };
}

async function terminalPid(origin, sessionId) {
  const wsRequire = createRequire(path.join(repository, 'packages/web/package.json'));
  const { default: Socket } = await import(pathToFileURL(wsRequire.resolve('ws')).href);
  const socket = new Socket(`${origin.replace('http:', 'ws:')}/api/terminal/ws`, { headers: { Origin: origin } });
  try {
    return await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('PTY output deadline')), 10_000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      socket.once('error', fail);
      socket.once('open', () => socket.send(createTerminalWsControlFrame({ t: 'attach', v: 3, s: sessionId })));
      socket.on('message', (bytes) => {
        const frame = readTerminalWsControlFrame(bytes);
        if (frame?.t === 'error') return fail(new Error(frame.message));
        output += frame?.history ?? frame?.d ?? '';
        const match = /OMO_DESKTOP_PTY_PID=(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
  } finally { socket.terminate(); }
}

export async function runDesktopQa(argv = process.argv.slice(2)) {
  const options = parseDesktopQaArgs(argv);
  if (options.help) {
    console.log('node scripts/qa/omochamber-electron.mjs --mode hmr|bundled [--manual-pickers] [--skip-os-capture] [--evidence-dir path]');
    return;
  }
  const evidence = { mode: options.mode, status: 'FAIL', startedAt: new Date().toISOString(),
    sourceDigests: {}, checks: {}, blockers: [], captures: [], cleanup: [], resources: {} };
  await fs.mkdir(options.evidenceDir, { recursive: true });
  for (const source of ['packages/electron/omo/entry.mjs', 'packages/electron/omo/main.mjs', 'packages/electron/omo/preload.mjs',
    'packages/electron/scripts/native-dev.mjs', 'packages/electron/scripts/native-bundle.mjs', 'packages/electron/package.json',
    'packages/web/src/omo-runtime.ts', 'scripts/qa/omochamber-electron.mjs']) {
    evidence.sourceDigests[source] = createHash('sha256').update(await fs.readFile(path.join(repository, source))).digest('hex');
  }
  let profile;
  let hmr;
  let child;
  let inspector;
  let apiPort;
  let ptyPid;
  let failure;
  let logs = '';
  const hosts = await nativeHostPids();
  try {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), `omochamber-electron-${options.mode}-`));
    const workspace = path.join(profile, `OMO-QA-${options.mode}`);
    await fs.mkdir(workspace);
    const selectedFile = path.join(workspace, 'OMO-QA-file.txt');
    await fs.writeFile(selectedFile, 'Local Electron QA fixture\n');
    apiPort = options.mode === 'hmr' ? await reserveBackendPort() : 0;
    hmr = options.mode === 'hmr' ? await startNativeVite(apiPort) : null;
    const entry = path.join(repository, 'packages/electron',
      options.mode === 'hmr' ? 'omo/entry.mjs' : 'dist-bundle/omo/entry.mjs');
    evidence.resources = { profile, workspace, uiPort: hmr?.vite.httpServer.address().port ?? null, hostPids: hosts };
    child = spawn(requireElectron('electron'), [entry, '--inspect=127.0.0.1:0'], {
      cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', OMOCHAMBER_DESKTOP_PORT: String(apiPort),
        OMOCHAMBER_UI_URL: hmr?.url ?? '', OMOCHAMBER_DESKTOP_BUNDLED: options.mode === 'bundled' ? '1' : '0',
        OMOCHAMBER_DESKTOP_USER_DATA_DIR: path.join(profile, 'chromium'), OMOCHAMBER_DATA_DIR: path.join(profile, 'data') },
    });
    const ready = matchingLine(child, child.stdout, /\[omochamber\] desktop ready/);
    ready.catch(() => {});
    const inspectorReady = matchingLine(child, child.stderr, /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
    child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16 * 1024); });
    child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-16 * 1024); });
    inspector = await InspectorClient.connect((await inspectorReady)[1]);
    await ready;
    // Inspector eval has no dynamic-import callback. Node's require(ESM) can
    // read this already evaluated, synchronous entry module without re-running it.
    const prefix = `const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(entry)});
      const entry = require(${JSON.stringify(entry)}); const desktop = entry.desktop;
      const win = desktop.getWindow(); const electron = require('electron');`;
    const main = (body) => inspector.evaluate(`(async () => { ${prefix} ${body} })()`);
    const renderer = (body) => main(`return await win.webContents.executeJavaScript(${JSON.stringify(body)});`);
    evidence.checks.ownership = await main(`const server = desktop.getServer(); return {
      pid: process.pid, app: electron.app.getName(), profile: electron.app.getPath('userData'),
      runtime: server.runtime, ready: server.isReady(), port: server.getPort(),
      listening: server.httpServer.listening, httpAddress: server.httpServer.address(),
      ui: win.webContents.getURL(), title: win.getTitle(), visible: win.isVisible(), windowCount: electron.BrowserWindow.getAllWindows().length
    };`);
    const ownership = evidence.checks.ownership;
    assert.equal(ownership.pid, child.pid);
    assert.equal(ownership.app, 'OmoChamber');
    assert.equal(ownership.runtime, 'omo');
    assert.equal(ownership.ready, true);
    assert.equal(ownership.visible, true);
    assert.equal(ownership.listening, true);
    assert.equal(ownership.httpAddress.address, '127.0.0.1');
    apiPort = ownership.port;
    evidence.resources.pid = child.pid;
    evidence.resources.apiPort = apiPort;
    console.log(`OMO_DESKTOP_QA_LOADED mode=${options.mode} pid=${child.pid} port=${apiPort}`);
    evidence.checks.bootstrap = await renderer(`(async () => {
      try { const response = await fetch('/auth/session'); return {status:response.status,body:await response.text(),
        origin:location.origin,bridge:Boolean(window.__OMOCHAMBER_DESKTOP__)}; }
      catch(error) { return {error:error.message,origin:location.origin,body:document.body.innerText.slice(0,2000),
        bridge:Boolean(window.__OMOCHAMBER_DESKTOP__)}; }
    })()`);
    if (evidence.checks.bootstrap.error || evidence.checks.bootstrap.status !== 200) {
      evidence.checks.mainFetch = await main(`const url = 'http://127.0.0.1:'+desktop.getServer().getPort()+'/auth/session';
        const read = async fetcher => {try {const response=await fetcher(url,{headers:{origin:'openchamber-ui://app'}});
          return {status:response.status,body:await response.text()};}catch(error){return {error:error.message};}};
        return {chromium:await read(electron.net.fetch),node:await read(globalThis.fetch)};`);
      throw new Error(`Native bootstrap failed: ${JSON.stringify(evidence.checks.bootstrap)}`);
    }
    evidence.checks.page = await renderer(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(Error('Native UI deadline')); }, 90000);
      const observer = new MutationObserver(check);
      function check() {
        if (!document.querySelector('[data-testid="omo-project-sidebar"]')) return;
        clearTimeout(timer); observer.disconnect();
        resolve({nativeApp:true, bridge:Object.keys(window.__OMOCHAMBER_DESKTOP__ ?? {}),
          node: typeof window.require, status:document.querySelector('[data-testid="omo-native-status"]')?.textContent});
      }
      observer.observe(document, {childList:true, subtree:true}); check();
    })`);
    assert.equal(evidence.checks.page.nativeApp, true);
    assert.equal(evidence.checks.page.node, 'undefined');
    assert.equal(evidence.checks.page.bridge.length, 5);
    if (options.skipOsCapture) evidence.blockers.push('OS screenshot not captured: caller reports Screen Recording permission denied');
    else {
      try { evidence.captures.push(await captureOsWindow(child.pid, path.join(options.evidenceDir, 'native-window.png'))); }
      catch (error) { evidence.blockers.push(`OS screenshot: ${error.message}`); }
    }
    const request = (route, input) => renderer(`(async () => {
      const response = await fetch(${JSON.stringify(route)}, ${JSON.stringify(input)});
      const body = await response.json(); if (!response.ok) throw Error(JSON.stringify(body)); return body;
    })()`);
    const project = await request('/api/omo/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: workspace }),
    });
    evidence.checks.project = { id: project.id, ownWorkspace: true };
    const terminal = await request('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workspace, cols: 80, rows: 24, shell: 'sh', loginShell: false, mode: 'command',
        command: 'printf "OMO_DESKTOP_PTY_PID=%s\\n" "$$"; read marker' }),
    });
    ptyPid = await terminalPid(`http://127.0.0.1:${apiPort}`, terminal.sessionId);
    evidence.resources.ptyPid = ptyPid;
    assert(processAlive(ptyPid));
    evidence.checks.terminal = { sessionId: terminal.sessionId, pid: ptyPid, activeBeforeQuit: true };
    evidence.checks.foreignFrame = await renderer(`new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'); const timer = setTimeout(() => reject(Error('Frame deadline')), 10000);
      frame.onload = () => { clearTimeout(timer); const exposed = Boolean(frame.contentWindow.__OMOCHAMBER_DESKTOP__);
        frame.remove(); resolve({exposed}); };
      frame.src = location.href; document.body.append(frame);
    })`);
    assert.equal(evidence.checks.foreignFrame.exposed, false);
    const probe = path.join(repository, 'packages/electron/omo/qa-probe-preload.mjs');
    evidence.checks.foreignIpc = await main(`const foreign = new electron.BrowserWindow({show:false,
      webPreferences:{preload:${JSON.stringify(probe)},contextIsolation:true,sandbox:false,nodeIntegration:false}});
      try {
        await foreign.loadURL('data:text/html,<html><body>Foreign QA frame</body></html>');
        return await foreign.webContents.executeJavaScript(\`window.__OMO_QA_PROBE__.notify()
          .then(() => ({refused:false}), error => ({refused:true,message:error.message}))\`);
      } finally { foreign.destroy(); }`);
    assert.equal(evidence.checks.foreignIpc.refused, true);
    evidence.checks.navigation = await main(`return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Navigation deadline')), 10000);
      win.webContents.once('will-frame-navigate', event => {
        clearTimeout(timer); resolve({prevented:event.defaultPrevented,url:win.webContents.getURL()});
      });
      void win.webContents.executeJavaScript("location.href='https://foreign.invalid/'");
    });`);
    assert.equal(evidence.checks.navigation.prevented, true);
    await main(`globalThis.__omoQaNotice = new Promise(resolve => {
      const original = electron.Notification.prototype.show;
      electron.Notification.prototype.show = function() {
        electron.Notification.prototype.show = original;
        const timer = setTimeout(() => resolve({event:'deadline'}), 10000);
        this.once('show', () => { clearTimeout(timer); resolve({event:'show'}); });
        this.once('failed', (_event, error) => { clearTimeout(timer); resolve({event:'failed',error}); });
        return original.call(this);
      };
    });`);
    const notificationSupported = await main('return electron.Notification.isSupported();');
    evidence.checks.notification = await renderer(`window.__OMOCHAMBER_DESKTOP__.notify({title:'OmoChamber QA',body:'Local native notification'})
      .then(result => ({...result,delivered:result.supported}), error => ({delivered:false,error:error.message}))`);
    evidence.checks.notification.osEvent = notificationSupported
      ? await inspector.evaluate('globalThis.__omoQaNotice') : { event: 'unsupported' };
    if (evidence.checks.notification.osEvent.event !== 'show') {
      evidence.blockers.push(`Native notification dispatch did not receive OS show: ${evidence.checks.notification.osEvent.event}`);
    }
    if (options.manualPickers) {
      console.log(`OMO_DESKTOP_QA_PICKER folder pid=${child.pid} path=${workspace}`);
      const folder = await renderer(`window.__OMOCHAMBER_DESKTOP__.selectFolder({defaultPath:${JSON.stringify(workspace)}})`);
      assert.equal(folder, await fs.realpath(workspace));
      console.log(`OMO_DESKTOP_QA_PICKER file pid=${child.pid} path=${selectedFile}`);
      const file = await renderer(`window.__OMOCHAMBER_DESKTOP__.selectFile({defaultPath:${JSON.stringify(selectedFile)}})`);
      assert.equal(file, await fs.realpath(selectedFile));
      await renderer(`window.__OMOCHAMBER_DESKTOP__.revealPath(${JSON.stringify(file)})`);
      await renderer(`window.__OMOCHAMBER_DESKTOP__.openPath(${JSON.stringify(folder)})`);
      evidence.checks.pickers = { folderSelected: true, fileSelected: true, fileRevealed: true, folderOpened: true };
      console.log(`OMO_DESKTOP_QA_CLOSE_FINDER folder=${path.basename(workspace)}`);
      // The caller closes only the Finder window created for this fixture.
      evidence.resources.finderWindow = path.basename(workspace);
      await matchingLine(process, process.stdin, /^FINDER_CLOSED\r?$/m);
      evidence.cleanup.push({ resource: 'owned Finder window', confirmedClosed: true });
    } else evidence.blockers.push('Native folder/file picker QA requires --manual-pickers and exact owned OS dialog confirmation');
    const stopped = matchingLine(child, child.stdout, /OMO_DESKTOP_QA_SERVER_STOPPED/);
    await main(`const server = desktop.getServer(); const stop = server.stop.bind(server);
      server.stop = async () => { await stop(); console.log('OMO_DESKTOP_QA_SERVER_STOPPED'); };
      setImmediate(() => electron.app.quit()); return true;`);
    inspector.close();
    inspector = null;
    await stopped;
    const exited = await waitForChildExit(child);
    assert.equal(exited.code, 0);
    evidence.checks.quit = { exitCode: exited.code, ownedServerStopAwaited: true };
    await assertPortClosed(apiPort);
    assert.equal(processAlive(ptyPid), false);
    evidence.checks.terminal.stoppedAfterQuit = true;
    evidence.cleanup.push({ resource: 'Electron/backend/PTY', pid: child.pid, port: apiPort, ptyPid, cleaned: true });
    evidence.checks.nativeHosts = { before: hosts, retained: hosts.filter(processAlive) };
    assert.deepEqual(evidence.checks.nativeHosts.retained, hosts);
    evidence.status = evidence.blockers.length ? 'BLOCKED' : 'PASS';
  } catch (error) { failure = error; evidence.error = error.message; }
  finally {
    inspector?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { const exiting = waitForChildExit(child); child.kill('SIGTERM'); await exiting; }
      catch (error) {
        evidence.cleanup.push({ resource: 'Electron', error: error.message, forced: true });
        child.kill('SIGKILL');
        await waitForChildExit(child, 5000);
      }
    }
    if (apiPort) {
      try { await assertPortClosed(apiPort); evidence.cleanup.push({ resource: 'backend port', port: apiPort, closed: true }); }
      catch (error) { evidence.cleanup.push({ resource: 'backend port', error: error.message }); failure ??= error; }
    }
    if (hmr) {
      const port = evidence.resources.uiPort;
      await hmr.vite.close();
      await assertPortClosed(port);
      evidence.cleanup.push({ resource: 'Vite', port, cleaned: true });
    }
    if (profile) {
      await fs.rm(profile, { recursive: true, force: true });
      evidence.cleanup.push({ resource: 'profile/workspace/data', cleaned: true });
    }
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(options.evidenceDir, 'electron.log'), logs);
    await fs.writeFile(path.join(options.evidenceDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (failure) throw failure;
  console.log(`OMO_DESKTOP_QA_RESULT ${evidence.status} mode=${options.mode} report=${path.join(options.evidenceDir, 'report.json')}`);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDesktopQa().then((report) => { if (report?.status === 'BLOCKED') process.exitCode = 2; },
    (error) => { console.error('[omochamber] Electron QA failed:', error); process.exitCode = 1; });
}
