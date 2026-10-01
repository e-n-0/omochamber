import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

export async function writeJournal(file, entries, fragment = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join('') + fragment);
}

// Formats/fields are drawn from installed Senpi goal persistence, todo-storage,
// OMO task record bw/GG, and DAG checkpoint/event producers. No native stores are used.
export async function createNativeFixture(runtime = {}) {
  const data = JSON.parse(await fs.readFile(new URL('./native-state.json', import.meta.url), 'utf8'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-native-projections-')));
  const cwd = path.join(root, 'home', 'work', 'native-project');
  const sessionPath = path.join(root, 'sessions', 'native-session.jsonl');
  const taskRoot = path.join(root, 'registered-store');
  const goalPath = path.join(path.dirname(sessionPath), 'extensions', 'goal',
    `${encodeURIComponent(data.durableSessionId)}.json`);
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, '{"type":"session","version":3,"id":"native-owner / α"}\n');
  await writeJson(goalPath, data.goal);
  for (const task of data.tasks) await writeJson(path.join(taskRoot, 'tasks', `${task.task_id}.json`), task);
  await writeJson(path.join(taskRoot, 'dag/runs', `${data.dag.runId}.json`), data.dag);
  await writeJournal(path.join(taskRoot, 'dag/events', `${data.dag.runId}.jsonl`), data.journal);
  return {
    root, cwd, sessionPath, taskRoot, goalPath, data,
    options: {
      runtime: { ...runtime, homeDir: path.join(root, 'home'), agentDir: path.join(root, 'agent') },
      sessionPath, cwd, durableSessionId: data.durableSessionId, stores: [taskRoot],
    },
    branch: { entries: data.entries, leafId: 'todo-current' },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** Includes filenames, bytes and modes: creates, repairs, leases and truncation all fail equality. */
export async function treeBytes(root, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      result[name] = {
        link: await fs.readlink(path.join(root, name)),
        mode: (await fs.lstat(path.join(root, name))).mode,
      };
    } else if (entry.isDirectory()) {
      result[`${name}/`] = { mode: (await fs.stat(path.join(root, name))).mode };
      Object.assign(result, await treeBytes(root, name));
    } else {
      result[name] = {
        bytes: (await fs.readFile(path.join(root, name))).toString('base64'),
        mode: (await fs.stat(path.join(root, name))).mode,
      };
    }
  }
  return result;
}

/** A filesystem-event wire, not a module mock. Real files remain the read authority. */
export function createWatchWire() {
  const observers = new Set();
  const operations = [];
  return {
    operations,
    watchDirectory(directory, _options, listener) {
      if (!statSync(directory).isDirectory()) throw new Error('Not a directory');
      operations.push(['watch', directory]);
      const observer = new EventEmitter();
      observer.close = () => observers.delete(observer);
      observer.directory = directory;
      observer.listener = listener;
      observers.add(observer);
      return observer;
    },
    emit(directory, filename = null) {
      for (const observer of [...observers]) {
        if (observer.directory === directory) observer.listener('rename', filename);
      }
    },
    count: () => observers.size,
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
