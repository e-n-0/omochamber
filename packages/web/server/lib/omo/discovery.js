import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { createHostClient } from './host-client.js';

const ENDPOINT_DIRECTORY = /^[0-9a-f]{16}$/;
const SHARD_SOCKET = /^([pi])-([0-9a-f]{16})\.sock$/;
const TUI_SOCKET = /^t-[0-9a-f]{16}\.sock$/;
const absolutePathSchema = z.string().min(1).refine(path.isAbsolute);
const socketSchema = z.string().min(1).refine((value) => path.isAbsolute(value) || value.startsWith('\0'));
const endpointSchema = z.object({ socket: socketSchema, endpoint_kind: z.string().optional() });
const shardSchema = z.object({
  socket: socketSchema, kind: z.enum(['p', 'i']), root: absolutePathSchema,
  owner_session_id: z.string().optional(), owner_session_file: absolutePathSchema.optional(),
  stores: z.array(z.json()).optional(),
});
const listingSchema = z.object({
  sessions: z.array(z.object({
    sessionId: z.string().min(1), sessionPath: absolutePathSchema.nullish(),
    context: z.record(z.string(), z.string()).optional(), surface: z.string().optional(),
  }).passthrough()),
});
const protocolSchema = z.object({
  protocolVersion: z.literal(1), instanceId: z.string().min(1),
  capabilities: z.array(z.string()), mode: z.string().optional(),
}).passthrough();
const runtimeSchema = z.object({ agentDir: absolutePathSchema });

function discoveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw discoveryError('registry_unavailable', 'Native registration could not be read');
  }
}

// Match native canonicalEndpointPath, including nonexistent descendants and /tmp symlinks.
function canonicalPath(value) {
  if (process.platform === 'win32') return path.win32.normalize(value).toLowerCase();
  if (value.startsWith('\0')) return value;
  const missing = [];
  let ancestor = path.resolve(value);
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function canonicalSocket(socket) {
  if (process.platform === 'win32' || socket.startsWith('\0')) return canonicalPath(socket);
  return path.join(canonicalPath(path.dirname(socket)), path.basename(socket));
}

const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);

