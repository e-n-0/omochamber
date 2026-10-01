import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { registerFsRoutes } from '../fs/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { createTerminalRuntime } from '../terminal/runtime.js';

const run = promisify(execFile);
const fsRoutes = new Set([
  'GET /api/fs/read', 'GET /api/fs/raw', 'GET /api/fs/stat', 'GET /api/fs/directory-stat',
  'GET /api/fs/list', 'GET /api/fs/git-dirs', 'POST /api/fs/mkdir', 'POST /api/fs/write',
  'POST /api/fs/upload', 'POST /api/fs/delete', 'POST /api/fs/rename',
]);
const gitRoutes = new Set([
  'GET /api/git/check', 'GET /api/git/status', 'GET /api/git/diff', 'GET /api/git/file-diff',
  'GET /api/git/branches', 'GET /api/git/log', 'GET /api/git/worktrees', 'GET /api/git/remotes',
  'GET /api/git/remote-url', 'POST /api/git/stage', 'POST /api/git/unstage',
  'POST /api/git/apply-hunk', 'POST /api/git/commit', 'POST /api/git/checkout',
  'POST /api/git/pull', 'POST /api/git/push', 'POST /api/git/fetch',
]);
const worktreeInput = z.object({
  mode: z.enum(['new', 'existing']).default('new'),
  branchName: z.string().trim().min(1).max(200),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional(),
  startRef: z.string().trim().min(1).max(200).optional(),
}).strict();
const failure = (message, statusCode = 403, code = 'workspace_forbidden') =>
  Object.assign(new Error(message), { statusCode, code });
