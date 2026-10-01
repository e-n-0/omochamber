import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { z } from 'zod';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { sessionCookieNameForRequest } from './lib/ui-auth/session-cookie.js';
import { isLoopbackBindHost } from './lib/security/bind-host.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import { createNativeSettings } from './lib/omo/settings.js';
import { createLocalServices } from './lib/omo/local-services.js';
import { resolveInstalledRuntime } from './lib/omo/installed-runtime.js';
import { createSessionService } from './lib/omo/session-service.js';
import { registerOmoRoutes } from './lib/omo/routes.js';
import { parseRequestPathname, TERMINAL_WS_PATH } from './lib/terminal/terminal-ws-protocol.js';

const scrypt = promisify(crypto.scrypt);
const unauthorized = (res) => res.status(401).json({ authenticated: false, locked: true });

/**
 * Password issuance is app-local and memory-only. The existing credential and
 * URL-token gates enforce requests without loading upstream JWT/passkey stores.
 */
async function nativeAuth(password) {
  const configuredPassword = z.string().max(4_096).default('').parse(password).normalize().trim();
  const enabled = configuredPassword.length > 0;
  const salt = crypto.randomBytes(16);
  const expected = enabled ? await scrypt(configuredPassword, salt, 64) : null;
  const tokens = new Map();
  let failures = 0;
  let failureWindow = 0;
  const gate = createUiAuth({
    requireClientAuth: enabled,
    clientAuthController: {
      async authenticateBearerToken(token) {
        const record = tokens.get(token);
        if (!record || record.expiresAt <= Date.now()) { tokens.delete(token); return null; }
        return { ok: true, clientId: record.id };
      },
    },
  });
  function request(req) {
    const headers = { ...req.headers };
    const name = sessionCookieNameForRequest(req, 'omo_ui_session');
    const raw = (headers.cookie ?? '').split(';').find((item) => item.trim().startsWith(`${name}=`));
    if (!headers.authorization && raw) headers.authorization = `Bearer ${raw.trim().slice(name.length + 1)}`;
    // The no-password controller trusts any ambient cookie. Only our issued
    // bearer credential is permitted through that seam when a password is set.
    delete headers.cookie;
    return { method: req.method, path: req.path, url: req.originalUrl ?? req.url, headers };
  }
  async function sessionToken(req) {
    if (!enabled) return 'local';
    return (await gate.resolveAuthContext(request(req), null))?.token ?? null;
  }
  return {
    // Terminal runtime checks origin only in its authenticated branch.
    enabled: true,
    requireAuth: (req, res, next) => gate.requireAuth(request(req), res, next),
    ensureSessionToken: sessionToken,
    async handleSessionStatus(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      if (!enabled) return res.json({ authenticated: true, disabled: true });
      return await sessionToken(req) ? res.json({ authenticated: true }) : unauthorized(res);
    },
    async handleSessionCreate(req, res) {
      if (!enabled) return res.status(400).json({ error: 'UI password not configured' });
      const input = z.object({ password: z.string().max(4_096), trustDevice: z.boolean().optional() }).strict().safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid login request' });
      const now = Date.now();
      if (now - failureWindow >= 5 * 60_000) { failures = 0; failureWindow = now; }
      if (++failures > 10) return res.status(429).json({ error: 'Too many login attempts' });
      const candidate = await scrypt(input.data.password.normalize().trim(), salt, 64);
      if (!crypto.timingSafeEqual(candidate, expected)) return unauthorized(res);
      failures = 0;
      for (const [token, value] of tokens) if (value.expiresAt <= now) tokens.delete(token);
      if (tokens.size >= 1_000) return res.status(429).json({ error: 'Too many login sessions' });
      const token = crypto.randomBytes(32).toString('base64url');
      const ttl = input.data.trustDevice === true ? 7 * 24 * 60 * 60_000 : 12 * 60 * 60_000;
      tokens.set(token, { id: crypto.randomUUID(), expiresAt: now + ttl });
      const name = sessionCookieNameForRequest(req, 'omo_ui_session');
      res.setHeader('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl / 1_000}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: true });
    },
    handleUrlAuthToken: (req, res) => gate.handleUrlAuthToken(request(req), res),
    dispose() { tokens.clear(); gate.dispose(); },
  };
}

/** Separate entrypoint: no legacy index, OpenCode controller or goal scheduler. */
export async function startWebUiServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackBindHost(host)) throw new Error('OmoChamber listens only on loopback');
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid server port');
  const dataDir = path.resolve(options.dataDir ?? process.env.OMOCHAMBER_DATA_DIR ?? path.join(os.homedir(), '.config', 'omochamber'));
  const settings = options.settings ?? createNativeSettings({ dataDir });
  const configuration = await settings.get();
  const runtime = options.runtime ?? await resolveInstalledRuntime({ ...configuration.runtime, ...options.runtimeOptions });
  const expressApp = express();
  expressApp.disable('x-powered-by');
  const httpServer = http.createServer(expressApp);
  const sockets = new Set();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let ready = false;
  let stopPromise;
  let auth;
  let service;
  let local;
  const stop = () => {
    if (!stopPromise) stopPromise = (async () => {
      ready = false;
      // Stop accepting HTTP work before shutting down this server's PTYs.
      const closing = new Promise((resolve, reject) => {
        if (!httpServer.listening) return resolve();
        httpServer.close((error) => error ? reject(error) : resolve());
        httpServer.closeIdleConnections();
      });
      const cleanup = await Promise.allSettled([local?.close(), service?.close()]);
      for (const socket of sockets) socket.destroy();
      await closing;
      auth?.dispose();
      const errors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native server cleanup failed');
    })();
    return stopPromise;
  };
  try {
    auth = await nativeAuth(options.uiPassword ?? process.env.OMOCHAMBER_UI_PASSWORD);
    service = options.service ?? createSessionService({ runtime, dataDir, ...options.serviceOptions });
    const requestSecurity = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
    const security = {
      ...requestSecurity,
      isRequestOriginAllowed(req) {
        // Loopback is not authentication. Refuse DNS-rebinding hosts and
        // forwarded-host claims before the retained origin gate sees them.
        let hostname;
        try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
        if (!isLoopbackBindHost(hostname) || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) return false;
        return requestSecurity.isRequestOriginAllowed(req);
      },
    };
    httpServer.on('upgrade', (req, socket) => {
      if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) requestSecurity.rejectWebSocketUpgrade(socket, 404, 'Route not found');
    });
    expressApp.use((req, res, next) => {
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return res.sendStatus(400); }
      if (!isLoopbackBindHost(hostname) || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) return res.sendStatus(403);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    const origin = async (req, res, next) => {
      if (req.headers.origin && !await security.isRequestOriginAllowed(req)) return res.status(403).json({ code: 'origin_forbidden' });
      // Headerless reads support local native clients. Mutations must carry
      // an origin, including password login and credential minting.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.origin) return res.status(403).json({ code: 'origin_required' });
      next();
    };
    expressApp.use('/auth', origin);
    expressApp.use('/api', origin, (req, res, next) => auth.requireAuth(req, res, next));
    expressApp.use(express.json({ limit: '1mb' }));
    expressApp.get('/auth/session', (req, res) => auth.handleSessionStatus(req, res));
    expressApp.post('/auth/session', (req, res) => auth.handleSessionCreate(req, res));
    expressApp.post('/auth/url-token', (req, res) => auth.handleUrlAuthToken(req, res));
    expressApp.get('/health', (_req, res) => res.json({ runtime: 'omo', ready }));
    expressApp.use('/api', (_req, res, next) => ready ? next() : res.status(503).json({ code: 'server_stopping' }));
    local = createLocalServices({
      ...options.localServiceOptions, app: expressApp, httpServer, settings, service, dataDir,
      uiAuthController: auth, security, protectedPaths: [runtime.agentDir, runtime.engineRoot, runtime.pluginRoot],
    });
    expressApp.delete('/api/omo/projects/:projectId', async (req, res, next) => {
      const project = (await settings.listProjects()).find((item) => item.id === req.params.projectId);
      if (project) for (const directory of [project.path, ...(project.worktreePaths ?? [])]) {
        if (await local.isDirectoryInUse(directory)) return res.status(409).json({ code: 'directory_in_use' });
      }
      next();
    });
    registerOmoRoutes(expressApp, {
      settings,
      service: {
        ...service,
        async createSession(input) {
          const release = await local.beginDirectoryUse(input.cwd);
          try { return await service.createSession(input); }
          finally { release(); }
        },
      },
    });
    if (options.uiDirectory) {
      const directory = await fs.realpath(options.uiDirectory);
      expressApp.use(express.static(directory, { dotfiles: 'deny', index: 'index.html' }));
    }
    expressApp.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
    expressApp.use((error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.statusCode ?? error.status ?? 500;
      res.status(status).json({ error: status === 500 ? 'Native server request failed' : error.message, code: error.code ?? 'invalid_request' });
    });
    await new Promise((resolve, reject) => {
      const failed = (error) => { httpServer.off('listening', listening); reject(error); };
      const listening = () => { httpServer.off('error', failed); resolve(); };
      httpServer.once('error', failed);
      httpServer.once('listening', listening);
      httpServer.listen(port, host === 'localhost' ? '127.0.0.1' : host);
    });
    ready = true;
    return {
      runtime: 'omo', expressApp, httpServer,
      getPort: () => httpServer.address()?.port ?? null,
      isReady: () => ready, stop,
    };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native startup and cleanup failed'); }
    throw error;
  }
}
