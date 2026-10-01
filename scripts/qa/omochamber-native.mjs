#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHostClient } from '../../packages/web/server/lib/omo/host-client.js';
import { resolveInstalledRuntime } from '../../packages/web/server/lib/omo/installed-runtime.js';
import { registerOmoRoutes } from '../../packages/web/server/lib/omo/routes.js';
import { createUiAuth } from '../../packages/web/server/lib/ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../../packages/web/server/lib/security/request-security.js';
import { createFoundationFixture, nextSessionEvent, instant } from '../../packages/web/server/lib/omo/session-service.fixtures.js';

const require = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const express = require('express');
const repository = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'foundation' },
    'evidence-dir': { type: 'string', default: '.tmp/omochamber-evidence/foundation/native-http' },
    port: { type: 'string', default: '0' },
    'omo-binary': { type: 'string' }, 'bun-binary': { type: 'string' }, 'agent-dir': { type: 'string' },
  },
});
const scenario = values.scenario;
assert(['foundation', 'security', 'late-attach', 'reconnect', 'handshake'].includes(scenario),
  'Supported foundation scenarios: foundation, security, late-attach, reconnect, handshake');
const port = Number(values.port);
assert(Number.isSafeInteger(port) && port >= 0 && port <= 65_535, 'Invalid QA port');
const evidenceDir = path.resolve(repository, values['evidence-dir']);
await mkdir(evidenceDir, { recursive: true });
const evidence = {
  scenario, argv: process.argv.slice(2), mode: scenario === 'handshake' ? 'isolated-native-handshake' : 'wire-foundation',
  startedAt: new Date().toISOString(), checks: [], resources: [], cleanup: [], sourceDigests: {},
};
for (const file of [
  'packages/web/server/lib/omo/session-service.js', 'packages/web/server/lib/omo/routes.js',
  'packages/web/server/lib/omo/session-service.fixtures.js', 'scripts/qa/omochamber-native.mjs',
]) evidence.sourceDigests[file] = createHash('sha256').update(await readFile(path.join(repository, file))).digest('hex');
const check = (name) => evidence.checks.push({ name, status: 'PASS' });
let fixture;
let httpServer;
let auth;
let nativeProcess;
let nativeClient;
let handshakeRoot;
let shutdownError;

