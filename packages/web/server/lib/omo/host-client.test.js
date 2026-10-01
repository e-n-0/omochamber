import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHostClient } from './host-client.js';

const requiredCapabilities = ['multi_session', 'extension_events', 'session_context', 'session_kind'];
const protocol = {
  protocolVersion: 1, serverVersion: '2026.9.30', mode: 'multi', instanceId: 'wire-host',
  capabilities: [...requiredCapabilities, 'retain_on_disconnect', 'prompt_surface_chat'],
};
const resources = [];
const clients = [];
const response = (frame, data, success = true) => ({ type: 'response', id: frame.id, command: frame.type, success, data });
const send = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);

async function fakeHost({ info = protocol, terminal = false, negotiate = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-wire-'));
  const socketPath = path.join(root, terminal ? 't-0123456789abcdef.sock' : 'rpc.sock');
  const secret = terminal ? Buffer.alloc(32, 7) : null;
  if (secret) await writeFile(`${socketPath}.secret`, secret);
  const events = new EventEmitter();
  const frames = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let authenticated = !secret;
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (!authenticated) {
        if (input.length < 32) return;
        expect(input.subarray(0, 32)).toEqual(secret);
        input = input.subarray(32);
        authenticated = true;
      }
      let newline;
      while ((newline = input.indexOf(10)) !== -1) {
        const frame = JSON.parse(input.subarray(0, newline).toString('utf8'));
        input = input.subarray(newline + 1);
        frames.push(frame);
        if (frame.type === 'get_protocol_info' && negotiate) send(socket, response(frame, info));
        else if (frame.type === 'set_client_info') send(socket, response(frame));
        else events.emit('request', { socket, frame });
      }
    });
  });
  const listening = once(server, 'listening');
  server.listen(socketPath);
  await listening;
  resources.push({ root, server, sockets });
  return { root, socketPath, events, frames, sockets };
}

