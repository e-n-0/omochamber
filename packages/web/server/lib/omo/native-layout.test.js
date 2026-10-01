import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInstalledRuntime } from './installed-runtime.js';
import { loadNativeReaders, nativeProjectKey, resolveNativeLayout, selectActiveBranch } from './native-layout.js';
import { createNativeFixture, treeBytes, writeJson } from './fixtures/native-state-fixture.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture() {
  const result = await createNativeFixture();
  fixtures.push(result);
  return result;
}

describe('native read-only layout', () => {
  it('encodes the durable goal ID beneath the canonical session directory and prefers registered roots', async () => {
    const resource = await fixture();
    const link = path.join(resource.root, 'session-alias.jsonl');
    await fs.symlink(resource.sessionPath, link);
    await writeJson(path.join(resource.cwd, '.omo', 'omo.json'), { task: { state_dir: 'unresolved-relative' } });
    const before = await treeBytes(resource.root);
    const layout = await resolveNativeLayout({ ...resource.options, sessionPath: link });
    expect(layout.status).toBe('ready');
    expect(layout.sessionPath).toBe(await fs.realpath(resource.sessionPath));
    expect(layout.goalPath).toBe(resource.goalPath);
    expect(layout.goalRef.threadId).toBe(resource.data.durableSessionId);
    expect(layout.taskRoots).toEqual([await fs.realpath(resource.taskRoot)]);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('uses native realpath hashing and the existing project store before the agent bucket', async () => {
    const resource = await fixture();
    const canonical = await fs.realpath(resource.cwd);
    const key = `native-project-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
    const link = path.join(resource.root, 'project-alias');
    await fs.symlink(resource.cwd, link);
    expect(await nativeProjectKey(link)).toBe(key);
    const options = { ...resource.options, cwd: link, stores: [] };
    const before = await treeBytes(resource.root);
    expect((await resolveNativeLayout(options)).taskRoots).toEqual([
      path.join(resource.options.runtime.agentDir, 'projects', key, 'senpi-task'),
    ]);
    expect(await treeBytes(resource.root)).toEqual(before);
    const local = path.join(resource.cwd, '.omo', 'senpi-task');
    await fs.mkdir(local, { recursive: true });
    expect((await resolveNativeLayout(options)).taskRoots).toEqual([local]);
  });

  it('matches native Unicode basename sanitization', async () => {
    const resource = await fixture();
    const directory = path.join(resource.root, 'résumé project!');
    await fs.mkdir(directory);
    const canonical = await fs.realpath(directory);
    expect(await nativeProjectKey(directory)).toBe(
      `résumé_project_-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`,
    );
  });

  it('preserves native user/project, harness and profile configuration precedence', async () => {
    const resource = await fixture();
    const home = resource.options.runtime.homeDir;
    const userRoot = path.join(resource.root, 'user-state');
    const harnessRoot = path.join(resource.root, 'harness-state');
    const profileRoot = path.join(resource.root, 'profile-state');
    await fs.mkdir(path.join(home, '.omo'));
    await fs.writeFile(path.join(home, '.omo', 'omo.jsonc'), `{
      // Harness values apply after merged project base values.
      "task": { "state_dir": ${JSON.stringify(userRoot)} },
      "[senpi]": { "task": { "state_dir": ${JSON.stringify(harnessRoot)} } },
      "profiles": { "review": { "task": { "state_dir": ${JSON.stringify(profileRoot)} } } },
    }`);
    await writeJson(path.join(resource.cwd, '.omo', 'omo.json'), {
      task: { state_dir: path.join(resource.root, 'project-state') },
    });
    const options = { ...resource.options, stores: [] };
    const before = await treeBytes(resource.root);
    expect((await resolveNativeLayout(options)).status).toBe('incomplete');
    expect((await resolveNativeLayout({
      ...options, runtime: { ...options.runtime, profile: 'review' },
    })).taskRoots).toEqual([profileRoot]);
    expect((await resolveNativeLayout({
      ...options, runtime: { ...options.runtime, profile: 'unconfigured' },
    })).taskRoots).toEqual([harnessRoot]);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('never resolves a foreign relative root against the web cwd', async () => {
    const resource = await fixture();
    await writeJson(path.join(resource.cwd, '.omo', 'omo.json'), { task: { state_dir: 'relative-state' } });
    const options = { ...resource.options, stores: [] };
    const before = await treeBytes(resource.root);
    const unknown = await resolveNativeLayout(options);
    expect(unknown.status).toBe('incomplete');
    expect(unknown.taskRoots).toEqual([]);
    const launchCwd = path.join(resource.root, 'native-launch');
    const known = await resolveNativeLayout({ ...options, runtime: { ...options.runtime, launchCwd } });
    expect(known.status).toBe('ready');
    expect(known.taskRoots).toEqual([path.join(launchCwd, 'relative-state')]);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('marks malformed roots/configuration incomplete without fabricating an empty inventory', async () => {
    const resource = await fixture();
    const partial = await resolveNativeLayout({
      ...resource.options, stores: [resource.taskRoot, 'relative-foreign-store'],
    });
    expect(partial.status).toBe('incomplete');
    expect(partial.taskRoots).toEqual([await fs.realpath(resource.taskRoot)]);
    await fs.mkdir(path.join(resource.cwd, '.omo'));
    await fs.writeFile(path.join(resource.cwd, '.omo', 'omo.jsonc'), '{"task":');
    expect((await resolveNativeLayout({ ...resource.options, stores: [] })).status).toBe('incomplete');
  });

  it('ignores symlinked project config like the native loader', async () => {
    const resource = await fixture();
    const external = path.join(resource.root, 'external-config');
    await writeJson(path.join(external, 'omo.json'), { task: { state_dir: 'foreign-relative' } });
    await fs.symlink(external, path.join(resource.cwd, '.omo'));
    expect((await resolveNativeLayout({ ...resource.options, stores: [] })).status).toBe('ready');
  });

  it('loads only the existing pure goal/todo exports and leaves fixture bytes unchanged', async () => {
    const resource = await fixture();
    const runtime = await resolveInstalledRuntime();
    const readers = await loadNativeReaders(runtime);
    const before = await treeBytes(resource.root);
    const layout = await resolveNativeLayout(resource.options);
    expect((await readers.readGoalFile(layout.goalRef)).id).toBe('goal-native');
    const branch = selectActiveBranch(resource.data.entries, 'todo-current');
    expect(readers.getLatestTodoStateFromBranchEntries(branch.entries).phases[0].name).toBe('Current');
    expect(await treeBytes(resource.root)).toEqual(before);
  });
});

describe('active native ancestry', () => {
  it('uses leaf ancestry instead of append order, including abandoned branches', async () => {
    const resource = await fixture();
    expect(selectActiveBranch(resource.data.entries, 'todo-current').entries.map((entry) => entry.id))
      .toEqual(['root', 'todo-initial', 'todo-current']);
    expect(selectActiveBranch(resource.data.entries, 'todo-old-branch').entries.map((entry) => entry.id))
      .toEqual(['root', 'todo-initial', 'todo-old-branch']);
  });

  it('distinguishes authoritative empty from missing, cyclic and duplicate ancestry', () => {
    expect(selectActiveBranch([], null)).toEqual({ status: 'ready', entries: [] });
    for (const [entries, leafId] of [
      [[], 'missing'],
      [[{ id: 'a', parentId: 'missing', type: 'custom' }], 'a'],
      [[{ id: 'a', parentId: 'a', type: 'custom' }], 'a'],
      [[{ id: 'a', parentId: null, type: 'custom' }, { id: 'a', parentId: null, type: 'custom' }], 'a'],
      [[{ id: 'a', parentId: null, type: 'custom' }], null],
      [[], undefined],
    ]) expect(selectActiveBranch(entries, leafId).status).toBe('incomplete');
  });
});
