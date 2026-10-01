import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectionsSchema } from '../../../../ui/src/omo/contracts.ts';
import { resolveInstalledRuntime } from './installed-runtime.js';
import { createNativeProjectionReader } from './projections.js';
import {
  createNativeFixture, createWatchWire, deferred, treeBytes, writeJournal, writeJson,
} from './fixtures/native-state-fixture.js';

let runtime;
const resources = [];
const readers = [];
beforeAll(async () => { runtime = await resolveInstalledRuntime(); });
afterEach(async () => {
  for (const reader of readers.splice(0)) reader.stop();
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function fixture(options = {}) {
  const resource = await createNativeFixture(runtime);
  resources.push(resource);
  const wire = createWatchWire();
  const reader = createNativeProjectionReader({ ...resource.options, watchDirectory: wire.watchDirectory, ...options });
  readers.push(reader);
  return { ...resource, wire, reader };
}

function nextProjection(reader, predicate) {
  return new Promise((resolve, reject) => {
    const unsubscribe = reader.subscribe((state) => {
      if (!predicate(state)) return;
      clearTimeout(deadline);
      unsubscribe();
      resolve(state);
    });
    const deadline = setTimeout(() => {
      unsubscribe();
      reject(new Error('Projection event deadline exceeded'));
    }, 5000);
  });
}

function nextJournalEvent(resource, seq) {
  return { ...resource.data.journal[1], seq, type: 'dag.run.paused' };
}

async function addIndependentDag(resource) {
  const dag = { ...resource.data.dag, runId: 'dag_independent', name: 'Independent run' };
  const journal = resource.data.journal.map((event) => ({ ...event, runId: dag.runId }));
  await writeJson(path.join(resource.taskRoot, 'dag/runs', `${dag.runId}.json`), dag);
  await writeJournal(path.join(resource.taskRoot, 'dag/events', `${dag.runId}.jsonl`), journal);
}

describe('native-authoritative projections', () => {
  it('hydrates late-attached goal/todo/task/DAG state from native files and round-trips the public codec', async () => {
    const resource = await fixture();
    const before = await treeBytes(resource.root);
    const state = await resource.reader.read(resource.branch);
    expect(Object.values(state).map((projection) => projection.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(state.goal.value.objective).toBe(resource.data.goal.goal.objective);
    expect(state.todo.value).toEqual({
      version: 2, phases: resource.data.entries[3].data.phases, ask: 'Complete the fixture work',
    });
    expect(state.tasks.value.map((task) => task.taskId)).toEqual(['st_00000001', 'st_00000002']);
    expect(state.tasks.value[0].source).toBe('persisted');
    expect(state.tasks.value[0].status).toBe('running');
    expect(state.dags.value[0]).toMatchObject({
      runId: 'dag_fixture', generation: 2, lastSeq: 2,
      nodes: [{ nodeId: 'read', status: 'running', wave: 0 }, { nodeId: 'verify', status: 'blocked', wave: 1 }],
      edges: [{ from: 'read', to: 'verify' }], waves: [['read'], ['verify']],
    });
    expect(projectionsSchema.parse(state)).toEqual(state);
    const publicBytes = JSON.stringify(state);
    for (const privateValue of [
      'fixture-private-socket', 'fixture-private-handle', 'fixture-private-base',
      'private steering', 'Private execution prompt', 'leaseHolderPid', 'lastContinuationSignature',
    ]) expect(publicBytes).not.toContain(privateValue);
    resource.reader.stop();
    expect(resource.wire.count()).toBe(0);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('uses the installed todo reducer for malformed, empty and supported legacy payloads', async () => {
    const resource = await fixture();
    const before = await treeBytes(resource.root);
    const valid = await resource.reader.read({ entries: resource.data.entries, leafId: 'todo-malformed' });
    expect(valid.todo.value.phases[0].name).toBe('Current');
    const legacy = await resource.reader.read({ entries: resource.data.entries, leafId: 'todo-legacy' });
    expect(legacy.todo.value.phases[0].tasks.map((task) => task.status)).toEqual(['abandoned', 'pending']);
    const empty = await resource.reader.read({ entries: resource.data.entries, leafId: 'todo-empty' });
    expect(empty.todo).toEqual({ status: 'ready', value: { version: 2, phases: [] } });
    const missing = await resource.reader.read({ entries: resource.data.entries.slice(1), leafId: 'todo-current' });
    expect(missing.todo.status).toBe('incomplete');
    expect(missing.todo.value).toEqual(empty.todo.value);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('hydrates native DAG tasks that have not been notified at epoch zero', async () => {
    const resource = await fixture();
    for (const task of resource.data.tasks) {
      await writeJson(path.join(resource.taskRoot, 'tasks', `${task.task_id}.json`), {
        ...task,
        notification: { ...task.notification, run_epoch: 0, notified_epoch: -1 },
      });
    }
    const before = await treeBytes(resource.root);

    const state = await resource.reader.read(resource.branch);

    expect(state.tasks.status).toBe('ready');
    expect(state.tasks.value.map((task) => task.taskId)).toEqual(['st_00000001', 'st_00000002']);
    expect(state.tasks.value.map((task) => task.notificationEpoch)).toEqual([0, 0]);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('distinguishes missing/null goals from invalid version, owner, blocked fields and counters', async () => {
    const resource = await fixture();
    const good = await resource.reader.read(resource.branch);
    const invalidGoals = [
      { version: 9, goal: resource.data.goal.goal },
      { version: 1, goal: { ...resource.data.goal.goal, tokensUsed: -1 } },
      { version: 1, goal: { ...resource.data.goal.goal, createdAt: Number.MAX_SAFE_INTEGER + 1 } },
      { version: 1, goal: { ...resource.data.goal.goal, status: 'blocked' } },
      { version: 1, goal: { ...resource.data.goal.goal, threadId: 'foreign-owner' } },
    ];
    for (const goal of invalidGoals) {
      await writeJson(resource.goalPath, goal);
      const before = await treeBytes(resource.root);
      const state = await resource.reader.read(resource.branch);
      expect(state.goal.status).toBe('unavailable');
      expect(state.goal.value).toEqual(good.goal.value);
      expect(state.tasks.status).toBe('ready');
      expect(await treeBytes(resource.root)).toEqual(before);
    }
    await writeJson(resource.goalPath, {
      version: 1, goal: { ...resource.data.goal.goal, status: 'blocked', blockedReason: 'Needs input', blockedAt: 1790812810 },
    });
    expect((await resource.reader.read()).goal.value.status).toBe('blocked');
    await writeJson(resource.goalPath, { version: 1, goal: null });
    expect((await resource.reader.read()).goal).toEqual({ status: 'ready', value: null });
    await fs.rm(resource.goalPath);
    expect((await resource.reader.read()).goal).toEqual({ status: 'ready', value: null });
  });

  it('preserves each unreadable task while updating its valid siblings and excluding temp/tombstone files', async () => {
    const resource = await fixture();
    const good = await resource.reader.read(resource.branch);
    await fs.writeFile(path.join(resource.taskRoot, 'tasks/st_00000001.json'), '{"partial":');
    const updated = { ...resource.data.tasks[1], final_response: 'New native output', updated_at: '2026-10-01T00:00:04.000Z' };
    await writeJson(path.join(resource.taskRoot, 'tasks/st_00000002.json'), updated);
    await fs.writeFile(path.join(resource.taskRoot, 'tasks/st_00000004.json.tmp'), '{');
    await fs.writeFile(path.join(resource.taskRoot, 'tasks/.expunging-st_00000005.json'), '{');
    await writeJson(path.join(resource.taskRoot, 'tasks/st_00000006.json'), { ...updated, task_id: 'st_00000007' });
    const before = await treeBytes(resource.root);
    const state = await resource.reader.read();
    expect(state.tasks.status).toBe('incomplete');
    expect(state.tasks.value.find((task) => task.taskId === 'st_00000001')).toEqual(good.tasks.value[0]);
    expect(state.tasks.value.find((task) => task.taskId === 'st_00000002').output).toBe('New native output');
    expect(state.tasks.value).toHaveLength(2);
    expect(state.dags.status).toBe('ready');
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('filters foreign owners before inspecting unrelated malformed task/DAG content', async () => {
    const resource = await fixture();
    await writeJson(path.join(resource.taskRoot, 'tasks/st_00000003.json'), {
      parent_session_id: `${resource.data.durableSessionId}-foreign`, invalid: true,
    });
    await writeJson(path.join(resource.taskRoot, 'dag/runs/dag_foreign.json'), {
      parentSessionId: `${resource.data.durableSessionId}-foreign`, invalid: true,
    });
    const state = await resource.reader.read(resource.branch);
    expect(state.tasks.status).toBe('ready');
    expect(state.tasks.value).toHaveLength(2);
    expect(state.dags.status).toBe('ready');
    expect(state.dags.value).toHaveLength(1);
  });

  it('supplements persisted tasks with exact-owner live snapshots without deleting capped omissions', async () => {
    const resource = await fixture();
    const bus = new EventEmitter();
    const reader = createNativeProjectionReader({
      ...resource.options, watchDirectory: resource.wire.watchDirectory,
      subscribeEvents(listener) {
        bus.on('native', listener);
        return () => bus.off('native', listener);
      },
    });
    readers.push(reader);
    await reader.read(resource.branch);
    const delivered = nextProjection(reader, (state) => state.tasks.value[0].source === 'live');
    bus.emit('native', {
      type: 'extension_event', name: 'omo.task.updated',
      data: {
        parent_session_id: resource.data.durableSessionId, truncated_tasks: 256,
        tasks: [{ ...resource.data.tasks[0], status: 'completed', updated_at: '2026-10-01T00:00:05.000Z', final_response: 'Live native result' }],
      },
    });
    const state = await delivered;
    expect(state.tasks.value).toHaveLength(2);
    expect(state.tasks.value[0]).toMatchObject({ source: 'live', status: 'completed', output: 'Live native result' });
    const foreign = await reader.read({
      events: [{
        type: 'extension_event', name: 'omo.task.updated',
        data: { parent_session_id: 'foreign', tasks: [resource.data.tasks[0]] },
      }],
    });
    expect(foreign.tasks).toEqual(state.tasks);
    const truncatedDag = await reader.read({
      events: [{
        type: 'extension_event', name: 'omo.dag.updated',
        data: { parent_session_id: resource.data.durableSessionId, runs: [], truncated_runs: 256 },
      }],
    });
    expect(truncatedDag.dags.value).toHaveLength(1);
    reader.stop();
    expect(bus.listenerCount('native')).toBe(0);
  });

  it('preserves valid DAG runs independently across journal lag, gaps, corruption and trailing fragments', async () => {
    const resource = await fixture();
    await addIndependentDag(resource);
    const good = await resource.reader.read(resource.branch);
    const journalPath = path.join(resource.taskRoot, 'dag/events/dag_fixture.jsonl');
    const failures = [
      [resource.data.journal[0]],
      [...resource.data.journal, nextJournalEvent(resource, 3)],
      [resource.data.journal[0], nextJournalEvent(resource, 4)],
      [resource.data.journal[0], { ...resource.data.journal[1], schemaVersion: 9 }],
      [resource.data.journal[0], { ...resource.data.journal[1], runId: 'foreign-run' }],
    ];
    for (const journal of failures) {
      await writeJournal(journalPath, journal);
      const before = await treeBytes(resource.root);
      const state = await resource.reader.read();
      expect(state.dags.status).toBe('incomplete');
      expect(state.dags.value).toEqual(good.dags.value);
      expect(await treeBytes(resource.root)).toEqual(before);
    }
    await writeJournal(journalPath, resource.data.journal, '{"schemaVersion":1,"seq":3');
    const before = await treeBytes(resource.root);
    expect((await resource.reader.read()).dags.status).toBe('ready');
    expect(await treeBytes(resource.root)).toEqual(before);
    await fs.writeFile(journalPath, `${JSON.stringify(resource.data.journal[0])}\nmalformed\n`);
    const malformed = await treeBytes(resource.root);
    expect((await resource.reader.read()).dags.status).toBe('incomplete');
    expect(await treeBytes(resource.root)).toEqual(malformed);
  });

  it('rejects stale DAG checkpoint generations and advances only to covered native checkpoints', async () => {
    const resource = await fixture();
    const good = await resource.reader.read(resource.branch);
    const checkpointPath = path.join(resource.taskRoot, 'dag/runs/dag_fixture.json');
    await writeJson(checkpointPath, { ...resource.data.dag, generation: 1 });
    const stale = await resource.reader.read();
    expect(stale.dags.status).toBe('incomplete');
    expect(stale.dags.value).toEqual(good.dags.value);
    await writeJson(checkpointPath, { ...resource.data.dag, generation: 3, checkpointSeq: 3, status: 'paused' });
    const ahead = await resource.reader.read();
    expect(ahead.dags.status).toBe('incomplete');
    expect(ahead.dags.value).toEqual(good.dags.value);
    await writeJournal(path.join(resource.taskRoot, 'dag/events/dag_fixture.jsonl'), [
      ...resource.data.journal, nextJournalEvent(resource, 3),
    ]);
    expect((await resource.reader.read()).dags.value[0]).toMatchObject({ generation: 3, lastSeq: 3, status: 'paused' });
  });

  it('does not let missing pure readers erase independently readable native task/DAG inventories', async () => {
    const resource = await fixture();
    const reader = createNativeProjectionReader({
      ...resource.options,
      runtime: { ...resource.options.runtime, engineRoot: path.join(resource.root, 'missing-engine') },
      watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    const state = await reader.read(resource.branch);
    expect(state.goal).toMatchObject({ status: 'unavailable', value: null });
    expect(state.todo).toMatchObject({ status: 'unavailable', value: null });
    expect(state.tasks.status).toBe('ready');
    expect(state.tasks.value).toHaveLength(2);
    expect(state.dags.status).toBe('ready');
  });

  it('preserves known conflicting identities across registered stores while retaining independent tasks', async () => {
    const resource = await fixture();
    const otherRoot = path.join(resource.root, 'second-registered-store');
    const reader = createNativeProjectionReader({
      ...resource.options, stores: [resource.taskRoot, otherRoot],
      watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    const good = await reader.read(resource.branch);
    await writeJson(path.join(otherRoot, 'tasks/st_00000001.json'), {
      ...resource.data.tasks[0], model: 'conflicting/model',
    });
    const before = await treeBytes(resource.root);
    const partial = await reader.read();
    expect(partial.tasks.status).toBe('incomplete');
    expect(partial.tasks.value).toEqual(good.tasks.value);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('distinguishes directory read failure from complete native empty inventories', async () => {
    const resource = await fixture();
    let fail = false;
    const fileSystem = {
      ...fs,
      readdir(directory, options) {
        if (fail && directory.endsWith('/tasks')) {
          return Promise.reject(Object.assign(new Error('fixture unreadable'), { code: 'EACCES' }));
        }
        return fs.readdir(directory, options);
      },
    };
    const reader = createNativeProjectionReader({
      ...resource.options, fileSystem, watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    const good = await reader.read(resource.branch);
    fail = true;
    const unreadable = await reader.read();
    expect(unreadable.tasks.status).toBe('incomplete');
    expect(unreadable.tasks.value).toEqual(good.tasks.value);
    fail = false;
    await fs.rm(path.join(resource.taskRoot, 'tasks'), { recursive: true });
    expect((await reader.read()).tasks).toEqual({ status: 'ready', value: [] });
  });
});

describe('projection observation and generations', () => {
  it('rejects a journal append that races a checkpoint read without repairing either file', async () => {
    const resource = await fixture();
    const entered = deferred();
    const release = deferred();
    let hold = false;
    const journalPath = path.join(resource.taskRoot, 'dag/events/dag_fixture.jsonl');
    const fileSystem = {
      ...fs,
      async readFile(file, encoding) {
        const bytes = await fs.readFile(file, encoding);
        if (hold && file === journalPath) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return bytes;
      },
    };
    const reader = createNativeProjectionReader({
      ...resource.options, fileSystem, watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    const good = await reader.read(resource.branch);
    hold = true;
    const pending = reader.read();
    await entered.promise;
    await writeJournal(journalPath, [...resource.data.journal, nextJournalEvent(resource, 3)]);
    const before = await treeBytes(resource.root);
    release.resolve();
    const partial = await pending;
    expect(partial.dags.status).toBe('incomplete');
    expect(partial.dags.value).toEqual(good.dags.value);
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('registers directory watches before each native inventory enumeration', async () => {
    const resource = await fixture();
    const operations = resource.wire.operations;
    const fileSystem = {
      ...fs,
      async readdir(directory, options) {
        operations.push(['readdir', directory]);
        return fs.readdir(directory, options);
      },
    };
    const reader = createNativeProjectionReader({
      ...resource.options, fileSystem, watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    await reader.read(resource.branch);
    for (const directory of [path.join(resource.taskRoot, 'tasks'), path.join(resource.taskRoot, 'dag/runs')]) {
      expect(operations.findIndex(([op, dir]) => op === 'watch' && dir === directory))
        .toBeLessThan(operations.findIndex(([op, dir]) => op === 'readdir' && dir === directory));
    }
    const dagEnumeration = operations.findIndex(([op, dir]) => op === 'readdir' && dir.endsWith('dag/runs'));
    expect(operations.findIndex(([op, dir]) => op === 'watch' && dir.endsWith('dag/events'))).toBeLessThan(dagEnumeration);
    reader.stop();
    expect(resource.wire.count()).toBe(0);
  });

  it('observes actual atomic goal replacement through the containing directory watch', async () => {
    const resource = await fixture();
    const reader = createNativeProjectionReader(resource.options);
    readers.push(reader);
    await reader.read(resource.branch);
    const event = nextProjection(reader, (state) => state.goal.value?.status === 'paused');
    const temporary = path.join(path.dirname(resource.goalPath), '.goal-replacement.tmp');
    await writeJson(temporary, { version: 1, goal: { ...resource.data.goal.goal, status: 'paused' } });
    await fs.rename(temporary, resource.goalPath);
    expect((await event).goal.value.status).toBe('paused');
    reader.stop();
    const before = await treeBytes(resource.root);
    await reader.read(resource.branch);
    reader.stop();
    expect(await treeBytes(resource.root)).toEqual(before);
  });

  it('watches ancestors before absent store enumeration and promotes watches after creation', async () => {
    const resource = await fixture();
    const taskRoot = path.join(resource.root, 'not-created');
    const reader = createNativeProjectionReader({
      ...resource.options, stores: [taskRoot], watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    const before = await treeBytes(resource.root);
    const empty = await reader.read(resource.branch);
    expect(empty.tasks).toEqual({ status: 'ready', value: [] });
    expect(empty.dags).toEqual({ status: 'ready', value: [] });
    expect(await treeBytes(resource.root)).toEqual(before);
    const delivered = nextProjection(reader, (state) => state.tasks.value?.length === 1);
    await writeJson(path.join(taskRoot, 'tasks/st_00000001.json'), resource.data.tasks[0]);
    resource.wire.emit(resource.root, 'not-created');
    expect((await delivered).tasks.value[0].taskId).toBe('st_00000001');
    expect(resource.wire.operations).toContainEqual(['watch', path.join(taskRoot, 'tasks')]);
  });

  it('serializes overlapping reads and prevents an obsolete refresh from publishing', async () => {
    const resource = await fixture();
    const entered = deferred();
    const release = deferred();
    let hold = false;
    let held = false;
    let inFlight = 0;
    let maximum = 0;
    const taskPath = path.join(resource.taskRoot, 'tasks/st_00000001.json');
    const fileSystem = {
      ...fs,
      async readFile(file, encoding) {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        try {
          const bytes = await fs.readFile(file, encoding);
          if (hold && !held && file === taskPath) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return bytes;
        } finally {
          inFlight -= 1;
        }
      },
    };
    const reader = createNativeProjectionReader({
      ...resource.options, fileSystem, watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    await reader.read(resource.branch);
    const publications = [];
    reader.subscribe((state) => publications.push(state));
    hold = true;
    const old = reader.read({ entries: resource.data.entries, leafId: 'todo-old-branch' });
    await entered.promise;
    await writeJson(taskPath, { ...resource.data.tasks[0], status: 'completed', updated_at: '2026-10-01T00:00:06.000Z' });
    const latest = reader.read({ entries: resource.data.entries, leafId: 'todo-empty' });
    release.resolve();
    await old;
    const state = await latest;
    expect(maximum).toBe(1);
    expect(publications).toHaveLength(1);
    expect(state.todo.value.phases).toEqual([]);
    expect(state.tasks.value[0].status).toBe('completed');
    expect(publications[0]).toEqual(state);
  });

  it('rejects pending reads and native callbacks after stop without reopening watchers', async () => {
    const resource = await fixture();
    const entered = deferred();
    const release = deferred();
    let hold = false;
    const fileSystem = {
      ...fs,
      async readFile(file, encoding) {
        const bytes = await fs.readFile(file, encoding);
        if (hold && file.endsWith('st_00000001.json')) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return bytes;
      },
    };
    const reader = createNativeProjectionReader({
      ...resource.options, fileSystem, watchDirectory: resource.wire.watchDirectory,
    });
    readers.push(reader);
    await reader.read(resource.branch);
    const publications = [];
    reader.subscribe((state) => publications.push(state));
    hold = true;
    const pending = reader.read();
    await entered.promise;
    reader.stop();
    release.resolve();
    await pending;
    expect(publications).toEqual([]);
    expect(resource.wire.count()).toBe(0);
  });
});