function clientFor(host, options = {}) {
  const client = createHostClient({ socketPath: host.socketPath, ...options });
  clients.push(client);
  return client;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.disconnect();
  for (const { root, server, sockets } of resources.splice(0)) {
    const closed = once(server, 'close');
    for (const socket of sockets) socket.destroy();
    server.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

describe('createHostClient', () => {
  test('negotiates protocol and opt-ins before requests without changing prompt surface', async () => {
    const host = await fakeHost();
    const client = clientFor(host, { clientCapabilities: ['custom_capability'] });
    await expect(client.connect()).resolves.toEqual(protocol);
    expect(host.frames.map((frame) => frame.type)).toEqual(['get_protocol_info', 'set_client_info']);
    expect(host.frames[1].capabilities).toEqual(['extension_events', 'question', 'custom_capability']);
    expect(host.frames[0].observe).toBe(true);
    expect(host.frames.some((frame) => 'promptSurface' in frame)).toBe(false);
  });

  test('decodes split UTF-8 and LF-only frames and correlates reverse replies among events', async () => {
    const host = await fakeHost();
    const client = clientFor(host);
    const events = [];
    const signal = new EventEmitter();
    client.subscribe((event) => {
      events.push(event);
      signal.emit(event.type);
    });
    await client.connect();
    const firstSeen = once(host.events, 'request');
    const firstResult = client.request({ type: 'get_state', id: 'a', sessionId: 's' });
    const [first] = await firstSeen;
    const secondSeen = once(host.events, 'request');
    const secondResult = client.request({ type: 'get_entries', id: 'b', sessionId: 's' });
    const [second] = await secondSeen;
    const secondReply = response(second.frame, { text: 'h\u00e9\u2028\u2029llo' });
    const bytes = Buffer.from(`${JSON.stringify(secondReply)}\n`);
    const split = bytes.indexOf(Buffer.from('\u00e9')) + 1;
    const markerSeen = once(signal, 'extension_event');
    first.socket.write(Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: 'extension_event', sessionId: 's', name: 'omo.task.updated' })}\n`),
      bytes.subarray(0, split),
    ]));
    await markerSeen;
    first.socket.write(Buffer.concat([
      bytes.subarray(split),
      Buffer.from(`${JSON.stringify({ type: 'queued', for_request: 'a', position: 1 })}\n${JSON.stringify(response(first.frame, { value: 1 }))}\n`),
    ]));
    expect(await secondResult).toEqual(secondReply);
    expect(await firstResult).toEqual(response(first.frame, { value: 1 }));
    expect(events.map((event) => event.type)).toEqual(['extension_event', 'queued']);
  });

  test('delivers attach-time events to the listener registered before hydration', async () => {
    const host = await fakeHost({ negotiate: false });
    const client = clientFor(host);
    const events = [];
    const unsubscribe = client.subscribe((event) => events.push(event));
    const handshakeSeen = once(host.events, 'request');
    const connecting = client.connect();
    const [handshake] = await handshakeSeen;
    send(handshake.socket, { type: 'extension_event', sessionId: 'new-handle', name: 'omo.todo.updated' });
    send(handshake.socket, response(handshake.frame, protocol));
    await connecting;
    expect(events).toHaveLength(1);
    unsubscribe();
    const seen = once(host.events, 'request');
    const opening = client.request({ type: 'open_session', sessionPath: '/owned/session.jsonl', retain_on_disconnect: true });
    const [open] = await seen;
    send(open.socket, { type: 'extension_event', sessionId: 'new-handle', name: 'omo.task.updated' });
    send(open.socket, response(open.frame, { sessionId: 'new-handle' }));
    await opening;
    expect(events).toHaveLength(1);
  });

  test.each([
    [{ ...protocol, protocolVersion: 2 }, 'rpc_protocol'],
    [{ ...protocol, capabilities: requiredCapabilities.slice(1) }, 'rpc_capability'],
    [{ ...protocol, capabilities: ['multi_session', 3] }, 'rpc_capability'],
  ])('refuses incompatible hosts without any lifecycle request', async (info, code) => {
    const host = await fakeHost({ info });
    const client = clientFor(host);
    await expect(client.connect()).rejects.toMatchObject({ code });
    expect(host.frames.map((frame) => frame.type)).toEqual(['get_protocol_info']);
  });

  test('returns native failure responses unchanged rather than inventing success', async () => {
    const host = await fakeHost();
    const client = clientFor(host);
    await client.connect();
    const seen = once(host.events, 'request');
    const result = client.request({ type: 'extension_request', id: 'failure', sessionId: 's' });
    const [{ socket, frame }] = await seen;
    const reply = { ...response(frame, undefined, false), error: 'parent_mismatch' };
    send(socket, reply);
    expect(await result).toEqual(reply);
  });

  test('deadlines reject once and late replies cannot satisfy a reused ID or become events', async () => {
    const host = await fakeHost();
    const client = clientFor(host, { timeoutMs: 1000 });
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seen = once(host.events, 'request');
    const result = client.request({ type: 'prompt', id: 'timed', sessionId: 's', message: 'not a real model request' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'rpc_request_timeout', uncertain: true });
    const [{ socket, frame }] = await seen;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await expect(client.request({ type: 'prompt', id: 'timed', sessionId: 's' })).rejects.toMatchObject({ code: 'invalid_request_id' });
    const barrierSeen = once(host.events, 'request');
    const barrier = client.request({ type: 'get_state', id: 'barrier' });
    const [next] = await barrierSeen;
    socket.write(`${JSON.stringify(response(frame))}\n${JSON.stringify(response(next.frame))}\n`);
    await barrier;
    expect(events).toEqual([]);
    expect(host.frames.filter((value) => value.type === 'prompt')).toHaveLength(1);
  });

  test('disconnect rejects pending mutations and reconnect never replays them', async () => {
    const host = await fakeHost();
    const client = clientFor(host);
    const notifications = [];
    client.subscribe((event) => notifications.push(event));
    await client.connect();
    const seen = once(host.events, 'request');
    const result = client.request({ type: 'prompt', sessionId: 's', message: 'wire only' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'rpc_transport_gone', uncertain: true });
    const [{ socket }] = await seen;
    const closed = once(socket, 'close');
    socket.destroy();
    await rejected;
    await closed;
    await client.connect();
    expect(host.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    expect(notifications.filter((event) => event.type === 'transport_disconnected')).toHaveLength(1);
    client.disconnect();
    expect(host.frames.some((frame) => ['close_session', 'shutdown', 'host_stop'].includes(frame.type))).toBe(false);
  });

  test.each(['{bad json}\n', '[]\n', '{"type":"response","id":"bad","command":"wrong","success":true}\n'])(
    'rejects malformed wire frames without losing pending request errors',
    async (wire) => {
      const host = await fakeHost();
      const client = clientFor(host);
      await client.connect();
      const seen = once(host.events, 'request');
      const result = client.request({ type: 'get_state', id: 'bad' });
      const rejected = expect(result).rejects.toMatchObject({ code: 'rpc_invalid_frame' });
      const [{ socket }] = await seen;
      socket.write(wire);
      await rejected;
    },
  );

  test('does not accept an unterminated trailing response on socket closure', async () => {
    const host = await fakeHost();
    const client = clientFor(host);
    await client.connect();
    const seen = once(host.events, 'request');
    const result = client.request({ type: 'get_state', id: 'tail' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'rpc_transport_gone' });
    const [{ socket, frame }] = await seen;
    socket.end(JSON.stringify(response(frame, { accepted: false })));
    await rejected;
  });

  test('discovery observes without client registration and refuses mutations', async () => {
    const host = await fakeHost();
    const client = clientFor(host);
    await client.connect({ observe: true });
    await expect(client.request({ type: 'open_session' })).rejects.toMatchObject({ code: 'read_only_endpoint' });
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0].observe).toBe(true);
  });

  test('authenticates terminal control separately and permits only read operations', async () => {
    const info = { ...protocol, mode: 'tui', capabilities: ['tui_control'] };
    const host = await fakeHost({ info, terminal: true });
    const before = await readFile(`${host.socketPath}.secret`);
    const client = clientFor(host);
    await expect(client.connect()).resolves.toEqual(info);
    await expect(client.request({ type: 'open_session' })).rejects.toMatchObject({ code: 'read_only_endpoint' });
    await expect(client.request({ type: 'set_session_name', name: 'foreign' })).rejects.toMatchObject({ code: 'read_only_endpoint' });
    expect(host.frames.map((frame) => frame.type)).toEqual(['get_protocol_info']);
    expect(await readFile(`${host.socketPath}.secret`)).toEqual(before);
  });

  test('reports dead sockets without exposing the private address in errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-missing-'));
    try {
      const socketPath = path.join(root, 'missing.sock');
      const client = createHostClient({ socketPath });
      await expect(client.connect()).rejects.toMatchObject({ code: 'rpc_transport_gone' });
      await expect(client.connect()).rejects.not.toThrow(socketPath);
      client.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
