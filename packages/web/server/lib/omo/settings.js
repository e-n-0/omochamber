import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const absolutePath = z.string().min(1).refine(path.isAbsolute, 'An absolute path is required');
const name = z.string().trim().min(1).max(1_000);
const preferences = z.object({
  theme: z.string().trim().min(1).max(100).optional(),
  fontSize: z.number().positive().max(100).optional(),
  fontFamily: z.string().trim().min(1).max(200).optional(),
  layout: z.enum(['comfortable', 'compact']).optional(),
  runtime: z.object({
    omoBinary: absolutePath.optional(), bunBinary: absolutePath.optional(), agentDir: absolutePath.optional(),
  }).strict().optional(),
}).strict();
const project = z.object({
  id: z.string().uuid(), path: absolutePath, name,
  worktreePaths: z.array(absolutePath).max(1_000).optional(),
}).strict();
const document = z.object({
  schemaVersion: z.literal(1), settings: preferences, projects: z.array(project).max(1_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.projects.map((item) => item.id)).size !== value.projects.length
      || new Set(value.projects.map((item) => item.path)).size !== value.projects.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate native projects' });
  }
});
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), {
  statusCode, code: statusCode === 404 ? 'project_not_found' : 'invalid_settings',
});
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid('Invalid native settings');
  return result.data;
};

async function canonicalDirectory(value) {
  const directory = parse(absolutePath, value);
  const canonical = await fs.realpath(directory);
  if (!(await fs.stat(canonical)).isDirectory()) throw invalid('Project path must be a directory');
  return canonical;
}

/** App-owned persistence only. Failed reads never become an empty replacement. */
export function createNativeSettings({ dataDir }) {
  const directory = parse(absolutePath, dataDir);
  const filename = path.join(directory, 'settings.json');
  let mutations = Promise.resolve();
  async function read() {
    let contents;
    try { contents = await fs.readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, settings: {}, projects: [] };
      throw error;
    }
    return parse(document, JSON.parse(contents));
  }
  function mutate(change) {
    const operation = mutations.then(async () => {
      const value = await read();
      const result = await change(value);
      const validated = parse(document, value);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temporary, filename);
      } finally {
        await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      return structuredClone(result);
    });
    mutations = operation.catch(() => {});
    return operation;
  }
  async function current() { await mutations; return read(); }
  return {
    async get() { return { schemaVersion: 1, ...(await current()).settings }; },
    update(input) {
      const patch = parse(preferences, input);
      return mutate((value) => {
        value.settings = { ...value.settings, ...patch };
        return { schemaVersion: 1, ...value.settings };
      });
    },
    async listProjects() { return (await current()).projects; },
    addProject(input) {
      const patch = parse(z.object({ path: absolutePath, name: name.optional() }).strict(), input);
      return mutate(async (value) => {
        const canonical = await canonicalDirectory(patch.path);
        if (value.projects.some((item) => item.path === canonical)) throw invalid('Project is already registered', 409);
        const added = { id: randomUUID(), path: canonical, name: patch.name ?? path.basename(canonical) };
        value.projects.push(added);
        return added;
      });
    },
    updateProject(id, input) {
      const patch = parse(project.omit({ id: true }).partial(), input);
      return mutate(async (value) => {
        const existing = value.projects.find((item) => item.id === id);
        if (!existing) throw invalid('Project was not found', 404);
        if (patch.path) patch.path = await canonicalDirectory(patch.path);
        if (patch.worktreePaths) patch.worktreePaths = await Promise.all(patch.worktreePaths.map(canonicalDirectory));
        if (value.projects.some((item) => item.id !== id && item.path === patch.path)) throw invalid('Project is already registered', 409);
        Object.assign(existing, patch);
        return existing;
      });
    },
    removeProject(id) {
      return mutate((value) => {
        const index = value.projects.findIndex((item) => item.id === id);
        if (index < 0) throw invalid('Project was not found', 404);
        value.projects.splice(index, 1);
        return { removed: true };
      });
    },
  };
}
