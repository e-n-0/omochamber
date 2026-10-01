import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { z } from 'zod';

const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const stateDirectory = z.string().min(1);
const taskConfig = z.object({ task: z.object({ state_dir: stateDirectory.optional() }).optional() });
const harnessConfig = taskConfig.extend({
  '[native]': taskConfig.optional(),
  '[senpi]': taskConfig.optional(),
});
const configSchema = harnessConfig.extend({
  profiles: z.record(z.string(), harnessConfig).optional(),
});
const branchEntries = z.array(z.looseObject({
  id: z.string().min(1), parentId: z.string().min(1).nullable(), type: z.string(),
}));

async function canonicalPath(filePath, fileSystem) {
  if (!path.isAbsolute(filePath)) throw new Error('Native paths must be absolute');
  try {
    return await fileSystem.realpath(filePath);
  } catch (error) {
    if (!missing(error)) throw error;
    return path.join(await fileSystem.realpath(path.dirname(filePath)), path.basename(filePath));
  }
}

/** Load only the installed engine's pure readers, never task/DAG store constructors. */
export async function loadNativeReaders(runtime) {
  const builtin = path.join(runtime.engineRoot, 'dist/core/extensions/builtin');
  const [goal, todo] = await Promise.allSettled([
    import(pathToFileURL(path.join(builtin, 'goal/persistence.js')).href),
    import(pathToFileURL(path.join(builtin, 'todotools/todo-storage.js')).href),
  ]);
  return {
    readGoalFile: goal.status === 'fulfilled' ? goal.value.readGoalFile : undefined,
    getLatestTodoStateFromBranchEntries: todo.status === 'fulfilled'
      ? todo.value.getLatestTodoStateFromBranchEntries : undefined,
  };
}

