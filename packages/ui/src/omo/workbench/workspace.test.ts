import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';
import { createWorkspaceClient, WorkspaceError } from './workspace';

describe('retained workspace HTTP boundary', () => {
  test('real runtime HTTP routing scopes file save diff and Git mutations without leaking auth into URLs', async () => {
    const calls: Array<{ path: string; body: string; auth: string | undefined }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      calls.push({ path: request.url ?? '', body, auth: request.headers.authorization });
      response.setHeader('Content-Type', 'application/json');
      const path = (request.url ?? '').split('?')[0];
      if (path.endsWith('/stat')) response.end(JSON.stringify({ path: '/project/qa.txt', isFile: true, size: 3, mtimeMs: 1 }));
      else if (path.endsWith('/read')) response.end('old');
      else if (path.endsWith('/file-diff')) response.end(JSON.stringify({ path: 'qa.txt', original: 'old', modified: 'new', isBinary: false, submodule: null }));
      else response.end(JSON.stringify({ success: true }));
    });
    const previous = getRuntimeUrlResolver();
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const { port } = z.object({ port: z.number() }).parse(server.address());
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${port}` });
      setRuntimeBearerToken('owned-test-token');
      const client = createWorkspaceClient('/project');
      expect(await client.read('/project/qa.txt')).toBe('old');
      await client.save('/project/qa.txt', 'new');
      expect(await client.diff('qa.txt', false)).toMatchObject({ original: 'old', modified: 'new' });
      await client.stage('qa.txt', false);
      for (const call of calls) {
        expect(new URLSearchParams(call.path.split('?')[1]).get('directory')).toBe('/project');
        expect(call.auth).toBe('Bearer owned-test-token');
        expect(call.path.includes('owned-test-token')).toBe(false);
      }
      expect(calls[2].body).toBe(JSON.stringify({ path: '/project/qa.txt', content: 'new' }));
      expect(calls[4].body).toBe(JSON.stringify({ path: 'qa.txt' }));
    } finally {
      setRuntimeBearerToken(null);
      setRuntimeUrlResolver(previous);
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      expect(server.listening).toBe(false);
    }
  });

  test('malformed DTOs and oversized or binary content never become editable empty files', async () => {
    let mode = 'invalid';
    let reads = 0;
    const client = createWorkspaceClient('/project', async (path) => {
      if (path.endsWith('/status')) return Response.json({ files: [] });
      if (path.endsWith('/stat')) return Response.json({ path: '/project/a', isFile: true, size: mode === 'large' ? 2 * 1024 * 1024 : 3, mtimeMs: 1 });
      reads++;
      return new Response('a\0b');
    });
    await expect(client.status()).rejects.toThrow();
    mode = 'large';
    await assert.rejects(client.read('/project/a'), (error) => error instanceof WorkspaceError && error.status === 413 && error.code === 'file_too_large');
    expect(reads).toBe(0);
    mode = 'binary';
    await assert.rejects(client.read('/project/a'), (error) => error instanceof WorkspaceError && error.code === 'binary_file');
    expect(reads).toBe(1);
  });
});
