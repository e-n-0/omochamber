import type { NativeProject } from '../contracts';
import type { FileDiff, GitStatus, Worktree, WorkspaceClient } from './workspace';

type ChangeSelection = { path: string; staged: boolean };
type DiffState = { selection: ChangeSelection; value: FileDiff | null; error: Error | null };
type WorktreeState = { entries: Worktree[]; owned: ReadonlySet<string>; error: Error | null; loaded: boolean };
const errorOf = (cause: unknown) => cause instanceof Error ? cause : new Error('Git operation failed', { cause });

export function createChangesWorkspace(client: WorkspaceClient) {
  const listeners = new Set<() => void>();
  let status: GitStatus | null = null;
  let statusError: Error | null = null;
  let diff: DiffState | null = null;
  let worktrees: WorktreeState = { entries: [], owned: new Set(), error: null, loaded: false };
  let busy = false;
  let revision = 0;
  let diffRevision = 0;
  let treeRevision = 0;
  const notify = () => listeners.forEach((listener) => listener());
  async function refresh() {
    const generation = ++revision;
    try {
      const next = await client.status();
      if (generation !== revision) return;
      status = next;
      statusError = null;
      if (diff) await select(diff.selection);
    } catch (cause) {
      if (generation !== revision) return;
      statusError = errorOf(cause);
    }
    notify();
  }
  async function select(selection: ChangeSelection) {
    const generation = ++diffRevision;
    diff = { selection, value: null, error: null };
    notify();
    try {
      const value = await client.diff(selection.path, selection.staged);
      if (generation !== diffRevision) return;
      diff = { selection, value, error: null };
    } catch (cause) {
      if (generation !== diffRevision) return;
      diff = { selection, value: null, error: errorOf(cause) };
    }
    notify();
  }
  async function stage(selection: ChangeSelection) {
    if (busy) return;
    busy = true;
    ++revision; // A pre-mutation status response cannot restore the old index.
    ++diffRevision;
    statusError = null;
    notify();
    try {
      await client.stage(selection.path, selection.staged);
      diff = null;
      await refresh();
    } catch (cause) {
      statusError = errorOf(cause);
    } finally { busy = false; notify(); }
  }
  async function refreshWorktrees() {
    const generation = ++treeRevision;
    try {
      const [entries, projects] = await Promise.all([client.worktrees(), client.projects()]);
      if (generation !== treeRevision) return;
      const owned = new Set(projects.flatMap((project: NativeProject) => project.worktreePaths ?? []));
      worktrees = { entries, owned, error: null, loaded: true };
    } catch (cause) {
      if (generation !== treeRevision) return;
      worktrees = { ...worktrees, error: errorOf(cause) };
    }
    notify();
  }
  async function mutateWorktree(operation: () => Promise<Worktree | { success: true }>) {
    if (busy) return false;
    busy = true;
    ++treeRevision;
    worktrees = { ...worktrees, error: null };
    notify();
    try {
      await operation();
      await refreshWorktrees();
      return true;
    } catch (cause) {
      worktrees = { ...worktrees, error: errorOf(cause) };
      return false;
    } finally { busy = false; notify(); }
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getStatus: () => status, getError: () => statusError, getDiff: () => diff,
    getWorktrees: () => worktrees, isBusy: () => busy,
    refresh, select, stage, refreshWorktrees,
    createWorktree: (branch: string) => mutateWorktree(() => client.createWorktree(branch)),
    removeWorktree: (path: string) => mutateWorktree(() => client.removeWorktree(path)),
  };
}
export type ChangesWorkspace = ReturnType<typeof createChangesWorkspace>;
