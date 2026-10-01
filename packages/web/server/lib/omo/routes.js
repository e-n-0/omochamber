import fs from 'node:fs/promises';
import { z } from 'zod';

const id = z.string().min(1).max(256);
const nonblank = z.string().refine((value) => value.trim().length > 0);
const projectInput = z.object({ path: nonblank, name: nonblank.max(1_000).optional() }).strict();
const projectUpdate = projectInput.partial().refine((input) => Object.keys(input).length > 0);
const settingsUpdate = z.object({
  theme: nonblank.optional(), fontSize: z.number().positive().max(100).optional(),
  fontFamily: nonblank.optional(), layout: z.enum(['comfortable', 'compact']).optional(),
}).strict();
const createInput = z.object({
  requestId: id, projectId: id, worktreePath: nonblank.optional(), name: nonblank.max(1_000).optional(),
}).strict();
const outputOptions = z.object({
  mode: z.enum(['status', 'tail', 'full']).optional(),
  tailLines: z.coerce.number().int().min(1).max(1_000).optional(),
}).strict();

function invalid(message = 'Invalid native request', statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'invalid_request' });
}
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid();
  return result.data;
}
async function canonicalDirectory(directory) {
  try {
    const canonical = await fs.realpath(directory);
    if (!(await fs.stat(canonical)).isDirectory()) throw invalid();
    return canonical;
  } catch { throw invalid('Project directory is unavailable'); }
}
const publicProject = (project) => {
  const result = { id: project.id, path: project.path, name: project.name };
  if (project.worktreePaths) result.worktreePaths = project.worktreePaths;
  return result;
};
const publicSettings = (settings) => {
  const result = { schemaVersion: 1 };
  for (const key of ['theme', 'fontSize', 'fontFamily', 'layout']) {
    if (settings[key] !== undefined) result[key] = settings[key];
  }
  return result;
};
const routeError = (res, error) => res.status(error.statusCode ?? 503).json({
  error: error.statusCode === 400 ? 'Invalid native request' : 'Native request could not be completed',
  code: error.uncertain ? 'uncertain' : error.statusCode ? error.code : 'native_unavailable',
});