async function identifyEndpoint(dir) {
  const name = path.basename(dir);
  const sources = [
    { file: path.join(dir, 'endpoint.json'), identity: 'endpoint' },
    { file: path.join(dir, 'settings.json'), identity: 'settings' },
  ];
  let generations;
  try {
    generations = await readdir(path.join(dir, 'generations'), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    generations = [];
  }
  for (const entry of generations.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    sources.push({ file: path.join(dir, 'generations', entry.name, 'settings.json'), identity: 'generation-settings' });
  }
  for (const source of sources) {
    const parsed = endpointSchema.safeParse(await readJson(source.file));
    if (!parsed.success) continue;
    const record = parsed.data;
    const socket = record.socket;
    if (hash(canonicalSocket(socket)) !== name && hash(socket) !== name) continue;
    return {
      socketPath: socket,
      identity: source.identity,
      endpointKind: (source.identity === 'endpoint' && record.endpoint_kind === 'tui') || TUI_SOCKET.test(path.basename(socket))
        ? 'tui' : 'rpc_host',
    };
  }
  return { socketPath: null, identity: 'unknown', endpointKind: 'rpc_host' };
}

async function registeredStores(socketPath) {
  const match = SHARD_SOCKET.exec(path.basename(socketPath));
  if (!match) return { shard: null, stores: [], storesStatus: 'unavailable' };
  const [, kind, key] = match;
  const shard = { kind, key, ownerSessionId: null, ownerSessionFile: null };
  let record;
  try {
    record = await readJson(path.join(path.dirname(socketPath), `${kind}-${key}.meta.json`));
  } catch {
    return { shard, stores: [], storesStatus: 'incomplete' };
  }
  if (record === null) return { shard, stores: [], storesStatus: 'unavailable' };
  const parsed = shardSchema.safeParse(record);
  if (!parsed.success) return { shard, stores: [], storesStatus: 'incomplete' };
  record = parsed.data;
  if (canonicalSocket(record.socket) !== canonicalSocket(socketPath) || record.kind !== kind
    || canonicalPath(record.root) !== canonicalPath(path.dirname(socketPath))) {
    return { shard, stores: [], storesStatus: 'incomplete' };
  }
  shard.ownerSessionId = record.owner_session_id ?? null;
  shard.ownerSessionFile = record.owner_session_file ?? null;
  // An inherited parent shard preserves its original owner; it is never derived from the server cwd.
  const roots = (record.stores ?? []).map((root) => absolutePathSchema.safeParse(root));
  const stores = [...new Set(roots.filter((root) => root.success).map((root) => root.data))];
  return {
    shard,
    stores,
    storesStatus: record.stores && roots.every((root) => root.success) ? 'ready' : 'incomplete',
  };
}

function sessionRows(reply, descriptor, protocol) {
  if (!reply.success) {
    throw discoveryError('rpc_listing_unavailable', 'Native session listing is unavailable');
  }
  const parsed = listingSchema.safeParse(reply.data);
  if (!parsed.success) throw discoveryError('rpc_listing_invalid', 'Native session listing is invalid');
  return parsed.data.sessions.map((row) => {
    const context = row.context;
    if ((context?.host_instance !== undefined && context.host_instance !== protocol.instanceId)
      || (context?.host_socket !== undefined
        && canonicalSocket(context.host_socket) !== canonicalSocket(descriptor.socketPath))) {
      throw discoveryError('rpc_owner_mismatch', 'Native session listing names another host owner');
    }
    const terminal = descriptor.endpointKind === 'tui' || row.surface === 'tui';
    return { ...row, ownership: terminal ? 'terminal' : 'hosted', readOnly: terminal };
  });
}

async function probeEndpoint(dir, hostClientFactory) {
  let descriptor = {
    daemonDir: dir, socketPath: null, identity: 'unknown', endpointKind: 'rpc_host',
    availability: 'unavailable', protocol: null, instanceId: null, capabilities: [],
    sessions: null, shard: null, stores: [], storesStatus: 'unavailable', reason: null,
  };
  let client;
  try {
    descriptor = { ...descriptor, ...await identifyEndpoint(dir) };
    if (descriptor.socketPath === null) return { ...descriptor, reason: 'unaddressable_endpoint' };
    Object.assign(descriptor, await registeredStores(descriptor.socketPath));
    client = hostClientFactory({ socketPath: descriptor.socketPath, timeoutMs: descriptor.endpointKind === 'tui' ? 1_500 : 10_000 });
    const input = await client.connect({ observe: true });
    const parsed = protocolSchema.safeParse(input);
    if (!parsed.success) throw discoveryError('rpc_identity', 'Native host did not identify its live instance');
    const protocol = parsed.data;
    descriptor.protocol = protocol;
    descriptor.capabilities = protocol.capabilities;
    if (protocol.protocolVersion !== 1) throw discoveryError('rpc_protocol', 'Native protocol is incompatible');
    descriptor.instanceId = protocol.instanceId;
    if ((protocol.mode === 'tui') !== (descriptor.endpointKind === 'tui')) {
      throw discoveryError('rpc_endpoint_kind', 'Native endpoint ownership differs from its registration');
    }
    const reply = await client.request({ type: 'list_sessions', include_workers: true, observe: true });
    descriptor.sessions = sessionRows(reply, descriptor, protocol);
    descriptor.availability = 'ready';
    return descriptor;
  } catch (error) {
    return {
      ...descriptor,
      availability: error.code === 'rpc_endpoint_absent' ? 'inactive' : 'unavailable',
      reason: error.code ?? 'discovery_unavailable',
    };
  } finally {
    client?.disconnect(); // Only our probe connection; never close a session or stop a host.
  }
}

/**
 * Read-only layout-2 registered endpoint discovery, including shards in nondefault roots.
 * Returned descriptors (native protocol, sockets, context, and store roots) are SERVER PRIVATE.
 * Missing registration is [], but failed enumeration throws and individual failed reads stay
 * visible with sessions:null, never an authoritative empty inventory. Only a confirmed
 * absent/refused socket is inactive; timeouts, permission and protocol failures stay unavailable.
 */
export async function discoverHosts({ runtime, hostClientFactory = createHostClient }) {
  const parsed = runtimeSchema.safeParse(runtime);
  if (!parsed.success) {
    throw discoveryError('invalid_runtime', 'An installed runtime with an absolute agent directory is required');
  }
  const flatDir = path.join(parsed.data.agentDir, 'rpc-host-daemon');
  const layout = await readJson(path.join(flatDir, 'layout.json'));
  if (layout === null) return [];
  if (layout.layout !== 2) throw discoveryError('registry_layout', 'Native endpoint registry layout is unsupported');
  const entries = await readdir(flatDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && ENDPOINT_DIRECTORY.test(entry.name))
    .map((entry) => path.join(flatDir, entry.name)).sort();
  const descriptors = new Array(dirs.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < dirs.length; index = next++) {
      descriptors[index] = await probeEndpoint(dirs[index], hostClientFactory);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, dirs.length) }, worker));
  const owners = new Map();
  for (const descriptor of descriptors) {
    for (const session of descriptor.sessions ?? []) {
      if (!session.sessionPath) continue;
      const sessionPath = canonicalPath(session.sessionPath);
      const previous = owners.get(sessionPath);
      if (previous) {
        previous.ownership = session.ownership = 'conflict';
        previous.readOnly = session.readOnly = true;
      } else {
        owners.set(sessionPath, session);
      }
    }
  }
  return descriptors;
}
