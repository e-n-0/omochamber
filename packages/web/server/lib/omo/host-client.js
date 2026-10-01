import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, isAbsolute, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

const REQUIRED_CAPABILITIES = ['multi_session', 'extension_events', 'session_context', 'session_kind'];
const CLIENT_CAPABILITIES = ['extension_events', 'question'];
const OBSERVING_COMMANDS = new Set(['get_protocol_info', 'list_sessions']);
const TERMINAL_READS = new Set([...OBSERVING_COMMANDS, 'get_state', 'get_messages', 'subscribe']);
const MAX_LINE_CHARACTERS = 16 * 1024 * 1024;
const socketAddressSchema = z.string().min(1).refine((value) => isAbsolute(value) || value.startsWith('\0'));
const capabilitiesSchema = z.array(z.string());
const requestSchema = z.object({
  type: z.string().min(1), id: z.string().min(1).optional(), sessionId: z.string().optional(),
}).passthrough();
const frameSchema = z.object({ type: z.string().min(1) }).passthrough();
const responseSchema = requestSchema.extend({
  type: z.literal('response'), id: z.string().min(1), command: z.string().min(1), success: z.boolean(),
});
const protocolVersionSchema = z.object({ protocolVersion: z.literal(1) }).passthrough();
const protocolSchema = protocolVersionSchema.extend({
  capabilities: capabilitiesSchema, mode: z.string().optional(), instanceId: z.string().optional(),
});

function transportError(code, message, uncertain = false) {
  return Object.assign(new Error(message), { code, uncertain });
}

/**
 * Server-private JSONL socket transport. connect() negotiates before any session request.
 * connect({ observe: true }) is a short-lived discovery probe: only observing reads are sent.
 * Subscribers registered before connect receive even negotiation/attach-time events.
 * There is no retry, mutation replay, host start, stop, or native metadata write.
 */
