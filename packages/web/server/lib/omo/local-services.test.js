import { afterEach, describe, expect, test } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalServices } from './local-services.js';
import { createNativeSettings } from './settings.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';

const resources = [];
const run = promisify(execFile);
async function fixture({ gitBinary: realGitBinary } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omo-local-')));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'app');
  await fs.mkdir(workspace);
  const settings = createNativeSettings({ dataDir });
  const project = await settings.addProject({ path: workspace });
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  let inUse = false;
  const requests = path.join(root, 'git-requests.jsonl');
  const gitBinary = path.join(root, 'fake-git');
  // A real subprocess boundary, with captured argv and filesystem effects.
  await fs.writeFile(gitBinary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === 'worktree' && args[1] === 'add') {
  const target = args[args.indexOf('--') + 1];
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'qa.txt'), 'worktree');
}
if (args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args[args.indexOf('--') + 1], {recursive:true});
if (args[0] === 'rev-parse') process.stdout.write('abc123\\n');
if (args[0] === 'branch' && args[1] === '--show-current') process.stdout.write('test-branch\\n');
`, { mode: 0o700 });
  const local = createLocalServices({
    app, httpServer: server, dataDir, settings, gitBinary: realGitBinary ?? gitBinary,
    protectedPaths: [path.join(root, 'agent-alias')],
    service: { async isDirectoryInUse() { return inUse; } },
    uiAuthController: { enabled: true, async ensureSessionToken() { return 'fixture'; } },
    security: createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) }),
  });
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ code: error.code, error: error.message }));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = 'GET', body) => fetch(`${baseUrl}${url}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const f = { root, workspace, dataDir, project, settings, server, local, request, requests, set inUse(value) { inUse = value; } };
  resources.push(f);
  return f;
}
afterEach(async () => {
  for (const f of resources.splice(0)) {
    await f.local.close();
    const closed = once(f.server, 'close');
    f.server.closeAllConnections();
    f.server.close();
    await closed;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
const query = (f) => `?directory=${encodeURIComponent(f.workspace)}`;

describe('native retained local services', () => {
  test('reads and atomically writes scoped files while rejecting private paths and symlink escapes', async () => {
    const f = await fixture();
    const file = path.join(f.workspace, 'qa.txt');
    let response = await f.request(`/api/fs/write${query(f)}`, 'POST', { path: file, content: 'native bytes' });
    expect(response.status).toBe(200);
    response = await f.request(`/api/fs/read${query(f)}&path=${encodeURIComponent(file)}`);
    expect(await response.text()).toBe('native bytes');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret'), 'private');
    await fs.symlink(outside, path.join(f.workspace, 'escape'));
    response = await f.request(`/api/fs/write${query(f)}`, 'POST', { path: path.join(f.workspace, 'escape/new/file'), content: 'escape' });
    expect(response.status).toBe(403);
    expect(await fs.readdir(outside)).toEqual(['secret']);
    response = await f.request(`/api/fs/read${query(f)}&allowOutsideWorkspace=true&path=${encodeURIComponent(path.join(outside, 'secret'))}`);
    expect(response.status).toBe(403);
    await fs.mkdir(path.join(f.workspace, '.omo/senpi-task'), { recursive: true });
    response = await f.request(`/api/fs/list${query(f)}&path=${encodeURIComponent(path.join(f.workspace, '.omo/senpi-task'))}`);
    expect(response.status).toBe(403);
    const privateRoot = path.join(f.workspace, 'private-native');
    await fs.mkdir(privateRoot);
    await fs.writeFile(path.join(privateRoot, 'credentials.json'), '{"private":"fixture"}');
    await fs.symlink(privateRoot, path.join(f.root, 'agent-alias'));
    response = await f.request(`/api/fs/read${query(f)}&path=${encodeURIComponent(path.join(privateRoot, 'credentials.json'))}`);
    expect(response.status).toBe(403);
    expect((await f.request('/api/fs/exec', 'POST', { cwd: f.workspace, commands: ['true'] })).status).toBe(404);
  });
  test('creates app-owned worktrees over subprocess pipes and refuses removal while native work uses them', async () => {
    const f = await fixture();
    let response = await f.request(`/api/git/worktrees${query(f)}`, 'POST', { branchName: 'test-branch', name: 'qa' });
    expect(response.status).toBe(200);
    const worktree = await response.json();
    expect(worktree.path).toBe(path.join(f.dataDir, 'worktrees', f.project.id, 'qa'));
    expect((await f.settings.listProjects())[0].worktreePaths).toEqual([worktree.path]);
    response = await f.request(`/api/fs/read?directory=${encodeURIComponent(worktree.path)}&path=${encodeURIComponent(path.join(worktree.path, 'qa.txt'))}`);
    expect(await response.text()).toBe('worktree');
    f.inUse = true;
    response = await f.request(`/api/git/worktrees${query(f)}`, 'DELETE', { directory: worktree.path });
    expect(response.status).toBe(409);
    expect((await fs.readFile(f.requests, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).some((record) => record.args[1] === 'remove')).toBe(false);
    f.inUse = false;
    response = await f.request(`/api/git/worktrees${query(f)}`, 'DELETE', { directory: worktree.path, deleteLocalBranch: true });
    expect(response.status).toBe(200);
    await expect(fs.access(worktree.path)).rejects.toThrow();
    expect((await f.settings.listProjects())[0].worktreePaths).toEqual([]);
    const records = (await fs.readFile(f.requests, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    expect(records.map((item) => item.args)).toContainEqual(['worktree', 'remove', '--', worktree.path]);
    expect(records.map((item) => item.args)).toContainEqual(['branch', '-D', '--', 'test-branch']);
    await expect(fs.access(path.join(f.workspace, '.git/opencode'))).rejects.toThrow();
  });
  test('guards directory deletion and rejects primary or unregistered worktree removal', async () => {
    const f = await fixture();
    f.inUse = true;
    const deletion = await f.request(`/api/fs/delete${query(f)}`, 'POST', { path: f.workspace });
    expect(deletion.status).toBe(409);
    expect((await f.request(`/api/git/worktrees${query(f)}`, 'DELETE', { directory: f.workspace })).status).toBe(403);
    expect((await f.request('/api/terminal/create', 'POST', { cwd: f.root, cols: 80, rows: 24 })).status).toBe(403);
    expect((await f.request(`/api/git/stage${query(f)}`, 'POST', { paths: ['../outside'] })).status).toBe(403);
    await expect(fs.access(f.workspace)).resolves.toBeUndefined();
  });

  test('refuses dirty worktree deletion without losing uncommitted files', async () => {
    const f = await fixture({ gitBinary: 'git' });
    await run('git', ['init', '-b', 'flavien.darche/qa-source'], { cwd: f.workspace });
    await fs.writeFile(path.join(f.workspace, 'tracked.txt'), 'committed');
    await run('git', ['add', 'tracked.txt'], { cwd: f.workspace });
    await run('git', ['-c', 'user.name=OmoChamber QA', '-c', 'user.email=qa@invalid.example',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: f.workspace });
    const created = await f.request(`/api/git/worktrees${query(f)}`, 'POST', {
      branchName: 'flavien.darche/qa-dirty-worktree', name: 'dirty',
    });
    expect(created.status).toBe(200);
    const worktree = await created.json();
    const changedFile = path.join(worktree.path, 'tracked.txt');
    await fs.writeFile(changedFile, 'uncommitted data');

    const response = await f.request(`/api/git/worktrees${query(f)}`, 'DELETE', {
      directory: worktree.path,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'worktree_dirty' });
    expect(await fs.readFile(changedFile, 'utf8')).toBe('uncommitted data');
    expect((await f.settings.listProjects())[0].worktreePaths).toContain(worktree.path);
  });
});