async function submission(snapshot, command, requestId) {
  const result = nextSessionEvent(fixture.service, snapshot.sessionKey,
    (event) => event.type === 'commandResult' && event.result.requestId === requestId);
  await fixture.service.execute(snapshot.sessionKey, {
    requestId, connectionEpoch: snapshot.connectionEpoch, command,
  });
  return (await result).result;
}
async function securityScenario(snapshot) {
  const app = express();
  auth = createUiAuth({
    password: 'isolated-foundation-password',
    clientAuthController: {
      authenticateBearerToken: async (token) => token === 'isolated-fixture-token' ? { ok: true, clientId: 'qa' } : null,
    },
  });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  app.use(express.json());
  app.use('/api', (req, res, next) => auth.requireAuth(req, res, next));
  app.use('/api', async (req, res, next) => {
    if (req.headers.origin && !await security.isRequestOriginAllowed(req)) return res.status(403).json({ code: 'origin_forbidden' });
    next();
  });
  registerOmoRoutes(app, {
    service: fixture.service,
    settings: { listProjects: async () => [{ id: 'qa', path: fixture.project, name: 'QA' }], get: async () => ({ schemaVersion: 1 }) },
  });
  httpServer = app.listen(port, '127.0.0.1');
  await once(httpServer, 'listening');
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  evidence.resources.push({ kind: 'http-listener', address: base, owned: true });
  const request = (url, options = {}) => fetch(base + url, {
    ...options, headers: { Authorization: 'Bearer isolated-fixture-token', 'Content-Type': 'application/json', Origin: base, ...options.headers },
  });
  assert.equal((await fetch(base + '/api/omo/status')).status, 401);
  assert.equal((await request('/api/omo/status', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const status = await request('/api/omo/status');
  assert.equal(status.status, 200);
  const publicStatus = await status.json();
  assert.equal(publicStatus.protocolVersion, 1);
  evidence.status = publicStatus;
  const commandUrl = `/api/omo/sessions/${snapshot.sessionKey}/commands`;
  assert.equal((await request(commandUrl, {
    method: 'POST', body: JSON.stringify({ requestId: 'bad', connectionEpoch: snapshot.connectionEpoch, command: { type: 'goalComplete' } }),
  })).status, 400);
  assert.equal((await request(commandUrl, {
    method: 'POST', body: JSON.stringify({ requestId: 'old', connectionEpoch: snapshot.connectionEpoch - 1, command: { type: 'abort' } }),
  })).status, 409);
  const body = await request(`/api/omo/sessions/${snapshot.sessionKey}/snapshot`).then((response) => response.text());
  for (const privateValue of [fixture.sessionPath, fixture.socketPath, fixture.store, 'SECRET', 'routing-parent']) assert(!body.includes(privateValue));
  check('Authenticated status, foreign origin, malformed command, obsolete epoch, DTO privacy');
}
async function lateAttachScenario() {
  await fixture.setGoal(fixture.goal());
  fixture.history.entries.push({
    type: 'custom', id: 'todo', parentId: 'b', timestamp: instant, customType: 'senpi.todo-state',
    data: { version: 2, phases: [{ name: 'Foundation', tasks: [{ content: 'Native task', status: 'in_progress' }] }] },
  });
  fixture.history.leafId = 'todo';
  await fixture.persistHistory();
  const nodes = [
    { id: 'first', state: 'completed', dependsOn: [], attempt: 1, createdAt: instant },
    { id: 'second', state: 'pending', dependsOn: ['first'], attempt: 0, createdAt: instant },
  ];
  const dag = {
    schemaVersion: 1, checkpointSeq: 0, runId: 'qa-dag', parentSessionId: 'durable-parent',
    rootSessionId: 'durable-parent', runKey: 'qa', name: 'QA DAG', generation: 0, status: 'running',
    createdAt: instant, updatedAt: instant, nodes, edges: [{ from: 'first', to: 'second' }],
    waves: [{ index: 0, nodeIds: ['first'] }, { index: 1, nodeIds: ['second'] }],
  };
  await writeFile(path.join(fixture.store, 'dag/runs/qa-dag.json'), JSON.stringify(dag));
  await writeFile(path.join(fixture.store, 'dag/events/qa-dag.jsonl'), '');
  const snapshot = await fixture.attach();
  assert.equal(snapshot.goal.value.objective, 'Foundation goal');
  assert.equal(snapshot.todo.value.phases[0].tasks[0].status, 'in_progress');
  assert.equal(snapshot.tasks.value[0].taskId, fixture.task.task_id);
  assert.equal(snapshot.dags.value[0].nodes.length, 2);
  assert.deepEqual(snapshot.activeBranch.entries.map((entry) => entry.id), ['a', 'b', 'todo']);
  evidence.snapshot = snapshot;
  check('Initial active-branch, goal, todo, task and two-node DAG projections');
  return snapshot;
}
async function reconnectScenario(snapshot) {
  fixture.override = ({ socket, frame }) => {
    if (frame.type !== 'prompt') return false;
    socket.destroy();
    return true;
  };
  assert.equal((await submission(snapshot, { type: 'prompt', text: 'Wire fixture only' }, 'uncertain')).code, 'uncertain');
  fixture.override = undefined;
  const reattached = await fixture.service.attachSession(snapshot.sessionKey);
  assert.notEqual(reattached.connectionEpoch, snapshot.connectionEpoch);
  await assert.rejects(fixture.service.execute(snapshot.sessionKey, {
    requestId: 'uncertain', connectionEpoch: reattached.connectionEpoch, command: { type: 'prompt', text: 'Never replay' },
  }), { code: 'duplicate_request' });
  assert.equal(fixture.frames.filter((frame) => frame.type === 'prompt').length, 1);
  check('Retained reconnect, epoch change, uncertain outcome and no mutation replay');
}
async function handshakeScenario() {
  const options = {};
  if (values['omo-binary']) options.omoBinary = values['omo-binary'];
  if (values['bun-binary']) options.bunBinary = values['bun-binary'];
  if (values['agent-dir']) options.agentDir = values['agent-dir'];
  const installed = await resolveInstalledRuntime(options);
  handshakeRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'och-')));
  const socketPath = path.join(handshakeRoot, 'rpc.sock');
  const agentDir = path.join(handshakeRoot, 'agent');
  await mkdir(agentDir);
  const { loadHostLaunchSpec } = await import(pathToFileURL(path.join(installed.engineRoot, 'dist/modes/rpc/host-launch-spec.js')).href);
  const { PINNED_HOST_CLIENT_CAPABILITIES } = await import(pathToFileURL(path.join(installed.engineRoot, 'dist/modes/rpc/host-launch.js')).href);
  const { RPC_CLIENT_CAPABILITIES_ENV } = await import(pathToFileURL(path.join(installed.engineRoot, 'dist/modes/rpc/custom-capability.js')).href);
  const spec = await loadHostLaunchSpec(installed.launchSpecPath);
  const env = { ...process.env, ...spec.env, OMO_CODING_AGENT_DIR: agentDir, SENPI_CODING_AGENT_DIR: agentDir };
  for (const key of Object.keys(env)) {
    if (/^(?:OMO|SENPI|PI)_(?:RPC_|HOST_|TASK_|SESSION_|SENPI_TASK_|WORKPOOL_)/.test(key)) delete env[key];
  }
  env[RPC_CLIENT_CAPABILITIES_ENV] = PINNED_HOST_CLIENT_CAPABILITIES.join(',');
  delete env.SENPI_CODING_AGENT_SESSION_DIR;
  // Subscribe before starting the process, then await only that socket's event.
  const { watch } = await import('node:fs');
  await new Promise((resolve, reject) => {
    let settled = false;
    const watcher = watch(handshakeRoot, (_event, filename) => {
      if (filename?.toString() === 'rpc.sock') finish(resolve);
    });
    const timer = setTimeout(() => finish(() => reject(new Error('Isolated native socket did not appear'))), 15_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      callback();
    };
    // Direct installed rpc-entry, unchanged extensions, no native session or model.
    nativeProcess = Bun.spawn([installed.bunBinary, installed.rpcEntryPath, '--multi-session', '--listen', socketPath, ...spec.hostArgs], {
      cwd: handshakeRoot, env, stdout: 'ignore', stderr: 'ignore',
    });
    evidence.resources.push({ kind: 'native-process', pid: nativeProcess.pid, root: handshakeRoot, socketPath, owned: true });
    nativeProcess.exited.then(() => finish(() => reject(new Error('Isolated native host exited before handshake'))));
  });
  nativeClient = createHostClient({ socketPath });
  const info = await nativeClient.connect({ observe: true });
  assert.equal(info.protocolVersion, 1);
  assert(info.capabilities.includes('multi_session'));
  const listing = await nativeClient.request({ type: 'list_sessions', include_workers: true });
  assert.equal(listing.success, true);
  assert.deepEqual(listing.data.sessions, []);
  evidence.status = { available: true, protocolVersion: info.protocolVersion, capabilities: info.capabilities };
  check('Existing immutable runtime isolated JSONL handshake with unchanged launch spec and no model work');
}
try {
  if (scenario === 'handshake') await handshakeScenario();
  else {
    fixture = await createFoundationFixture();
    evidence.resources.push({ kind: 'wire-fixture', root: fixture.root, socketPath: fixture.socketPath, owned: true });
    const snapshot = scenario === 'late-attach' || scenario === 'foundation'
      ? await lateAttachScenario() : await fixture.attach();
    if (scenario === 'security' || scenario === 'foundation') await securityScenario(snapshot);
    if (scenario === 'reconnect' || scenario === 'foundation') await reconnectScenario(snapshot);
  }
  evidence.statusCode = 0;
} catch (error) {
  evidence.statusCode = 1;
  evidence.failure = error.message;
} finally {
  try {
    auth?.dispose();
    if (httpServer) {
      const closed = once(httpServer, 'close');
      httpServer.closeAllConnections();
      httpServer.close();
      await closed;
      evidence.cleanup.push({ kind: 'http-listener', closed: !httpServer.listening });
    }
    if (fixture) {
      evidence.cleanup.push(await fixture.cleanup());
      await assert.rejects(access(fixture.root));
    }
    nativeClient?.disconnect();
    if (nativeProcess) {
      nativeProcess.kill('SIGTERM');
      await nativeProcess.exited;
      evidence.cleanup.push({ kind: 'native-process', pid: nativeProcess.pid, exited: true });
    }
    if (handshakeRoot) {
      await rm(handshakeRoot, { recursive: true, force: true });
      await assert.rejects(access(handshakeRoot));
      evidence.cleanup.push({ kind: 'native-resource-root', removed: handshakeRoot });
    }
  } catch (error) { shutdownError = error.message; evidence.statusCode = 1; }
  evidence.cleanupError = shutdownError ?? null;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ scenario, status: evidence.statusCode === 0 ? 'PASS' : 'FAIL',
  checks: evidence.checks, cleanup: evidence.cleanup, cleanupError: evidence.cleanupError,
  evidenceFile: path.join(evidenceDir, 'result.json'), failure: evidence.failure }));
process.exitCode = evidence.statusCode;