/** Native project bucket identity uses realpath, not the server's working directory. */
export async function nativeProjectKey(cwd, fileSystem = fs) {
  const canonical = await canonicalPath(cwd, fileSystem);
  const name = path.basename(canonical).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'root';
  return `${name}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

async function readConfig(directory, project, fileSystem) {
  if (project) {
    try {
      if ((await fileSystem.lstat(path.join(directory, '.omo'))).isSymbolicLink()) return null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  const configDir = project ? path.join(directory, '.omo') : directory;
  for (const name of ['omo.jsonc', 'omo.json']) {
    const file = path.join(configDir, name);
    try {
      if (project && (await fileSystem.lstat(file)).isSymbolicLink()) continue;
      const errors = [];
      const value = parse(await fileSystem.readFile(file, 'utf8'), errors, { allowTrailingComma: true });
      const parsed = configSchema.safeParse(value);
      if (errors.length || !parsed.success) {
        throw new Error('Native configuration is invalid');
      }
      return parsed.data;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return null;
}

// Only state_dir is consumed. Native precedence is user, farthest project to nearest,
// base, legacy [native], [senpi], then the same layers in the activated profile.
async function configuredTaskRoot(runtime, cwd, fileSystem) {
  if (runtime.taskStateDir !== undefined) return stateDirectory.parse(runtime.taskStateDir);
  const home = runtime.homeDir ?? homedir();
  const layers = [];
  let directory = cwd;
  for (let depth = 0; depth < 256; depth += 1) {
    if (directory === home) break;
    const config = await readConfig(directory, true, fileSystem);
    if (config) layers.unshift(config);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const user = await readConfig(path.join(home, '.omo'), false, fileSystem);
  if (user) layers.unshift(user);
  let base;
  let legacy;
  let harness;
  let profileBase;
  let profileLegacy;
  let profileHarness;
  for (const config of layers) {
    const profile = runtime.profile === undefined ? undefined : config.profiles?.[runtime.profile];
    if (runtime.profile === undefined && config.profiles &&
        Object.values(config.profiles).some((value) => [
          value?.task, value?.['[native]']?.task, value?.['[senpi]']?.task,
        ].some((task) => task?.state_dir !== undefined))) {
      throw new Error('Native configuration profile is unresolved');
    }
    base = config.task?.state_dir ?? base;
    legacy = config['[native]']?.task?.state_dir ?? legacy;
    harness = config['[senpi]']?.task?.state_dir ?? harness;
    profileBase = profile?.task?.state_dir ?? profileBase;
    profileLegacy = profile?.['[native]']?.task?.state_dir ?? profileLegacy;
    profileHarness = profile?.['[senpi]']?.task?.state_dir ?? profileHarness;
  }
  return profileHarness ?? profileLegacy ?? profileBase ?? harness ?? legacy ?? base;
}

/**
 * Server-private paths. Registered shard stores win over current configuration.
 * Relative configured paths require the owning launch cwd explicitly; no web cwd fallback.
 */
export async function resolveNativeLayout({
  runtime, sessionPath, durableSessionId, cwd, stores = [], fileSystem = fs,
}) {
  const canonicalSession = await canonicalPath(sessionPath, fileSystem);
  const goalRef = {
    baseDir: path.join(path.dirname(canonicalSession), 'extensions', 'goal'),
    threadId: durableSessionId,
  };
  const layout = {
    sessionPath: canonicalSession,
    goalRef,
    goalPath: path.join(goalRef.baseDir, `${encodeURIComponent(durableSessionId)}.json`),
    taskRoots: [],
    status: 'ready',
  };
  try {
    const registered = z.array(stateDirectory).safeParse(stores);
    if (!registered.success) throw new Error('Native registered stores are invalid');
    if (registered.data.length) {
      for (const root of registered.data) {
        if (!path.isAbsolute(root)) {
          throw new Error('Native registered stores must be absolute');
        }
        // A registered root may not have been created yet. Keep its absolute identity
        // so an ancestor watch can observe its first publication without creating it.
        let canonical = path.normalize(root);
        try {
          canonical = await fileSystem.realpath(root);
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (!layout.taskRoots.includes(canonical)) layout.taskRoots.push(canonical);
      }
      return layout;
    }
    const project = await canonicalPath(cwd, fileSystem);
    const configured = await configuredTaskRoot(runtime, project, fileSystem);
    if (configured !== undefined) {
      if (!configured.trim()) {
        throw new Error('Native task state directory is invalid');
      }
      if (!path.isAbsolute(configured) && !path.isAbsolute(runtime.launchCwd ?? '')) {
        throw new Error('Native relative task root has no owning launch directory');
      }
      layout.taskRoots = [path.resolve(runtime.launchCwd ?? project, configured)];
      return layout;
    }
    const local = path.join(project, '.omo', 'senpi-task');
    try {
      await fileSystem.stat(local);
      layout.taskRoots = [local];
    } catch (error) {
      if (!missing(error)) throw error;
      if (!path.isAbsolute(runtime.agentDir)) throw new Error('Native agent directory is unresolved');
      layout.taskRoots = [path.join(runtime.agentDir, 'projects',
        await nativeProjectKey(project, fileSystem), 'senpi-task')];
    }
  } catch (error) {
    layout.status = 'incomplete';
    layout.reason = error.message;
  }
  return layout;
}

/** get_entries is append-order inventory; todo authority is only the active ancestry. */
export function selectActiveBranch(entries, leafId) {
  const parsedEntries = branchEntries.safeParse(entries);
  const parsedLeaf = z.string().min(1).nullable().safeParse(leafId);
  if (!parsedEntries.success || !parsedLeaf.success) {
    return { status: 'incomplete', reason: 'Native branch is unavailable' };
  }
  if (leafId === null) {
    return parsedEntries.data.length === 0
      ? { status: 'ready', entries: [] }
      : { status: 'incomplete', reason: 'Native branch leaf is inconsistent' };
  }
  const byId = new Map();
  for (const entry of parsedEntries.data) {
    if (byId.has(entry.id)) {
      return { status: 'incomplete', reason: 'Native branch entry identities are invalid' };
    }
    byId.set(entry.id, entry);
  }
  const active = [];
  const visited = new Set();
  let cursor = leafId;
  while (cursor !== null) {
    const entry = byId.get(cursor);
    if (!entry || visited.has(cursor)) {
      return { status: 'incomplete', reason: 'Native branch ancestry is incomplete' };
    }
    visited.add(cursor);
    active.push(entry);
    cursor = entry.parentId;
  }
  return { status: 'ready', entries: active.reverse() };
}
