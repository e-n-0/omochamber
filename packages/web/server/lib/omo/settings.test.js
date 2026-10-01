import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeSettings } from './settings.js';

const roots = [];
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omo-settings-')));
  roots.push(root);
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  const dataDir = path.join(root, 'app');
  return { root, workspace, dataDir, settings: createNativeSettings({ dataDir }) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('native settings persistence', () => {
  test('round-trips appearance, explicit runtime settings and canonical projects separately', async () => {
    const f = await fixture();
    expect(await f.settings.get()).toEqual({ schemaVersion: 1 });
    await f.settings.update({ theme: 'dark', runtime: { agentDir: path.join(f.root, 'native') } });
    const alias = path.join(f.root, 'alias');
    await fs.symlink(f.workspace, alias);
    const project = await f.settings.addProject({ path: alias });
    expect(project.path).toBe(f.workspace);
    await f.settings.updateProject(project.id, { name: 'Renamed', worktreePaths: [f.workspace] });
    const reopened = createNativeSettings({ dataDir: f.dataDir });
    expect(await reopened.get()).toEqual({ schemaVersion: 1, theme: 'dark', runtime: { agentDir: path.join(f.root, 'native') } });
    expect(await reopened.listProjects()).toEqual([{ ...project, name: 'Renamed', worktreePaths: [f.workspace] }]);
    expect((await fs.stat(path.join(f.dataDir, 'settings.json'))).mode & 0o777).toBe(0o600);
    await reopened.removeProject(project.id);
    expect(await reopened.listProjects()).toEqual([]);
    expect(await fs.readdir(f.root)).toEqual(expect.arrayContaining(['app', 'project', 'alias']));
  });
  test('serializes overlapping updates without losing projects or preferences', async () => {
    const f = await fixture();
    await Promise.all([
      f.settings.update({ theme: 'light' }), f.settings.update({ fontSize: 16 }),
      f.settings.addProject({ path: f.workspace, name: 'Project' }),
    ]);
    expect(await f.settings.get()).toEqual({ schemaVersion: 1, theme: 'light', fontSize: 16 });
    expect(await f.settings.listProjects()).toHaveLength(1);
    expect(await fs.readdir(f.dataDir)).toEqual(['settings.json']);
  });
  test('rejects malformed, private and duplicate data without overwriting valid state', async () => {
    const f = await fixture();
    const project = await f.settings.addProject({ path: f.workspace });
    const filename = path.join(f.dataDir, 'settings.json');
    const before = await fs.readFile(filename, 'utf8');
    expect(() => f.settings.update({ socketPath: '/private/native.sock' })).toThrow();
    expect(() => f.settings.update({ fontSize: -1 })).toThrow();
    await expect(f.settings.addProject({ path: f.workspace })).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.settings.updateProject('missing', { name: 'Other' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await fs.readFile(filename, 'utf8')).toBe(before);
    await fs.writeFile(filename, '{"schemaVersion":99}');
    await expect(f.settings.get()).rejects.toThrow();
    await expect(f.settings.removeProject(project.id)).rejects.toThrow();
    expect(await fs.readFile(filename, 'utf8')).toBe('{"schemaVersion":99}');
  });
  test('preserves persistence failures and cleans an unsuccessful atomic replacement', async () => {
    const f = await fixture();
    await fs.mkdir(f.dataDir);
    await fs.mkdir(path.join(f.dataDir, 'settings.json'));
    await expect(f.settings.update({ theme: 'dark' })).rejects.toThrow();
    expect(await fs.readdir(f.dataDir)).toEqual(['settings.json']);
    await fs.rm(path.join(f.dataDir, 'settings.json'), { recursive: true });
    await f.settings.update({ theme: 'dark' });
    expect(await f.settings.get()).toEqual({ schemaVersion: 1, theme: 'dark' });
  });
});
