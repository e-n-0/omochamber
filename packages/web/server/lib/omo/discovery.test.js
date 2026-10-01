import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverHosts } from './discovery.js';
import { createHostClient } from './host-client.js';

const capabilities = ['multi_session', 'extension_events', 'session_context', 'session_kind'];
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
let root;
let runtime;
let endpoints;

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function metadataTree(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await metadataTree(file, relative));
    else if (entry.isFile()) {
      const info = await stat(file);
      result.push({ path: relative, contents: (await readFile(file)).toString('base64'), mode: info.mode, mtime: info.mtimeMs });
    }
  }
  return result;
}

async function endpoint({
  socketName = 'rpc.sock', location = 'sockets', kind = 'rpc_host', info = {},
  sessions = [], listingSuccess = true, identity = 'endpoint', online = true,
} = {}) {
  const socketDir = path.join(root, location);
  await mkdir(socketDir, { recursive: true });
  const socketPath = path.join(await realpath(socketDir), socketName);
  const daemonDir = path.join(runtime.agentDir, 'rpc-host-daemon', hash(socketPath));
  const record = { socket: socketPath, endpoint_kind: kind, layout: 2, registry_version: 1 };
  const registryFile = identity === 'settings' ? path.join(daemonDir, 'settings.json')
    : identity === 'generation-settings' ? path.join(daemonDir, 'generations', 'old-instance', 'settings.json')
      : path.join(daemonDir, 'endpoint.json');
  await writeJson(registryFile, record);
  const secret = kind === 'tui' ? Buffer.alloc(32, 13) : null;
  if (secret) await writeFile(`${socketPath}.secret`, secret);
  const frames = [];
  const sockets = new Set();
  const protocol = {
    protocolVersion: 1, serverVersion: '2026.9.30', instanceId: `instance-${socketName}`,
    mode: kind === 'tui' ? 'tui' : 'multi', capabilities: kind === 'tui' ? ['tui_control'] : capabilities,
    ...info,
  };
  let server;
  if (online) {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let input = Buffer.alloc(0);
      let authenticated = !secret;
      socket.on('data', (chunk) => {
        input = Buffer.concat([input, chunk]);
        if (!authenticated) {
          if (input.length < 32) return;
          expect(input.subarray(0, 32)).toEqual(secret);
          authenticated = true;
          input = input.subarray(32);
        }
        let newline;
        while ((newline = input.indexOf(10)) !== -1) {
          const frame = JSON.parse(input.subarray(0, newline).toString('utf8'));
          input = input.subarray(newline + 1);
          frames.push(frame);
          const data = frame.type === 'get_protocol_info' ? protocol : { sessions };
          socket.write(`${JSON.stringify({
            type: 'response', id: frame.id, command: frame.type,
            success: frame.type !== 'list_sessions' || listingSuccess, data,
          })}\n`);
        }
      });
    });
    const listening = once(server, 'listening');
    server.listen(socketPath);
    await listening;
  }
  const result = { socketPath, daemonDir, registryFile, server, sockets, frames, protocol };
  endpoints.push(result);
  return result;
}

beforeEach(async () => {
  // Darwin's per-user TMPDIR can exhaust the native 103-byte Unix socket limit.
  root = await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'oc-disc-'));
  runtime = { agentDir: path.join(root, 'agent') };
  endpoints = [];
  await writeJson(path.join(runtime.agentDir, 'rpc-host-daemon', 'layout.json'), { layout: 2 });
});

afterEach(async () => {
  for (const endpoint of endpoints) {
    if (!endpoint.server) continue;
    const closed = once(endpoint.server, 'close');
    for (const socket of endpoint.sockets) socket.destroy();
    endpoint.server.close();
    await closed;
  }
  await rm(root, { recursive: true, force: true });
});