export function createHostClient({ socketPath, clientCapabilities = CLIENT_CAPABILITIES, timeoutMs = 10_000 }) {
  const address = socketAddressSchema.safeParse(socketPath);
  if (!address.success) {
    throw transportError('invalid_socket', 'A local absolute socket address is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw transportError('invalid_timeout', 'The request deadline must be a positive integer');
  }
  const clientInfo = capabilitiesSchema.safeParse(clientCapabilities);
  if (!clientInfo.success) {
    throw transportError('invalid_capabilities', 'Client capabilities must be strings');
  }
  socketPath = address.data;
  const capabilities = [...new Set([...CLIENT_CAPABILITIES, ...clientInfo.data])];
  const listeners = new Set();
  let active;

  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };

  function retire(connection, error) {
    if (connection.closed) return;
    connection.closed = true;
    connection.ready = false;
    connection.socket?.destroy();
    connection.rejectConnect?.(error);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(transportError(error.code, error.message, true));
    }
    connection.pending.clear();
    if (active === connection) active = undefined;
    emit({ type: 'transport_disconnected', error: { code: error.code } });
  }

  function send(connection, input) {
    if (connection.closed || !connection.socket?.writable) {
      return Promise.reject(transportError('rpc_transport_gone', 'Native host connection is unavailable'));
    }
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(transportError('invalid_request', 'A native request type is required'));
    }
    const frame = parsed.data;
    if ((connection.observe && !OBSERVING_COMMANDS.has(frame.type))
      || (connection.info?.mode === 'tui' && !TERMINAL_READS.has(frame.type))) {
      return Promise.reject(transportError('read_only_endpoint', 'This endpoint is read-only'));
    }
    const id = frame.id ?? randomUUID();
    if (connection.ids.has(id)) {
      return Promise.reject(transportError('invalid_request_id', 'A request ID must be unique on this connection'));
    }
    let line;
    try {
      const request = { ...frame, id };
      if (connection.observe) request.observe = true;
      line = `${JSON.stringify(request)}\n`;
    } catch {
      return Promise.reject(transportError('invalid_request', 'The native request is not JSON serializable'));
    }
    connection.ids.add(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(transportError('rpc_request_timeout', 'Native request deadline expired', true));
      }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer, type: frame.type, sessionId: frame.sessionId });
      connection.socket.write(line, (error) => {
        if (error) retire(connection, transportError('rpc_transport_gone', 'Native host connection was lost'));
      });
    });
  }

  function receive(connection, line) {
    let parsed;
    try {
      parsed = frameSchema.safeParse(JSON.parse(line));
    } catch {
      retire(connection, transportError('rpc_invalid_frame', 'Native host sent malformed JSONL'));
      return;
    }
    if (!parsed.success) {
      retire(connection, transportError('rpc_invalid_frame', 'Native host sent an invalid frame'));
      return;
    }
    let frame = parsed.data;
    if (frame.type !== 'response') {
      emit(frame);
      return;
    }
    const reply = responseSchema.safeParse(frame);
    if (!reply.success) {
      retire(connection, transportError('rpc_invalid_frame', 'Native host sent an invalid response'));
      return;
    }
    frame = reply.data;
    const pending = connection.pending.get(frame.id);
    if (!pending) return; // Late replies after a deadline must never become events or another result.
    if (frame.command !== pending.type
      || (frame.sessionId !== undefined && pending.sessionId !== undefined && frame.sessionId !== pending.sessionId)) {
      retire(connection, transportError('rpc_invalid_frame', 'Native response correlation does not match'));
      return;
    }
    connection.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame); // Native command failures are responses, not transport failures.
  }

  async function start(connection) {
    const terminal = /^t-[0-9a-f]{16}\.sock$/.test(basename(socketPath));
    let secret;
    if (terminal || process.platform === 'win32') {
      try {
        secret = await readFile(`${socketPath}.secret`);
      } catch {
        throw transportError('rpc_socket_secret', 'Native socket authentication is unavailable');
      }
      if (secret.length !== 32) throw transportError('rpc_socket_secret', 'Native socket authentication is invalid');
    }
    if (connection.closed) throw transportError('rpc_transport_gone', 'Native connection was canceled');
    let address = socketPath;
    if (process.platform === 'win32' && !socketPath.toLowerCase().startsWith('\\\\.\\pipe\\')) {
      const identity = Buffer.concat([Buffer.from(win32.normalize(socketPath).toLowerCase()), secret]);
      address = `\\\\.\\pipe\\senpi-rpc-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    }
    const socket = createConnection(address);
    connection.socket = socket;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      const text = decoder.write(chunk);
      let offset = 0;
      while (offset < text.length && !connection.closed) {
        const newline = text.indexOf('\n', offset);
        const segment = text.slice(offset, newline === -1 ? text.length : newline);
        if (buffer.length + segment.length > MAX_LINE_CHARACTERS) {
          retire(connection, transportError('rpc_invalid_frame', 'Native JSONL record exceeds the size limit'));
          return;
        }
        buffer += segment;
        if (newline === -1) return;
        const line = buffer;
        buffer = '';
        if (line.trim()) receive(connection, line);
        offset = newline + 1;
      }
    });
    socket.once('error', () => retire(connection, transportError('rpc_transport_gone', 'Native host connection failed')));
    socket.once('close', () => retire(connection, transportError('rpc_transport_gone', 'Native host connection closed')));
    await new Promise((resolve, reject) => {
      connection.rejectConnect = reject;
      const timer = setTimeout(() => {
        retire(connection, transportError('rpc_connect_timeout', 'Native connection deadline expired'));
      }, timeoutMs);
      socket.once('connect', resolve);
      socket.once('close', () => clearTimeout(timer));
      socket.once('connect', () => clearTimeout(timer));
    });
    connection.rejectConnect = undefined;
    if (secret) socket.write(secret);
    const reply = await send(connection, { type: 'get_protocol_info', observe: true });
    if (!reply.success || !protocolVersionSchema.safeParse(reply.data).success) {
      throw transportError('rpc_protocol', 'Native host does not speak protocol version 1');
    }
    const parsed = protocolSchema.safeParse(reply.data);
    if (!parsed.success) {
      throw transportError('rpc_capability', 'Native host capabilities are invalid');
    }
    const info = parsed.data;
    const isTerminal = info.mode === 'tui' && info.capabilities.includes('tui_control');
    if ((terminal && !isTerminal) || (!isTerminal && !REQUIRED_CAPABILITIES.every((value) => info.capabilities.includes(value)))) {
      throw transportError('rpc_capability', 'Native host lacks required capabilities');
    }
    connection.info = info;
    if (!connection.observe && !isTerminal) {
      const accepted = await send(connection, { type: 'set_client_info', capabilities });
      if (!accepted.success) throw transportError('rpc_capability', 'Native host refused client capabilities');
    }
    connection.ready = true;
    return info;
  }

  function connect({ observe = false } = {}) {
    if (active) return active.promise;
    const connection = { observe, pending: new Map(), ids: new Set(), closed: false, ready: false };
    active = connection;
    connection.promise = start(connection).catch((error) => {
      retire(connection, error);
      throw error;
    });
    return connection.promise;
  }

  return {
    connect,
    request(frame) {
      if (!active?.ready) {
        return Promise.reject(transportError('rpc_transport_gone', 'Native host is not connected'));
      }
      return send(active, frame);
    },
    subscribe(listener) {
      if (!z.function().safeParse(listener).success) throw new TypeError('A native event listener is required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnect() {
      if (active) retire(active, transportError('rpc_transport_gone', 'Native client disconnected'));
    },
  };
}
