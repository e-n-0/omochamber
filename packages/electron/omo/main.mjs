import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const UI_SCHEME = 'openchamber-ui';
export const APP_ORIGIN = `${UI_SCHEME}://app`;
export const IPC_CHANNEL = 'omochamber:invoke';

const pickerInput = z.object({ defaultPath: z.string().max(4096).optional() }).strict().default({});
const pathInput = z.string().min(1).max(4096).refine(path.isAbsolute);
const notificationInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(4000).default(''),
}).strict();

export function isAppDocument(raw, uiUrl) {
  try {
    const candidate = new URL(raw);
    const trusted = new URL(uiUrl);
    return candidate.protocol === trusted.protocol && candidate.host === trusted.host
      && !candidate.username && !candidate.password
      && ['/', '/index.html'].includes(candidate.pathname);
  } catch { return false; }
}

export function isTrustedSender(event, window, uiUrl) {
  return Boolean(window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isAppDocument(event.senderFrame.url, uiUrl)
    && isAppDocument(event.sender.getURL(), uiUrl));
}

/** Serve only staged UI files; HTTP and SSE use the same native backend. */
export async function createUiProtocolHandler({ uiDirectory, apiOrigin, fetchFile, fetchHttp = globalThis.fetch }) {
  const root = await fs.realpath(uiDirectory);
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== `${UI_SCHEME}:` || url.host !== 'app' || url.username || url.password) {
      return new Response('', { status: 403 });
    }
    if (/^\/(?:api|auth)(?:\/|$)/.test(url.pathname) || url.pathname === '/health') {
      const origin = request.headers.get('origin');
      if (origin && origin !== APP_ORIGIN) return new Response('', { status: 403 });
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.set('origin', APP_ORIGIN);
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
      if (body && body.byteLength > 1024 * 1024) return new Response('', { status: 413 });
      // Chromium net.fetch enforces CORS for the packaged Origin. Node fetch
      // forwards the trusted same-origin scheme request to this owned server.
      return fetchHttp(new URL(`${url.pathname}${url.search}`, apiOrigin).href, {
        method: request.method, headers, body, signal: request.signal, redirect: 'manual',
      });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 405 });
    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (relative.split(/[\\/]/).some((part) => part.startsWith('.'))) return new Response('', { status: 403 });
      const file = await fs.realpath(path.join(root, relative));
      if (!file.startsWith(`${root}${path.sep}`) || !(await fs.stat(file)).isFile()) {
        return new Response('', { status: 403 });
      }
      return fetchFile(pathToFileURL(file).href, { method: request.method, signal: request.signal });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return new Response('', { status: 404 });
      if (error instanceof URIError) return new Response('', { status: 400 });
      throw error;
    }
  };
}

