import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { createNativeClient, NativeClientError } from './client';
import type { SessionEvent } from './contracts';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../lib/runtime-url';
import { setRuntimeBearerToken } from '../lib/runtime-auth';

describe('native HTTP/SSE client', () => {
  test('uses current runtime routing, bearer auth, exact paths and correlated 202 submissions', async () => {
    const calls: Array<{ path: string; body: string; authorization: string | undefined }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      calls.push({ path: request.url ?? '', body, authorization: request.headers.authorization });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/omo/status') {
        response.end(JSON.stringify({ available: true, protocolVersion: 1, capabilities: ['multi_session'], socketPath: 'private' }));
      } else {
        response.statusCode = 202;
        response.end(JSON.stringify({ requestId: 'req-a', connectionEpoch: 7, accepted: true }));
      }
    });
    const previous = getRuntimeUrlResolver();
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = z.object({ port: z.number().int() }).parse(server.address());
    try {
      const client = createNativeClient();
      configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
      setRuntimeBearerToken('test-bearer');
      expect(await client.status()).toEqual({ available: true, protocolVersion: 1, capabilities: ['multi_session'] });
      await client.execute('session/a', {
        requestId: 'req-a', connectionEpoch: 7, command: { type: 'prompt', text: 'sent once' },
      });
      expect(calls).toEqual([
        { path: '/api/omo/status', body: '', authorization: 'Bearer test-bearer' },
        {
          path: '/api/omo/sessions/session%2Fa/commands', authorization: 'Bearer test-bearer',
          body: JSON.stringify({ requestId: 'req-a', connectionEpoch: 7, command: { type: 'prompt', text: 'sent once' } }),
        },
      ]);
    } finally {
      setRuntimeBearerToken(null);
      setRuntimeUrlResolver(previous);
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });

  test('rejects failed reads without empty success and does not retry uncertain mutations', async () => {
    const paths: string[] = [];
    const client = createNativeClient({
      fetch: async (path) => {
        paths.push(path);
        if (path.endsWith('/commands')) throw new TypeError('Disconnected after forwarding');
        return new Response('', { status: 503 });
      },
    });
    await assert.rejects(client.projects(), (error) => error instanceof NativeClientError && error.status === 503);
    await assert.rejects(client.execute('a', {
      requestId: 'req-a', connectionEpoch: 1, command: { type: 'abort' },
    }), (error) => error instanceof NativeClientError && error.kind === 'transport');
    expect(paths).toEqual(['/api/omo/projects', '/api/omo/sessions/a/commands']);
  });

  test('rejects mismatched native request IDs and epochs rather than accepting another submission', async () => {
    const client = createNativeClient({
      fetch: async () => Response.json({ requestId: 'other', connectionEpoch: 99, accepted: true }, { status: 202 }),
    });
    await assert.rejects(client.execute('a', {
      requestId: 'req-a', connectionEpoch: 1, command: { type: 'abort' },
    }), (error) => error instanceof NativeClientError && error.kind === 'correlation');
  });

  test('parses fragmented UTF-8 multiline SSE and cancels its reader on close', async () => {
    let wire: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { wire = controller; },
      cancel() { cancellations += 1; },
    });
    const client = createNativeClient({
      fetch: async (_path, init) => {
        expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    const events: SessionEvent[] = [];
    let deliver: ((value: SessionEvent) => void) | undefined;
    const delivered = new Promise<SessionEvent>((resolve) => { deliver = resolve; });
    const subscription = client.subscribe('a', (event) => { events.push(event); deliver?.(event); });
    try {
      await subscription.ready;
      const text = ': heartbeat\r\nevent: native\r\ndata: {"type":"native","sessionKey":"a","connectionEpoch":1,\r\n'
        + 'data: "revision":2,"event":{"type":"bash_execution_update","id":"req-a","delta":"café"}}\r\n\r\n';
      const bytes = new TextEncoder().encode(text);
      assert(wire);
      for (const byte of bytes) wire.enqueue(new Uint8Array([byte]));
      expect(await delivered).toEqual({
        type: 'native', sessionKey: 'a', connectionEpoch: 1, revision: 2,
        event: { type: 'bash_execution_update', id: 'req-a', delta: 'café' },
      });
      expect(events).toHaveLength(1);
    } finally {
      subscription.close();
      await subscription.done;
    }
    expect(cancellations).toBe(1);
  });

  test('rejects malformed stream data and cross-session events and releases both readers', async () => {
    for (const data of [
      '{"type":"native","sessionKey":"a","connectionEpoch":1,"revision":1,"event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":-1,"delta":"x"}}}',
      '{"type":"connection","sessionKey":"other","connectionEpoch":1,"revision":1,"connection":"connected"}',
    ]) {
      let cancellations = 0;
      const client = createNativeClient({
        fetch: async () => new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`)); },
          cancel() { cancellations += 1; },
        }), { headers: { 'Content-Type': 'text/event-stream' } }),
      });
      const subscription = client.subscribe('a', () => assert.fail('Invalid event was published'));
      await subscription.ready;
      await assert.rejects(subscription.done, NativeClientError);
      expect(cancellations).toBe(1);
    }
  });

  test('cancels a pending subscription before opening without leaking its response body', async () => {
    let deliver: ((response: Response) => void) | undefined;
    let cancellations = 0;
    const response = new Promise<Response>((resolve) => { deliver = resolve; });
    const client = createNativeClient({ fetch: () => response });
    const subscription = client.subscribe('a', () => assert.fail('Cancelled listener was called'));
    subscription.close();
    assert(deliver);
    deliver(new Response(new ReadableStream({ cancel() { cancellations += 1; } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    await assert.rejects(subscription.ready, NativeClientError);
    await subscription.done;
    expect(cancellations).toBe(1);
  });
});