/** Auth, JSON size and origin middleware must wrap /api before registration. */
export function registerOmoRoutes(app, { service, settings }) {
  const route = (method, url, handler) => app[method](url, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await handler(req, res); } catch (error) {
      if (res.headersSent) res.destroy();
      else routeError(res, error);
    }
  });
  async function projectFor(projectId) {
    const project = (await settings.listProjects()).find((item) => item.id === projectId);
    if (!project) throw Object.assign(invalid('Project was not found', 404), { code: 'project_not_found' });
    return project;
  }
  const sessionKey = (req) => parse(id, req.params.sessionKey);
  route('get', '/api/omo/status', async (_req, res) => res.json(await service.status()));
  route('get', '/api/omo/hosts', async (_req, res) => res.json(await service.listHosts()));
  route('get', '/api/omo/projects', async (_req, res) => res.json((await settings.listProjects()).map(publicProject)));
  route('post', '/api/omo/projects', async (req, res) => {
    const input = parse(projectInput, req.body);
    input.path = await canonicalDirectory(input.path);
    res.json(publicProject(await settings.addProject(input)));
  });
  route('patch', '/api/omo/projects/:projectId', async (req, res) => {
    const projectId = parse(id, req.params.projectId);
    const input = parse(projectUpdate, req.body);
    await projectFor(projectId);
    if (input.path) input.path = await canonicalDirectory(input.path);
    res.json(publicProject(await settings.updateProject(projectId, input)));
  });
  route('delete', '/api/omo/projects/:projectId', async (req, res) => {
    const projectId = parse(id, req.params.projectId);
    const project = await projectFor(projectId);
    for (const directory of [project.path, ...(project.worktreePaths ?? [])]) {
      if (await service.isDirectoryInUse(directory)) {
        throw Object.assign(invalid('Project has native sessions in use', 409), { code: 'directory_in_use' });
      }
    }
    await settings.removeProject(projectId);
    res.status(204).end();
  });
  route('get', '/api/omo/sessions', async (req, res) => {
    const query = parse(z.object({ projectId: id.optional() }).strict(), req.query);
    if (!query.projectId) return res.json(await service.listSessions({}));
    const project = await projectFor(query.projectId);
    const paths = new Set([project.path, ...(project.worktreePaths ?? [])]);
    res.json((await service.listSessions({})).filter((session) => paths.has(session.directory)));
  });
  route('post', '/api/omo/sessions', async (req, res) => {
    const input = parse(createInput, req.body);
    const project = await projectFor(input.projectId);
    const directory = input.worktreePath ?? project.path;
    const cwd = await canonicalDirectory(directory);
    const allowed = await Promise.all([project.path, ...(project.worktreePaths ?? [])].map(canonicalDirectory));
    if (!allowed.includes(cwd)) throw invalid('Worktree does not belong to the project');
    const create = { requestId: input.requestId, cwd };
    if (input.name !== undefined) create.name = input.name;
    res.json(await service.createSession(create));
  });
  route('post', '/api/omo/sessions/:sessionKey/attach', async (req, res) => {
    if (req.body !== undefined && Object.keys(parse(z.object({}).strict(), req.body)).length) throw invalid();
    res.json(await service.attachSession(sessionKey(req)));
  });
  route('get', '/api/omo/sessions/:sessionKey/snapshot', async (req, res) => res.json(await service.getSnapshot(sessionKey(req))));
  route('post', '/api/omo/sessions/:sessionKey/commands', async (req, res) => {
    res.status(202).json(await service.execute(sessionKey(req), req.body));
  });
  route('post', '/api/omo/sessions/:sessionKey/ui-responses', async (req, res) => {
    res.status(202).json(await service.respond(sessionKey(req), req.body));
  });
  route('get', '/api/omo/sessions/:sessionKey/tasks/:taskId/output', async (req, res) => {
    res.json(await service.getTaskOutput(sessionKey(req), parse(id, req.params.taskId), parse(outputOptions, req.query)));
  });
  route('get', '/api/omo/settings', async (_req, res) => res.json(publicSettings(await settings.get())));
  route('patch', '/api/omo/settings', async (req, res) => {
    res.json(publicSettings(await settings.update(parse(settingsUpdate, req.body))));
  });
  route('get', '/api/omo/sessions/:sessionKey/events', async (req, res) => {
    const key = sessionKey(req);
    const buffer = [];
    let bytes = 0;
    let initial = true;
    let ended = false;
    let draining = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      buffer.length = 0;
    };
    const flush = () => {
      if (initial || ended || draining) return;
      while (buffer.length) {
        const line = buffer.shift();
        bytes -= Buffer.byteLength(line);
        if (!res.write(line)) {
          draining = true;
          res.once('drain', () => { draining = false; flush(); });
          return;
        }
      }
    };
    const enqueue = (event) => {
      if (ended) return;
      const line = `id: ${event.connectionEpoch}:${event.revision}\ndata: ${JSON.stringify(event)}\n\n`;
      bytes += Buffer.byteLength(line);
      // Slow consumers reconnect through a fresh snapshot, never a dropped delta.
      if (bytes > 4 * 1024 * 1024) { cleanup(); res.destroy(); return; }
      buffer.push(line);
      flush();
    };
    const pending = [];
    const unsubscribe = service.subscribe(key, (event) => {
      if (initial) pending.push(event);
      else enqueue(event);
    });
    res.once('close', cleanup);
    try {
      // Even Last-Event-ID gets a fresh snapshot: native replay has no durable
      // cursor guarantee. Subscribe before reading so attachment events cannot gap.
      const snapshot = await service.getSnapshot(key);
      if (ended) return;
      res.status(200).set({
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      enqueue({
        type: 'snapshot', sessionKey: key, connectionEpoch: snapshot.connectionEpoch,
        revision: snapshot.revision, snapshot,
      });
      for (const event of pending) {
        if (event.connectionEpoch === snapshot.connectionEpoch && event.revision > snapshot.revision) enqueue(event);
      }
      initial = false;
      flush();
    } catch (error) { cleanup(); throw error; }
  });
}
