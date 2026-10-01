import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadNativeReaders, resolveNativeLayout, selectActiveBranch } from './native-layout.js';

const id = z.string().min(1);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.iso.datetime({ offset: true });
const taskStatus = z.enum(['pending', 'running', 'completed', 'error', 'cancelled', 'interrupted', 'lost']);
const nodeStatus = z.enum(['pending', 'blocked', 'scheduled', 'running', 'completed', 'failed', 'cancelled', 'skipped']);
const goalSchema = z.object({
  id, threadId: id, objective: z.string().refine((value) => value.trim().length > 0),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  tokensUsed: counter, timeUsedSeconds: counter, createdAt: counter, updatedAt: counter,
  lastStartedAt: counter.optional(), completedAt: counter.optional(),
  blockedReason: z.string().refine((value) => value.trim().length > 0).optional(), blockedAt: counter.optional(),
  consecutiveContinuations: counter.optional(), unattendedContinuations: counter.optional(),
});
const taskFields = {
  task_id: z.string().regex(/^st_[0-9a-f]{8}$/),
  status: taskStatus,
  residency_state: z.enum(['resident', 'evicted', 'disposed', 'persisted_only', 'rpc_detached']),
  model: z.string(), created_at: time, updated_at: time,
  name: z.string().optional(), task_summary: z.string().optional(),
  description: z.string().optional(), category: z.string().optional(),
  agent_type: z.string().optional(), child_session_id: id.optional(),
  started_at: time.optional(), terminal_at: time.optional(),
  final_response: z.string().optional(), error_message: z.string().optional(),
};
const taskSchema = z.object({
  ...taskFields, parent_session_id: id, root_session_id: id, depth: counter,
  notification: z.object({
    run_epoch: counter, notified_epoch: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    notification_failed_epoch: counter.optional(), liveness_notified_epoch: counter.optional(),
  }),
});
const liveTaskSchema = z.object({
  ...taskFields, parent_session_id: id.optional(), root_session_id: id.optional(),
  depth: counter.optional(), final_response_truncated: z.boolean().optional(),
  error_message_truncated: z.boolean().optional(),
});
const nodeSchema = z.object({
  id, state: nodeStatus, label: z.string().optional(), taskId: id.optional(),
  dependsOn: z.array(id), attempt: counter, createdAt: time,
  startedAt: time.optional(), completedAt: time.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const checkpointSchema = z.object({
  schemaVersion: z.literal(1), checkpointSeq: counter,
  runId: id, parentSessionId: id, rootSessionId: id, runKey: id, name: z.string(),
  generation: counter, status: z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  createdAt: time, updatedAt: time, startedAt: time.optional(), completedAt: time.optional(),
  nodes: z.array(nodeSchema), edges: z.array(z.object({ from: id, to: id })),
  waves: z.array(z.object({ index: counter, nodeIds: z.array(id) })),
});
const journalSchema = z.object({
  schemaVersion: z.literal(1), runId: id, seq: counter,
  type: z.string().startsWith('dag.'), at: time, lane: z.literal('boundary'),
});
const taskEnvelopeSchema = z.object({
  parent_session_id: id, tasks: z.array(z.json()), truncated_tasks: counter.optional(),
});
const taskOwnerSchema = z.object({ parent_session_id: id });
const dagOwnerSchema = z.object({ parentSessionId: id });
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const ready = (value) => ({ status: 'ready', value });
const failed = (status, value, reason) => ({ status, value, reason });

/** Pick public task fields. Native execution/isolation/host/steering metadata never crosses. */
export function projectNativeTask(record, source = 'persisted', parentSessionId) {
  const parsed = (source === 'live' ? liveTaskSchema : taskSchema).parse(record);
  const result = {
    taskId: parsed.task_id, parentSessionId: parsed.parent_session_id ?? parentSessionId,
    status: parsed.status, residency: parsed.residency_state, model: parsed.model,
    createdAt: parsed.created_at, updatedAt: parsed.updated_at, source,
  };
  for (const [native, publicName] of [
    ['root_session_id', 'rootSessionId'], ['depth', 'depth'], ['name', 'name'],
    ['task_summary', 'taskSummary'], ['description', 'description'], ['category', 'category'],
    ['agent_type', 'agent'], ['child_session_id', 'childSessionId'], ['started_at', 'startedAt'],
    ['terminal_at', 'completedAt'], ['final_response', 'output'], ['error_message', 'error'],
  ]) {
    if (parsed[native] !== undefined) result[publicName] = parsed[native];
  }
  if (source === 'persisted') result.notificationEpoch = parsed.notification.run_epoch;
  return result;
}

function projectDag(checkpoint) {
  const nodes = new Set(checkpoint.nodes.map((node) => node.id));
  if (nodes.size !== checkpoint.nodes.length ||
      checkpoint.edges.some((edge) => !nodes.has(edge.from) || !nodes.has(edge.to)) ||
      checkpoint.waves.some((wave) => wave.nodeIds.some((node) => !nodes.has(node)))) {
    throw new Error('DAG topology is inconsistent');
  }
  const counts = Object.fromEntries(nodeStatus.options.map((status) => [status, 0]));
  const waveByNode = new Map(checkpoint.waves.flatMap((wave) => wave.nodeIds.map((node) => [node, wave.index])));
  return {
    runId: checkpoint.runId, name: checkpoint.name, status: checkpoint.status,
    generation: checkpoint.generation, lastSeq: checkpoint.checkpointSeq,
    nodes: checkpoint.nodes.map((node) => {
      counts[node.state] += 1;
      const result = { nodeId: node.id, status: node.state };
      if (node.label !== undefined) result.name = node.label;
      if (node.taskId !== undefined) result.taskId = node.taskId;
      if (waveByNode.has(node.id)) result.wave = waveByNode.get(node.id);
      if (node.error !== undefined) result.error = node.error.message;
      return result;
    }),
    edges: checkpoint.edges, waves: checkpoint.waves.map((wave) => wave.nodeIds), counts,
  };
}

async function readDag(fileSystem, root, filename, raw) {
  const file = path.join(root, 'dag/runs', filename);
  const checkpoint = checkpointSchema.parse(JSON.parse(raw));
  if (`${checkpoint.runId}.json` !== filename) throw new Error('DAG identity is inconsistent');
  async function readJournal() {
    try {
      const text = await fileSystem.readFile(path.join(root, 'dag/events', `${checkpoint.runId}.jsonl`), 'utf8');
      return text.slice(0, text.lastIndexOf('\n') + 1);
    } catch (error) {
      if (!missing(error)) throw error;
      return '';
    }
  }
  const journal = await readJournal();
  let head = 0;
  // A writer may be mid-append. Never parse or repair its non-LF fragment.
  for (const line of journal.split('\n').slice(0, -1)) {
    const event = journalSchema.parse(JSON.parse(line));
    if (event.runId !== checkpoint.runId || event.seq !== head + 1) {
      throw new Error('DAG journal sequence is inconsistent');
    }
    head = event.seq;
  }
  // Read/check/read fences both checkpoint replacement and a complete journal append.
  if (await readJournal() !== journal) throw new Error('DAG journal changed during read');
  if (await fileSystem.readFile(file, 'utf8') !== raw) throw new Error('DAG checkpoint changed during read');
  if (head !== checkpoint.checkpointSeq) {
    throw new Error(head > checkpoint.checkpointSeq ? 'DAG recovery is pending' : 'DAG checkpoint is ahead of journal');
  }
  return checkpoint;
}

/**
 * Read-only owner-scoped projections. start() installs directory watches before
 * inventory reads; subscribe() receives projections, not fabricated native events.
 * Optional subscribeEvents wires the owner's actual native extension stream.
 */
export function createNativeProjectionReader({
  runtime, sessionPath, durableSessionId, cwd, stores,
  fileSystem = fs, watchDirectory = watch, subscribeEvents,
}) {
  let active = false;
  let generation = 0;
  let requested = 0;
  let tail = Promise.resolve();
  let readers;
  let branch = {};
  let unsubscribeEvents;
  let liveTasks = new Map();
  let state = {
    goal: failed('unavailable', null, 'Native goal has not been read'),
    todo: failed('incomplete', null, 'Native branch has not been read'),
    tasks: failed('incomplete', null, 'Native task inventory has not been read'),
    dags: failed('incomplete', null, 'Native DAG inventory has not been read'),
  };
  const listeners = new Set();
  const watches = new Map();
  const taskRecords = new Map();
  const dagRecords = new Map();

  function publish(next) {
    if (JSON.stringify(next) === JSON.stringify(state)) return state;
    state = next;
    for (const listener of listeners) listener(structuredClone(state));
    return state;
  }

  function acceptEvents(events) {
    for (const event of events) {
      if (event.type !== 'extension_event' || event.name !== 'omo.task.updated') continue;
      const envelope = taskEnvelopeSchema.safeParse(event.data);
      if (!envelope.success || envelope.data.parent_session_id !== durableSessionId) continue;
      // Native snapshots are capped. They supplement; omission is never deletion.
      for (const record of envelope.data.tasks) {
        const parsed = liveTaskSchema.safeParse(record);
        if (!parsed.success || (parsed.data.parent_session_id !== undefined &&
            parsed.data.parent_session_id !== durableSessionId)) continue;
        const view = projectNativeTask(parsed.data, 'live', durableSessionId);
        const prior = liveTasks.get(view.taskId) ?? taskRecords.get(view.taskId);
        if (prior && Date.parse(view.updatedAt) < Date.parse(prior.updatedAt)) continue;
        if (parsed.data.final_response_truncated && prior?.output !== undefined) delete view.output;
        if (parsed.data.error_message_truncated && prior?.error !== undefined) delete view.error;
        liveTasks.set(view.taskId, { ...prior, ...view });
      }
    }
  }

  async function ensureWatch(target, epoch) {
    if (!active || epoch !== generation || watches.get(target)?.directory === target) return true;
    let directory = target;
    while (active && epoch === generation) {
      try {
        const observer = watchDirectory(directory, { persistent: false }, (_event, filename) => {
          const child = path.relative(directory, target).split(path.sep)[0];
          if (directory !== target && filename !== null && filename !== undefined &&
              filename.toString() !== child) return;
          if (active && epoch === generation) void schedule();
        });
        observer.on('error', () => {
          if (watches.get(target)?.observer !== observer) return;
          observer.close();
          watches.delete(target);
          if (active && epoch === generation) void schedule();
        });
        const prior = watches.get(target);
        watches.set(target, { directory, observer });
        prior?.observer.close();
        return true;
      } catch (error) {
        if (!missing(error)) return false;
        const parent = path.dirname(directory);
        if (directory === parent) return false;
        directory = parent;
      }
    }
    return false;
  }

  async function inventory(layout, kind, prior, epoch) {
    const records = new Map(prior);
    const seen = new Set();
    let incomplete = layout.status !== 'ready';
    let enumerated = layout.taskRoots.length > 0;
    for (const root of layout.taskRoots) {
      const directory = path.join(root, kind === 'tasks' ? 'tasks' : 'dag/runs');
      const watching = await ensureWatch(directory, epoch);
      if (kind === 'dags' && !await ensureWatch(path.join(root, 'dag/events'), epoch)) incomplete = true;
      if (!watching) incomplete = true;
      let entries;
      try {
        entries = await fileSystem.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!missing(error)) {
          incomplete = true;
          enumerated = false;
        }
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') ||
            (kind === 'tasks' && !/^st_[0-9a-f]{8}\.json$/.test(entry.name))) continue;
        const identity = entry.name.slice(0, -5);
        try {
          const text = await fileSystem.readFile(path.join(directory, entry.name), 'utf8');
          const payload = JSON.parse(text);
          const owner = kind === 'tasks'
            ? taskOwnerSchema.parse(payload).parent_session_id
            : dagOwnerSchema.parse(payload).parentSessionId;
          if (owner !== durableSessionId) continue;
          const raw = kind === 'tasks' ? taskSchema.parse(payload) : await readDag(fileSystem, root, entry.name, text);
          const view = kind === 'tasks' ? projectNativeTask(raw) : projectDag(raw);
          if ((kind === 'tasks' ? view.taskId : view.runId) !== identity) {
            throw new Error('Native entity filename does not match identity');
          }
          if (seen.has(identity) && JSON.stringify(records.get(identity)) !== JSON.stringify(view)) {
            if (prior.has(identity)) records.set(identity, prior.get(identity));
            else records.delete(identity);
            throw new Error('Registered native stores conflict');
          }
          seen.add(identity);
          const old = prior.get(identity);
          if (kind === 'dags' && old &&
              (view.generation < old.generation || view.lastSeq < old.lastSeq)) {
            throw new Error('Native DAG checkpoint is stale');
          }
          records.set(identity, view);
        } catch {
          incomplete = true;
          seen.add(identity);
        }
      }
    }
    if (enumerated && layout.status === 'ready') {
      for (const identity of records.keys()) if (!seen.has(identity)) records.delete(identity);
    }
    if (kind === 'tasks') {
      for (const [identity, view] of liveTasks) {
        const persisted = records.get(identity);
        if (!seen.has(identity) && enumerated && !incomplete) continue;
        if (!persisted || Date.parse(view.updatedAt) >= Date.parse(persisted.updatedAt)) {
          records.set(identity, { ...persisted, ...view });
        }
      }
    }
    const value = [...records.values()];
    return {
      projection: incomplete
        ? failed('incomplete', value.length || prior.size || enumerated ? value : null,
          'Native inventory is partial or unresolved')
        : ready(value),
      records,
    };
  }

  async function refresh(epoch, revision) {
    if (!active || epoch !== generation || revision !== requested) return state;
    let layout;
    try {
      layout = await resolveNativeLayout({
        runtime, sessionPath, durableSessionId, cwd, stores, fileSystem,
      });
      readers ??= await loadNativeReaders(runtime);
    } catch {
      if (!active || epoch !== generation || revision !== requested) return state;
      return publish({
        goal: failed('unavailable', state.goal.value, 'Native goal reader is unavailable'),
        todo: failed('unavailable', state.todo.value, 'Native todo reader is unavailable'),
        tasks: failed('incomplete', state.tasks.value, 'Native layout is unresolved'),
        dags: failed('incomplete', state.dags.value, 'Native layout is unresolved'),
      });
    }
    if (!active || epoch !== generation) return state;
    let goal;
    try {
      if (!await ensureWatch(layout.goalRef.baseDir, epoch)) throw new Error('Goal watch unavailable');
      const record = await readers.readGoalFile(layout.goalRef);
      const value = record === null ? null : goalSchema.parse(record);
      if (value && value.threadId !== durableSessionId) throw new Error('Goal owner does not match');
      goal = ready(value);
    } catch {
      goal = failed('unavailable', state.goal.value, 'Native goal is invalid or unreadable');
    }
    const selected = selectActiveBranch(branch.entries, branch.leafId);
    let todo;
    try {
      if (selected.status !== 'ready') {
        todo = failed('incomplete', state.todo.value, selected.reason);
      } else {
        const value = readers.getLatestTodoStateFromBranchEntries(selected.entries);
        const projected = { version: 2, phases: value.phases };
        if (value.ask !== undefined) projected.ask = value.ask.text;
        todo = ready(projected);
      }
    } catch {
      todo = failed('unavailable', state.todo.value, 'Native todo is unreadable');
    }
    const tasks = await inventory(layout, 'tasks', taskRecords, epoch);
    const dags = await inventory(layout, 'dags', dagRecords, epoch);
    if (!active || epoch !== generation || revision !== requested) return state;
    taskRecords.clear();
    for (const entry of tasks.records) taskRecords.set(...entry);
    dagRecords.clear();
    for (const entry of dags.records) dagRecords.set(...entry);
    return publish({ goal, todo, tasks: tasks.projection, dags: dags.projection });
  }

  function schedule() {
    const epoch = generation;
    const revision = ++requested;
    const result = tail.then(() => refresh(epoch, revision));
    // Keep the serialization chain usable after a caller/listener failure.
    tail = result.catch(() => {});
    return result;
  }

  function start() {
    if (active) return tail.then(() => structuredClone(state));
    active = true;
    generation += 1;
    if (subscribeEvents) {
      const epoch = generation;
      unsubscribeEvents = subscribeEvents((event) => {
        if (!active || epoch !== generation || event.type !== 'extension_event') return;
        if (!['omo.task.updated', 'omo.dag.updated', 'omo.dag.event',
          'omo.dag.activity', 'omo.dag.heartbeat'].includes(event.name)) return;
        acceptEvents([event]);
        void schedule();
      });
    }
    return schedule().then(() => structuredClone(state));
  }

  async function read(input = {}) {
    if (input.entries !== undefined || input.leafId !== undefined) {
      branch = { entries: structuredClone(input.entries), leafId: input.leafId };
    }
    if (input.events) acceptEvents(input.events);
    if (!active) return start();
    return structuredClone(await schedule());
  }

  function stop() {
    active = false;
    generation += 1;
    requested += 1;
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
    for (const { observer } of watches.values()) observer.close();
    watches.clear();
    liveTasks = new Map();
  }

  return {
    start, read, stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