const contains = (base, target) => {
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const absolutePath = z.string().min(1).refine(path.isAbsolute);
async function canonicalTarget(value) {
  const input = absolutePath.safeParse(value);
  if (!input.success) throw failure('Absolute path is required', 400, 'invalid_path');
  let ancestor = path.resolve(input.data);
  const missing = [];
  for (;;) {
    try { return path.join(await fs.promises.realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      // A dangling symlink is not a missing directory that we may create through.
      const stat = await fs.promises.lstat(ancestor).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (stat?.isSymbolicLink()) throw failure('Unresolved symbolic link');
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
const isExecutable = (candidate) => {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch { return false; }
};
const searchPathFor = (name, searchPath = process.env.PATH ?? '') => {
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

/** Reuse local tools without their legacy composition, engine or data writers. */
export function createLocalServices({
  app, httpServer, settings, service, dataDir, uiAuthController, security,
  protectedPaths = [], gitBinary = 'git', terminalOptions = {},
}) {
  const terminals = new Map();
  const pendingTerminals = new Set();
  const removals = new Set();
  const worktreeRoot = path.join(dataDir, 'worktrees');
  let closed = false;
  let worktreeMutation = Promise.resolve();
  const git = async (directory, args) => (await run(gitBinary, args, {
    cwd: directory, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024,
  })).stdout.trim();

  async function assertScoped(value) {
    const canonical = await canonicalTarget(value);
    const projects = await settings.listProjects();
    const roots = await Promise.all(projects.flatMap((project) => [project.path, ...(project.worktreePaths ?? [])]).map(canonicalTarget));
    if (!roots.some((base) => contains(base, canonical))) throw failure('Path is outside registered projects');
    const [canonicalDataDir, canonicalWorktreeRoot, ...privateRoots] = await Promise.all(
      [dataDir, worktreeRoot, ...protectedPaths.filter(Boolean)].map(canonicalTarget),
    );
    if ((contains(canonicalDataDir, canonical) && !contains(canonicalWorktreeRoot, canonical))
        || privateRoots.some((base) => contains(base, canonical))) {
      throw failure('Native private data is not browser-readable');
    }
    for (const project of projects) {
      const taskRoot = await canonicalTarget(path.join(project.path, '.omo', 'senpi-task'));
      if (contains(taskRoot, canonical)) throw failure('Native private data is not browser-readable');
    }
    if ([...removals].some((base) => contains(base, canonical))) throw failure('Workspace removal is in progress', 409, 'directory_in_use');
    return canonical;
  }
  async function resolveProjectDirectory(req) {
    const projects = await settings.listProjects();
    const requested = req.query.directory ?? (projects.length === 1 ? projects[0].path : null);
    if (!requested) throw failure('A project directory is required', 400, 'invalid_path');
    const directory = await assertScoped(requested);
    if (!(await fs.promises.stat(directory)).isDirectory()) throw failure('Project directory is unavailable', 400, 'invalid_path');
    return { directory, requestedDirectory: requested };
  }
  async function isDirectoryInUse(directory) {
    const canonical = await canonicalTarget(directory);
    if ([...terminals.values(), ...[...pendingTerminals].map((pending) => pending.cwd)].some((cwd) => contains(canonical, cwd))) return true;
    return service.isDirectoryInUse(canonical);
  }
  async function beginDirectoryUse(directory) {
    const cwd = await assertScoped(directory);
    if ([...removals].some((base) => contains(base, cwd))) throw failure('Workspace removal is in progress', 409, 'directory_in_use');
    const pending = { cwd };
    pendingTerminals.add(pending);
    return () => pendingTerminals.delete(pending);
  }
  const handle = (handler) => async (req, res, next) => {
    try {
      if (closed) throw failure('Local services are closed', 503, 'server_stopping');
      await handler(req, res, next);
    } catch (error) { next(error); }
  };

  const fsApp = {};
  for (const method of ['get', 'post']) {
    fsApp[method] = (url, handler) => {
      if (!fsRoutes.has(`${method.toUpperCase()} ${url}`)) return;
      app[method](url, handle(async (req, res) => {
        const project = await resolveProjectDirectory(req);
        const values = url.endsWith('/rename') ? [req.body?.oldPath, req.body?.newPath]
          : [method === 'get' || url.endsWith('/upload') ? req.query.path : req.body?.path];
        for (const target of values) await assertScoped(target);
        // The retained route's project resolver uses this validated request.
        req.nativeDirectory = project;
        if (!url.endsWith('/delete') && !url.endsWith('/rename')) return handler(req, res);
        const target = await canonicalTarget(values[0]);
        removals.add(target);
        try {
          if (await isDirectoryInUse(target)) throw failure('Directory has native work in use', 409, 'directory_in_use');
          await handler(req, res);
        } finally { removals.delete(target); }
      }));
    };
  }
  registerFsRoutes(fsApp, {
    os, path, fsPromises: fs.promises, spawn, crypto,
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: (req) => req.nativeDirectory,
    buildAugmentedPath: () => process.env.PATH ?? '',
    resolveGitBinaryForSpawn: () => gitBinary,
    openchamberUserConfigRoot: dataDir, managedChatsRoot: path.join(dataDir, 'chats'),
  });

  const gitApp = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    gitApp[method] = (url, handler) => {
      if (!gitRoutes.has(`${method.toUpperCase()} ${url}`)) return;
      app[method](url, handle(async (req, res) => {
        const { directory } = await resolveProjectDirectory(req);
        // Query is an Express getter; update its source URL, not a throwaway object.
        const query = new URLSearchParams(req.url.split('?')[1] ?? '');
        query.set('directory', directory);
        req.url = `${req.path}?${query}`;
        const rawPaths = req.body?.paths ?? [req.body?.path ?? req.query.path].filter((value) => value !== undefined);
        const paths = z.array(z.string().min(1).max(4_096)).max(1_000).safeParse(rawPaths);
        if (!paths.success) throw failure('Invalid Git paths', 400, 'invalid_path');
        for (const relative of paths.data) {
          const target = path.resolve(directory, relative);
          if (!contains(directory, target)) throw failure('Git path escapes workspace');
          await assertScoped(target);
        }
        await handler(req, res);
      }));
    };
  }
  registerGitRoutes(gitApp);

  const worktreeChange = (handler) => handle((req, res) => {
    const operation = worktreeMutation.then(() => handler(req, res));
    worktreeMutation = operation.catch(() => {});
    return operation;
  });
  app.post('/api/git/worktrees', worktreeChange(async (req, res) => {
    const input = worktreeInput.safeParse(req.body);
    if (!input.success) throw failure('Invalid worktree request', 400, 'invalid_request');
    const { directory } = await resolveProjectDirectory(req);
    const project = (await settings.listProjects()).find((item) => contains(item.path, directory) || item.worktreePaths?.includes(directory));
    const { mode, branchName, startRef } = input.data;
    await git(directory, ['check-ref-format', '--branch', branchName]);
    if (startRef?.startsWith('-')) throw failure('Invalid start reference', 400, 'invalid_request');
    const name = input.data.name ?? randomWorktreeName();
    const target = path.join(worktreeRoot, project.id, name);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const args = ['worktree', 'add'];
    if (mode === 'new') args.push('-b', branchName);
    args.push('--', target, mode === 'existing' ? branchName : startRef ?? 'HEAD');
    await git(directory, args);
    try {
      await settings.updateProject(project.id, { worktreePaths: [...(project.worktreePaths ?? []), target] });
    } catch (error) {
      try { await git(directory, ['worktree', 'remove', '--', target]); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Worktree registration and rollback failed'); }
      throw error;
    }
    const head = await git(target, ['rev-parse', 'HEAD']);
    res.json({ head, name, branch: branchName, path: target });
  }));
  app.delete('/api/git/worktrees', worktreeChange(async (req, res) => {
    const { directory } = await resolveProjectDirectory(req);
    const target = await assertScoped(req.body?.directory);
    const project = (await settings.listProjects()).find((item) => item.worktreePaths?.includes(target));
    if (!project || !contains(worktreeRoot, target)) throw failure('Only app-owned worktrees may be removed');
    if (target === project.path) throw failure('Cannot remove the primary workspace');
    removals.add(target);
    try {
      if (await isDirectoryInUse(target)) throw failure('Worktree has native work in use', 409, 'directory_in_use');
      if (await git(target, ['status', '--porcelain'])) {
        throw failure('Worktree has uncommitted changes', 409, 'worktree_dirty');
      }
      const branch = req.body.deleteLocalBranch === true ? await git(target, ['branch', '--show-current']) : null;
      await git(directory, ['worktree', 'remove', '--', target]);
      await settings.updateProject(project.id, { worktreePaths: project.worktreePaths.filter((value) => value !== target) });
      if (branch) await git(directory, ['branch', '-D', '--', branch]);
      res.json({ success: true });
    } finally { removals.delete(target); }
  }));

  const terminalApp = {};
  for (const method of ['get', 'post', 'delete']) {
    terminalApp[method] = (url, handler) => app[method](url, handle(async (req, res) => {
      let cwd;
      if (req.body?.cwd !== undefined) cwd = await assertScoped(req.body.cwd);
      if (req.query.cwd !== undefined) await assertScoped(req.query.cwd);
      if (url.endsWith('/create') && !cwd) throw failure('Terminal cwd is required', 400, 'invalid_path');
      const starting = url.endsWith('/create') || url.endsWith('/restart');
      cwd ??= terminals.get(req.params.sessionId);
      const release = starting && cwd ? await beginDirectoryUse(cwd) : () => {};
      const original = res.json.bind(res);
      res.json = (value) => {
        if (res.statusCode < 400) {
          if (starting && value.sessionId) terminals.set(value.sessionId, cwd);
          if (method === 'delete') terminals.delete(req.params.sessionId);
          for (const id of value.killedSessionIds ?? []) terminals.delete(id);
        }
        return original(value);
      };
      try { await handler(req, res); }
      finally { release(); }
    }));
  }
  const terminal = createTerminalRuntime({
    ...terminalOptions, app: terminalApp, server: httpServer, fs, path, uiAuthController,
    buildAugmentedPath: () => process.env.PATH ?? '', searchPathFor, isExecutable,
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
  });
  return {
    assertScoped, isDirectoryInUse, beginDirectoryUse,
    async close() { closed = true; await Promise.all([terminal.shutdown(), worktreeMutation]); terminals.clear(); pendingTerminals.clear(); },
  };
}

const randomWorktreeName = () => `omo-${crypto.randomUUID().slice(0, 12)}`;
