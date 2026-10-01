import { describe, expect, test } from 'bun:test';
import { createChangesWorkspace } from './changes';
import { createWorkspaceClient, WorkspaceError } from './workspace';

const status = (index = ' ', working_dir = 'M') => ({
  current: 'main', ahead: 0, behind: 0, files: [{ path: 'qa.txt', index, working_dir }],
});
const tree = { path: '/owned/worktrees/qa', name: 'qa', branch: 'qa', head: 'abc' };

describe('native working tree and owned worktrees', () => {
  test('stage and unstage refresh authoritative status in the captured directory', async () => {
    let staged = false;
    const scopes: string[] = [];
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path, options) => {
      scopes.push(String(options?.directory));
      if (path.endsWith('/status')) return Response.json(status(staged ? 'M' : ' ', staged ? ' ' : 'M'));
      expect(JSON.parse(String(options?.body))).toEqual({ path: 'qa.txt' });
      staged = path.endsWith('/stage');
      return Response.json({ success: true });
    }));
    await workspace.refresh();
    await workspace.stage({ path: 'qa.txt', staged: false });
    expect(workspace.getStatus()?.files[0].index).toBe('M');
    await workspace.stage({ path: 'qa.txt', staged: true });
    expect(workspace.getStatus()?.files[0].working_dir).toBe('M');
    expect(scopes).toEqual(Array(5).fill('/project'));
  });

  test('late per-file diff cannot overwrite a newer selection or scope', async () => {
    let release!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => { release = resolve; });
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (_path, options) => {
      const query = options?.query;
      const path = query instanceof URLSearchParams ? query.get('path') : query?.path;
      if (path === 'a') return late;
      return Response.json({ path, original: '', modified: 'B', isBinary: false, submodule: null });
    }));
    const pending = workspace.select({ path: 'a', staged: false });
    await workspace.select({ path: 'b', staged: true });
    release(Response.json({ path: 'a', original: '', modified: 'A', isBinary: false, submodule: null }));
    await pending;
    expect(workspace.getDiff()?.selection).toEqual({ path: 'b', staged: true });
    expect(workspace.getDiff()?.value?.modified).toBe('B');
  });

  test('refresh after an editor save reloads the currently selected working diff', async () => {
    let modified = 'before save';
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path) => (
      path.endsWith('/status') ? Response.json(status())
        : Response.json({ path: 'qa.txt', original: 'original', modified, isBinary: false, submodule: null })
    )));
    await workspace.select({ path: 'qa.txt', staged: false });
    modified = 'after save';
    await workspace.refresh();
    expect(workspace.getDiff()?.value?.modified).toBe('after save');
    expect(workspace.getDiff()?.selection).toEqual({ path: 'qa.txt', staged: false });
  });

  for (const code of ['worktree_dirty', 'directory_in_use']) test(`${code} 409 preserves topology and reports the refusal`, async () => {
    const calls: string[] = [];
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path, options) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      if (options?.method === 'DELETE') {
        expect(JSON.parse(String(options.body))).toEqual({ directory: tree.path, deleteLocalBranch: false });
        return Response.json({ error: code, code }, { status: 409 });
      }
      if (path.endsWith('/projects')) return Response.json([{ id: 'p', name: 'P', path: '/project', worktreePaths: [tree.path] }]);
      return Response.json([tree]);
    }));
    await workspace.refreshWorktrees();
    const previous = workspace.getWorktrees().entries;
    expect(await workspace.removeWorktree(tree.path)).toBe(false);
    expect(workspace.getWorktrees().entries).toBe(previous);
    expect(workspace.getWorktrees().error).toBeInstanceOf(WorkspaceError);
    expect(workspace.getWorktrees().error).toMatchObject({ status: 409, code });
    expect(calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
  });

  test('create registers an app-owned path and removal reconciles only after success', async () => {
    let entries: typeof tree[] = [];
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path, options) => {
      if (options?.method === 'POST') { entries = [tree]; return Response.json(tree); }
      if (options?.method === 'DELETE') { entries = []; return Response.json({ success: true }); }
      if (path.endsWith('/projects')) return Response.json([{ id: 'p', name: 'P', path: '/project', worktreePaths: entries.map((item) => item.path) }]);
      return Response.json(entries);
    }));
    expect(await workspace.createWorktree('qa')).toBe(true);
    expect(workspace.getWorktrees().owned.has(tree.path)).toBe(true);
    expect(await workspace.removeWorktree(tree.path)).toBe(true);
    expect(workspace.getWorktrees().entries).toEqual([]);
  });

  test('failed status and topology reads keep their last complete values', async () => {
    let fail = false;
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path) => {
      if (fail) return Response.json({ error: 'unavailable' }, { status: 503 });
      if (path.endsWith('/status')) return Response.json(status());
      if (path.endsWith('/projects')) return Response.json([]);
      return Response.json([tree]);
    }));
    await workspace.refresh();
    await workspace.refreshWorktrees();
    const previousStatus = workspace.getStatus();
    const previousTrees = workspace.getWorktrees().entries;
    fail = true;
    await workspace.refresh();
    await workspace.refreshWorktrees();
    expect(workspace.getStatus()).toBe(previousStatus);
    expect(workspace.getWorktrees().entries).toBe(previousTrees);
    expect(workspace.getError()).toBeInstanceOf(Error);
  });
});