describe('discoverHosts', () => {
  test('distinguishes a confirmed absent endpoint from an uncertain native read', async () => {
    const absent = await endpoint({ online: false });
    const before = await metadataTree(root);
    const [found] = await discoverHosts({ runtime });
    expect(found).toMatchObject({
      socketPath: absent.socketPath, availability: 'inactive',
      sessions: null, reason: 'rpc_endpoint_absent',
    });
    expect(await metadataTree(root)).toEqual(before);
  });

  test('discovers live ownership with observing wire reads and no registry or lifecycle writes', async () => {
    const host = await endpoint({ sessions: [
      { sessionId: 'routing-handle', sessionPath: '/durable/parent.jsonl', cwd: '/project', kind: 'interactive' },
      { sessionId: 'worker-handle', sessionPath: '/durable/child.jsonl', cwd: '/project', kind: 'worker', context: { role: 'child' } },
    ] });
    const before = await metadataTree(root);
    const disconnected = [];
    const hosts = await discoverHosts({
      runtime,
      hostClientFactory(options) {
        const client = createHostClient(options);
        client.subscribe((event) => {
          if (event.type === 'transport_disconnected') disconnected.push(options.socketPath);
        });
        return client;
      },
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      socketPath: host.socketPath, daemonDir: host.daemonDir, availability: 'ready',
      endpointKind: 'rpc_host', instanceId: host.protocol.instanceId, protocol: host.protocol,
      storesStatus: 'unavailable', stores: [],
    });
    expect(hosts[0].sessions.map((row) => [row.sessionId, row.kind, row.ownership, row.readOnly])).toEqual([
      ['routing-handle', 'interactive', 'hosted', false], ['worker-handle', 'worker', 'hosted', false],
    ]);
    expect(host.frames.map(({ type, observe, include_workers }) => ({ type, observe, include_workers }))).toEqual([
      { type: 'get_protocol_info', observe: true, include_workers: undefined },
      { type: 'list_sessions', observe: true, include_workers: true },
    ]);
    expect(disconnected).toEqual([host.socketPath]);
    expect(await metadataTree(root)).toEqual(before);
  });

  test('discovers registered parent and isolated shards in arbitrary endpoint roots', async () => {
    const parentKey = hash('p:durable-parent');
    const parent = await endpoint({ socketName: `p-${parentKey}.sock`, location: 'alternate-shards' });
    const isolated = await endpoint({ socketName: 'i-0123456789abcdef.sock', location: 'private-shards' });
    const ownStore = path.join(root, 'project-a', '.omo', 'senpi-task');
    const otherStore = path.join(root, 'project-b', '.omo', 'senpi-task');
    await writeJson(parent.socketPath.replace(/\.sock$/, '.meta.json'), {
      socket: parent.socketPath, kind: 'p', root: path.dirname(parent.socketPath),
      owner_session_id: 'durable-parent', owner_session_file: '/durable/parent.jsonl',
      stores: [ownStore, ownStore, otherStore],
    });
    await writeJson(isolated.socketPath.replace(/\.sock$/, '.meta.json'), {
      socket: isolated.socketPath, kind: 'i', root: path.dirname(isolated.socketPath), stores: [],
    });
    const before = await metadataTree(root);
    const hosts = await discoverHosts({ runtime });
    expect(hosts.find((host) => host.socketPath === parent.socketPath)).toMatchObject({
      shard: { kind: 'p', key: parentKey, ownerSessionId: 'durable-parent', ownerSessionFile: '/durable/parent.jsonl' },
      stores: [ownStore, otherStore], storesStatus: 'ready',
    });
    expect(hosts.find((host) => host.socketPath === isolated.socketPath)).toMatchObject({
      shard: { kind: 'i', key: '0123456789abcdef', ownerSessionId: null, ownerSessionFile: null },
      stores: [], storesStatus: 'ready',
    });
    expect(await metadataTree(root)).toEqual(before);
  });

  test('does not resolve foreign relative roots against this server directory', async () => {
    const host = await endpoint({ socketName: 'p-0123456789abcdef.sock' });
    const absolute = path.join(root, 'own-store');
    await writeJson(host.socketPath.replace(/\.sock$/, '.meta.json'), {
      socket: host.socketPath, kind: 'p', root: path.dirname(host.socketPath), stores: [absolute, '.omo/senpi-task', 7],
    });
    const [found] = await discoverHosts({ runtime });
    expect(found.stores).toEqual([absolute]);
    expect(found.storesStatus).toBe('incomplete');
  });

  test('refuses store metadata copied from a different owning endpoint', async () => {
    const host = await endpoint({ socketName: 'p-0123456789abcdef.sock' });
    await writeJson(host.socketPath.replace(/\.sock$/, '.meta.json'), {
      socket: path.join(root, 'foreign.sock'), kind: 'p', root: path.dirname(host.socketPath),
      stores: [path.join(root, 'foreign-store')],
    });
    const before = await metadataTree(root);
    const [found] = await discoverHosts({ runtime });
    expect(found).toMatchObject({ availability: 'ready', storesStatus: 'incomplete', stores: [] });
    expect(await metadataTree(root)).toEqual(before);
  });

  test('classifies authenticated TUI endpoints as terminal-owned and never opens their transcript', async () => {
    const terminal = await endpoint({
      socketName: 't-0123456789abcdef.sock', kind: 'tui',
      sessions: [{ sessionId: 'terminal-durable-id', sessionPath: '/terminal/session.jsonl', surface: 'tui', kind: 'interactive' }],
    });
    const before = await metadataTree(root);
    const [found] = await discoverHosts({ runtime });
    expect(found).toMatchObject({ endpointKind: 'tui', availability: 'ready' });
    expect(found.sessions[0]).toMatchObject({ ownership: 'terminal', readOnly: true });
    expect(terminal.frames.map((frame) => frame.type)).toEqual(['get_protocol_info', 'list_sessions']);
    expect(await metadataTree(root)).toEqual(before);
  });

  test('keeps dead and incompatible endpoints visible without erasing healthy hosts', async () => {
    const healthy = await endpoint();
    const dead = await endpoint({ socketName: 'dead.sock', online: false });
    const wrong = await endpoint({ socketName: 'wrong.sock', info: { protocolVersion: 2 } });
    const missing = await endpoint({ socketName: 'missing-cap.sock', info: { capabilities: ['multi_session'] } });
    const before = await metadataTree(root);
    const hosts = await discoverHosts({ runtime });
    expect(hosts.find((host) => host.socketPath === healthy.socketPath)).toMatchObject({ availability: 'ready', sessions: [] });
    expect(hosts.find((found) => found.socketPath === dead.socketPath)).toMatchObject({
      availability: 'inactive', sessions: null, reason: 'rpc_endpoint_absent',
    });
    for (const [host, reason] of [[wrong, 'rpc_protocol'], [missing, 'rpc_capability']]) {
      expect(hosts.find((found) => found.socketPath === host.socketPath)).toMatchObject({
        availability: 'unavailable', sessions: null, reason,
      });
    }
    expect(wrong.frames).toHaveLength(1);
    expect(missing.frames).toHaveLength(1);
    expect(await metadataTree(root)).toEqual(before);
  });

  test('uses legacy settings and generation-settings only when they name the hashed endpoint', async () => {
    const boot = await endpoint({ socketName: 'boot.sock', identity: 'settings' });
    const generation = await endpoint({ socketName: 'generation.sock', identity: 'generation-settings' });
    const fakeDir = path.join(runtime.agentDir, 'rpc-host-daemon', 'aaaaaaaaaaaaaaaa');
    await writeJson(path.join(fakeDir, 'endpoint.json'), { socket: boot.socketPath });
    const hosts = await discoverHosts({ runtime });
    expect(hosts.find((host) => host.socketPath === boot.socketPath).identity).toBe('settings');
    expect(hosts.find((host) => host.socketPath === generation.socketPath).identity).toBe('generation-settings');
    expect(hosts.find((host) => host.daemonDir === fakeDir)).toMatchObject({
      socketPath: null, identity: 'unknown', availability: 'unavailable', reason: 'unaddressable_endpoint',
    });
  });

  test('refuses live listings with another host identity instead of attaching to them', async () => {
    await endpoint({
      sessions: [{ sessionId: 'foreign', sessionPath: '/durable/foreign.jsonl', context: { host_instance: 'another-host' } }],
    });
    const [found] = await discoverHosts({ runtime });
    expect(found).toMatchObject({ availability: 'unavailable', sessions: null, reason: 'rpc_owner_mismatch' });
  });

  test('marks multiple writers claiming one durable transcript as read-only conflicts', async () => {
    await endpoint({ sessions: [{ sessionId: 'a', sessionPath: '/durable/conflict.jsonl' }] });
    await endpoint({ socketName: 'other.sock', sessions: [{ sessionId: 'b', sessionPath: '/durable/conflict.jsonl' }] });
    const hosts = await discoverHosts({ runtime });
    expect(hosts.flatMap((host) => host.sessions).map((row) => [row.ownership, row.readOnly])).toEqual([
      ['conflict', true], ['conflict', true],
    ]);
  });

  test('distinguishes successful empty inventories from failed listings', async () => {
    const empty = await endpoint();
    const failed = await endpoint({ socketName: 'listing-failed.sock', listingSuccess: false });
    const hosts = await discoverHosts({ runtime });
    expect(hosts.find((host) => host.socketPath === empty.socketPath).sessions).toEqual([]);
    expect(hosts.find((host) => host.socketPath === failed.socketPath)).toMatchObject({
      sessions: null, availability: 'unavailable', reason: 'rpc_listing_unavailable',
    });
  });

  test('rejects protocol identities that cannot prove a live owner', async () => {
    await endpoint({ info: { instanceId: undefined } });
    const [found] = await discoverHosts({ runtime });
    expect(found).toMatchObject({ availability: 'unavailable', sessions: null, reason: 'rpc_identity' });
  });

  test('does not manufacture or repair absent or malformed native registration', async () => {
    const marker = path.join(runtime.agentDir, 'rpc-host-daemon', 'layout.json');
    await rm(marker);
    const before = await metadataTree(root);
    await expect(discoverHosts({ runtime })).resolves.toEqual([]);
    expect(await metadataTree(root)).toEqual(before);
    await writeFile(marker, '{broken');
    await expect(discoverHosts({ runtime })).rejects.toMatchObject({ code: 'registry_unavailable' });
    await writeJson(marker, { layout: 1 });
    await expect(discoverHosts({ runtime })).rejects.toMatchObject({ code: 'registry_layout' });
  });
});
