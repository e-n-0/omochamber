import { z } from 'zod';
import { projectSchema } from '../contracts';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';

// These are the retained local-service responses, not native engine DTOs.
const entrySchema = z.object({
  name: z.string(), path: z.string(), isDirectory: z.boolean(),
  isFile: z.boolean(), isSymbolicLink: z.boolean(),
});
const listingSchema = z.object({ path: z.string(), entries: z.array(entrySchema) });
const fileStatusSchema = z.object({ path: z.string(), index: z.string(), working_dir: z.string() });
const statusSchema = z.object({
  isGitRepository: z.boolean().optional(), current: z.string().nullable().optional(),
  files: z.array(fileStatusSchema), ahead: z.number(), behind: z.number(),
});
const diffSchema = z.object({
  original: z.string(), modified: z.string(), path: z.string(), isBinary: z.boolean(),
  submodule: z.object({
    headCommit: z.string().nullable(), indexCommit: z.string().nullable(), worktreeCommit: z.string().nullable(),
    hasTrackedChanges: z.boolean(), hasUntrackedFiles: z.boolean(), hasConflict: z.boolean(),
  }).nullable(),
});
const worktreeSchema = z.object({
  head: z.string(), name: z.string(), branch: z.string(), path: z.string(),
  prunable: z.boolean().optional(),
});
const successSchema = z.object({ success: z.literal(true) });
const errorSchema = z.object({ error: z.string().optional(), code: z.string().optional() });
const statSchema = z.object({ path: z.string(), isFile: z.literal(true), size: z.number(), mtimeMs: z.number() });
const MAX_EDITOR_BYTES = 1024 * 1024;
type WorkspaceMutation =
  | { path: string; content: string }
  | { path: string }
  | { mode: 'new'; branchName: string }
  | { directory: string; deleteLocalBranch: false };

export type DirectoryListing = z.infer<typeof listingSchema>;
export type GitStatus = z.infer<typeof statusSchema>;
export type FileDiff = z.infer<typeof diffSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;

export class WorkspaceError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function createWorkspaceClient(
  directory: string,
  fetchRuntime: (path: string, options?: RuntimeFetchOptions) => Promise<Response> = runtimeFetch,
) {
  if (!directory) throw new Error('A selected directory is required');

  async function response(path: string, init: RuntimeFetchOptions = {}) {
    const result = await fetchRuntime(path, {
      ...init, directory, query: { ...init.query, directory },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!result.ok) {
      const body = errorSchema.safeParse(await result.json().catch(() => null)).data;
      throw new WorkspaceError(result.status, body?.code ?? null, body?.error ?? `HTTP ${result.status}`);
    }
    return result;
  }
  async function json<T>(path: string, schema: z.ZodType<T>, init?: RuntimeFetchOptions): Promise<T> {
    return schema.parse(await (await response(path, init)).json());
  }
  const mutation = (method: 'POST' | 'DELETE', body: WorkspaceMutation): RuntimeFetchOptions => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    directory,
    list: (path: string) => json('/api/fs/list', listingSchema, { query: { path } }),
    async read(path: string) {
      const stat = await json('/api/fs/stat', statSchema, { query: { path } });
      if (stat.size > MAX_EDITOR_BYTES) throw new WorkspaceError(413, 'file_too_large', path);
      const text = await (await response('/api/fs/read', { query: { path } })).text();
      if (text.includes('\0') || text.includes('\uFFFD')) throw new WorkspaceError(415, 'binary_file', path);
      return text;
    },
    save: (path: string, content: string) => json('/api/fs/write', successSchema, mutation('POST', { path, content })),
    status: () => json('/api/git/status', statusSchema, { query: { mode: 'light' } }),
    diff: (path: string, staged: boolean) => json('/api/git/file-diff', diffSchema, { query: { path, staged } }),
    stage: (path: string, staged: boolean) => json(`/api/git/${staged ? 'unstage' : 'stage'}`, successSchema, mutation('POST', { path })),
    worktrees: () => json('/api/git/worktrees', z.array(worktreeSchema)),
    projects: () => json('/api/omo/projects', z.array(projectSchema)),
    createWorktree: (branchName: string) => json('/api/git/worktrees', worktreeSchema, mutation('POST', { mode: 'new', branchName })),
    removeWorktree: (path: string) => json('/api/git/worktrees', successSchema, mutation('DELETE', { directory: path, deleteLocalBranch: false })),
  };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