/** Main owns Electron capabilities and exactly one returned NativeServerHandle. */
export function createNativeDesktop({ electron, startServer, options }) {
  const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, session } = electron;
  let window;
  let server;
  let starting;
  let stopping;
  let serverStopping;
  let exiting = false;
  let closing = false;
  let protocolInstalled = false;
  let ipcInstalled = false;
  const grants = new Map();
  const notifications = new Set();
  const uiUrl = options.uiUrl || `${APP_ORIGIN}/index.html`;
  if (options.uiUrl) {
    const url = new URL(options.uiUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !isAppDocument(uiUrl, uiUrl)
      || url.username || url.password || url.search || url.hash) {
      throw new Error('Desktop HMR requires an exact loopback application URL');
    }
  }

  const invoke = async (event, command, raw) => {
    if (closing || !isTrustedSender(event, window, uiUrl)) throw new Error('Native IPC refused');
    switch (command) {
      case 'selectFolder':
      case 'selectFile': {
        const input = pickerInput.parse(raw);
        const result = await dialog.showOpenDialog(window, {
          defaultPath: input.defaultPath,
          properties: [command === 'selectFolder' ? 'openDirectory' : 'openFile'],
        });
        if (result.canceled || !result.filePaths.length) return null;
        const selected = await fs.realpath(result.filePaths[0]);
        if (closing || !isTrustedSender(event, window, uiUrl)) throw new Error('Native IPC refused');
        grants.set(selected, command === 'selectFolder');
        return selected;
      }
      case 'openPath':
      case 'revealPath': {
        const selected = await fs.realpath(pathInput.parse(raw));
        const allowed = [...grants].some(([grant, directory]) =>
          selected === grant || (directory && selected.startsWith(`${grant}${path.sep}`)));
        if (!allowed || closing || !isTrustedSender(event, window, uiUrl)) throw new Error('Path has no native selection grant');
        if (command === 'revealPath') { shell.showItemInFolder(selected); return null; }
        const error = await shell.openPath(selected);
        if (error) throw new Error(error);
        return null;
      }
      case 'notify': {
        const input = notificationInput.parse(raw);
        if (!Notification.isSupported()) return { supported: false };
        const notification = new Notification(input);
        notifications.add(notification);
        notification.once('close', () => notifications.delete(notification));
        notification.once('failed', () => notifications.delete(notification));
        return new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer);
            notification.off('show', shown);
            notification.off('failed', failed);
            notification.off('close', closed);
            if (error) { notification.close(); reject(error); }
            else resolve({ supported: true });
          };
          const shown = () => finish();
          const failed = (_event, error) => finish(new Error(error));
          const closed = () => finish(new Error('Native notification closed before display'));
          const timer = setTimeout(() => finish(new Error('Native notification display was not confirmed')), 10_000);
          notification.once('show', shown);
          notification.once('failed', failed);
          notification.once('close', closed);
          notification.show();
        });
      }
      default: throw new Error('Unknown native operation');
    }
  };

  const cleanup = async () => {
    // The handle owns PTYs and retained-session disconnect, never host termination.
    try {
      if (server) serverStopping ??= server.stop();
      await serverStopping;
    }
    finally {
      for (const notification of notifications) notification.close();
      notifications.clear();
      grants.clear();
      if (ipcInstalled) { ipcMain.removeHandler(IPC_CHANNEL); ipcInstalled = false; }
      if (protocolInstalled) { session.defaultSession.protocol.unhandle(UI_SCHEME); protocolInstalled = false; }
      if (window && !window.isDestroyed()) window.destroy();
      process.off('SIGINT', signalQuit);
      process.off('SIGTERM', signalQuit);
    }
  };
  const stop = () => {
    closing = true;
    if (!stopping) stopping = (async () => {
      // A quit during startup must wait for the handle before cleaning it.
      if (starting) await starting.catch(() => {});
      await cleanup();
    })();
    return stopping;
  };
  const quit = (event) => {
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    void stop().then(() => app.exit(0), (error) => {
      console.error('[omochamber] shutdown failed:', error);
      app.exit(1);
    });
  };
  app.on('before-quit', quit);
  app.on('window-all-closed', () => { if (!closing) app.quit(); });
  const signalQuit = () => app.quit();
  app.on('will-quit', () => {
    process.off('SIGINT', signalQuit);
    process.off('SIGTERM', signalQuit);
  });
  process.on('SIGINT', signalQuit);
  process.on('SIGTERM', signalQuit);

  const start = () => {
    if (starting) return starting;
    if (closing) return Promise.reject(new Error('Desktop is stopping'));
    starting = (async () => {
      try {
        server = await startServer({ host: '127.0.0.1', port: options.port ?? 0, dataDir: options.dataDir });
        if (server.runtime !== 'omo' || !server.isReady()) throw new Error('Native backend is not ready');
        if (closing) return;
        const apiOrigin = `http://127.0.0.1:${server.getPort()}`;
        const ownedSession = session.defaultSession;
        ownedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        ownedSession.setPermissionCheckHandler(() => false);
        if (!options.uiUrl) {
          const handler = await createUiProtocolHandler({
            uiDirectory: options.uiDirectory, apiOrigin, fetchFile: electron.net.fetch,
          });
          if (closing) return;
          ownedSession.protocol.handle(UI_SCHEME, handler);
          protocolInstalled = true;
        }
        window = new BrowserWindow({
          width: 1280, height: 820, minWidth: 800, minHeight: 520,
          title: 'OmoChamber', show: false,
          webPreferences: {
            preload: options.preloadPath, contextIsolation: true, nodeIntegration: false,
            // Electron's ESM preload runs unsandboxed; no Node API crosses its bridge.
            sandbox: false, webviewTag: false,
            additionalArguments: [`--omochamber-ui-url=${uiUrl}`, `--omochamber-api-origin=${apiOrigin}`],
          },
        });
        const contents = window.webContents;
        const guardNavigation = (event) => {
          if (!isAppDocument(event.url, uiUrl)) event.preventDefault();
        };
        contents.on('will-navigate', guardNavigation);
        contents.on('will-frame-navigate', guardNavigation);
        contents.on('will-redirect', guardNavigation);
        contents.on('will-attach-webview', (event) => event.preventDefault());
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('page-title-updated', (event) => event.preventDefault());
        ipcMain.handle(IPC_CHANNEL, invoke);
        ipcInstalled = true;
        Menu.setApplicationMenu(Menu.buildFromTemplate([
          ...(process.platform === 'darwin' ? [{ label: 'OmoChamber', submenu: [{ role: 'quit' }] }] : []),
          { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
        ]));
        await window.loadURL(uiUrl);
        if (!closing) { window.show(); window.focus(); }
      } catch (error) {
        closing = true;
        try { await cleanup(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Desktop startup and cleanup failed'); }
        throw error;
      }
    })();
    return starting;
  };
  return { start, stop, getWindow: () => window, getServer: () => server };
}
