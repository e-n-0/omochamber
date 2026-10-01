import { afterEach, describe, expect, test } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  commandAcceptedSchema, hostViewSchema, nativeSettingsSchema, projectSchema,
  sessionEventSchema, sessionSummarySchema, snapshotSchema, statusSchema, taskOutputSchema,
} from '../../../../ui/src/omo/contracts.ts';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { registerOmoRoutes } from './routes.js';
import { createFoundationFixture } from './session-service.fixtures.js';

const resources = [];
async function fixture() {
  const native = await createFoundationFixture();
  const snapshot = await native.attach();
  const projects = [{ id: 'project', path: native.project, name: 'Project', credentials: 'SECRET' }];
  let configuration = { schemaVersion: 1, theme: 'dark', privateRoot: native.agentDir, credentials: 'SECRET' };
  const settings = {
    async get() { return configuration; },
    async update(input) { configuration = { ...configuration, ...input }; return configuration; },
    async listProjects() { return projects; },
    async addProject(input) {
      const project = { id: `p${projects.length}`, ...input, name: input.name ?? path.basename(input.path) };
      projects.push(project);
      return project;
    },
    async updateProject(id, input) {
      const project = projects.find((item) => item.id === id);
      Object.assign(project, input);
      return project;
    },
    async removeProject(id) { projects.splice(projects.findIndex((item) => item.id === id), 1); },
  };
  const auth = createUiAuth({
    password: 'foundation-password',
    clientAuthController: {
      authenticateBearerToken: async (token) => token === 'fixture-token' ? { ok: true, clientId: 'fixture' } : null,
    },
  });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => auth.requireAuth(req, res, next));
  app.use('/api', async (req, res, next) => {
    if (req.headers.origin && !await security.isRequestOriginAllowed(req)) {
      res.status(403).json({ code: 'origin_forbidden' });
      return;
    }
    next();
  });
  registerOmoRoutes(app, { service: native.service, settings });
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'Invalid HTTP request' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', Origin: baseUrl };
  const request = (url, options = {}) => fetch(`${baseUrl}${url}`, { ...options, headers: { ...headers, ...options.headers } });
  const result = { ...native, native, snapshot, settings, projects, server, app, baseUrl, headers, request, auth };
  resources.push(result);
  return result;
}
afterEach(async () => {
  for (const f of resources.splice(0)) {
    f.auth.dispose();
    const closed = once(f.server, 'close');
    f.server.closeAllConnections();
    f.server.close();
    await closed;
    const receipt = await f.native.cleanup();
    expect(receipt.serverClosed).toBe(true);
    await expect(access(f.root)).rejects.toThrow();
  }
});
const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function parsedResponse(response, schema, status = 200) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(schema.parse(body)).toEqual(body);
  expect(JSON.stringify(body)).not.toContain('SECRET');
  return body;
}
async function stream(f) {
  const controller = new AbortController();
  const response = await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/events`, {
    signal: controller.signal, headers: { 'Last-Event-ID': 'obsolete:0' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(predicate) {
      for (;;) {
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          expect(sessionEventSchema.parse(event)).toEqual(event);
          if (predicate(event)) return event;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Native SSE ended before expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() { controller.abort(); await reader.cancel().catch(() => {}); },
  };
}

describe('authenticated native application routes', () => {
  test('registers every plan API route and roundtrips all public response DTOs', async () => {
    const f = await fixture();
    await parsedResponse(await f.request('/api/omo/status'), statusSchema);
    const hosts = await f.request('/api/omo/hosts').then((res) => res.json());
    for (const host of hosts) expect(hostViewSchema.parse(host)).toEqual(host);
    expect(JSON.stringify(hosts)).not.toContain(f.socketPath);
    const projects = await f.request('/api/omo/projects').then((res) => res.json());
    expect(projects).toHaveLength(1);
    expect(projectSchema.parse(projects[0])).toEqual(projects[0]);
    const sessions = await f.request('/api/omo/sessions?projectId=project').then((res) => res.json());
    expect(sessionSummarySchema.parse(sessions[0])).toEqual(sessions[0]);
    expect(sessions[0].sessionKey).toBe(f.snapshot.sessionKey);
    await parsedResponse(await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/attach`, { method: 'POST' }), snapshotSchema);
    const hydrated = await parsedResponse(await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/snapshot`), snapshotSchema);
    expect(hydrated.tasks.status).toBe('ready');
    expect(hydrated.tasks.value[0].notificationEpoch).toBe(0);
    const output = await parsedResponse(await f.request(
      `/api/omo/sessions/${f.snapshot.sessionKey}/tasks/${f.task.task_id}/output?mode=tail&tailLines=3`,
    ), taskOutputSchema);
    expect(output.output).toBe('native transcript');
    await parsedResponse(await f.request('/api/omo/settings'), nativeSettingsSchema);
    const settings = await parsedResponse(await f.request('/api/omo/settings', json('PATCH', { theme: 'light', fontSize: 14 })), nativeSettingsSchema);
    expect(settings).toEqual({ schemaVersion: 1, theme: 'light', fontSize: 14 });
    const directory = path.join(f.root, 'second');
    await mkdir(directory);
    const project = await parsedResponse(await f.request('/api/omo/projects', json('POST', { path: directory, name: 'Second' })), projectSchema);
    expect((await parsedResponse(await f.request(`/api/omo/projects/${project.id}`, json('PATCH', { name: 'Renamed' })), projectSchema)).name).toBe('Renamed');
    expect((await f.request(`/api/omo/projects/${project.id}`, { method: 'DELETE' })).status).toBe(204);
    const created = await parsedResponse(await f.request('/api/omo/sessions', json('POST', {
      requestId: 'http-create', projectId: 'project', name: 'HTTP',
    })), sessionSummarySchema);
    expect(created.name).toBe('HTTP');
  });

  test('actual auth and origin gates cover HTTP and SSE without dispatching work', async () => {
    const f = await fixture();
    for (const url of ['/api/omo/status', '/api/omo/hosts', '/api/omo/projects', '/api/omo/settings',
      `/api/omo/sessions/${f.snapshot.sessionKey}/snapshot`, `/api/omo/sessions/${f.snapshot.sessionKey}/events`]) {
      expect((await fetch(f.baseUrl + url)).status).toBe(401);
      expect((await f.request(url, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
    }
    const before = f.frames.length;
    const body = { requestId: 'foreign', connectionEpoch: f.snapshot.connectionEpoch, command: { type: 'prompt', text: 'Never dispatched' } };
    expect((await fetch(`${f.baseUrl}/api/omo/sessions/${f.snapshot.sessionKey}/commands`, json('POST', body))).status).toBe(401);
    expect((await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/commands`, {
      ...json('POST', body), headers: { Origin: 'https://foreign.example' },
    })).status).toBe(403);
    expect(f.frames).toHaveLength(before);
  });

  test('SSE subscribes before snapshot, correlates 202 commands, and reconnects with fresh snapshot', async () => {
    const f = await fixture();
    const sse = await stream(f);
    try {
      const first = await sse.next((event) => event.type === 'snapshot');
      expect(first.snapshot.durableSessionId).toBe('durable-parent');
      const result = sse.next((event) => event.type === 'commandResult' && event.result.requestId === 'http-abort');
      await parsedResponse(await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/commands`, json('POST', {
        requestId: 'http-abort', connectionEpoch: first.connectionEpoch, command: { type: 'abort' },
      })), commandAcceptedSchema, 202);
      expect((await result).result.success).toBe(true);
    } finally { await sse.close(); }
    const reconnect = await stream(f);
    try { expect((await reconnect.next((event) => event.type === 'snapshot')).snapshot.sessionKey).toBe(f.snapshot.sessionKey); }
    finally { await reconnect.close(); }
    expect(f.frames.some((frame) => ['close_session', 'shutdown'].includes(frame.type))).toBe(false);
  });

  test('native UI responses use the same accepted/result path, not an optimistic resolved response', async () => {
    const f = await fixture();
    const sse = await stream(f);
    try {
      await sse.next((event) => event.type === 'snapshot');
      const pending = sse.next((event) => event.type === 'native' && event.event.type === 'interaction_pending');
      f.native.event({ type: 'extension_ui_request', method: 'confirm', id: 'permission', title: 'Permission', message: 'Allow?' });
      await pending;
      const result = sse.next((event) => event.type === 'commandResult');
      await parsedResponse(await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/ui-responses`, json('POST', {
        requestId: 'permission-answer', connectionEpoch: f.snapshot.connectionEpoch,
        uiRequestId: 'permission', response: { confirmed: true },
      })), commandAcceptedSchema, 202);
      expect((await result).result.success).toBe(true);
    } finally { await sse.close(); }
  });

  test('malformed requests, unknown sessions, private routes and obsolete epochs fail closed', async () => {
    const f = await fixture();
    const commandUrl = `/api/omo/sessions/${f.snapshot.sessionKey}/commands`;
    const cases = [
      ['/api/omo/sessions', 'POST', { projectId: 'project', requestId: 'x', socketPath: f.socketPath }, 400],
      ['/api/omo/sessions', 'POST', { projectId: 'project', requestId: 'x', worktreePath: f.root }, 400],
      ['/api/omo/sessions', 'POST', { projectId: 'missing', requestId: 'x' }, 404],
      ['/api/omo/settings', 'PATCH', { engineRoot: f.runtime.engineRoot }, 400],
      ['/api/omo/projects', 'POST', { path: f.project, credentials: 'secret' }, 400],
      [commandUrl, 'POST', { requestId: 'x', connectionEpoch: f.snapshot.connectionEpoch - 1, command: { type: 'abort' } }, 409],
      [commandUrl, 'POST', { requestId: 'x', connectionEpoch: -1, command: { type: 'abort' } }, 400],
      [commandUrl, 'POST', { requestId: 'x', connectionEpoch: f.snapshot.connectionEpoch, command: { type: 'goalComplete' } }, 400],
      [commandUrl, 'POST', { requestId: 'x', connectionEpoch: f.snapshot.connectionEpoch, command: { type: 'taskSend', taskId: 'task', message: ' ' } }, 400],
      [`/api/omo/sessions/${f.snapshot.sessionKey}/ui-responses`, 'POST', {
        requestId: 'x', connectionEpoch: f.snapshot.connectionEpoch, uiRequestId: 'unknown', response: { value: 'none' },
      }, 409],
    ];
    const before = f.frames.length;
    for (const [url, method, body, status] of cases) {
      const response = await f.request(url, json(method, body));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(f.socketPath);
    }
    for (const query of ['mode=wrong', 'tailLines=0', 'tailLines=1001', 'tailLines=1.5', 'mode=tail&block=true']) {
      expect((await f.request(`/api/omo/sessions/${f.snapshot.sessionKey}/tasks/${f.task.task_id}/output?${query}`)).status).toBe(400);
    }
    expect((await f.request('/api/omo/sessions/unknown/snapshot')).status).toBe(404);
    expect((await f.request('/api/omo/sessions?projectId=project&socket=/private')).status).toBe(400);
    expect((await f.request(`/api/omo/projects/project`, { method: 'DELETE' })).status).toBe(409);
    expect((await f.request(commandUrl, { method: 'POST', body: '{broken' })).status).toBe(400);
    expect(f.frames).toHaveLength(before);
  });
});
