import { afterEach, expect, test } from 'bun:test';
import { browser } from '../../ui/src/omo/chat/chatTestFixture';
import { getRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import type { NativeClient } from '@openchamber/ui/omo/client';
import type { NativeDesktopBridge } from '@openchamber/ui/omo/desktop/adapter';
import { initializeNativeDesktopCapability, initializeNativeWebRuntime } from './omo-runtime';

const originalFetch = globalThis.fetch;
const globals = ['__OMOCHAMBER_DESKTOP__', '__OPENCHAMBER_API_BASE_URL__', '__OPENCHAMBER_LOCAL_ORIGIN__', '__OPENCHAMBER_CLIENT_TOKEN__'] as const;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of globals) Reflect.deleteProperty(browser, key);
  browser.happyDOM.setURL('http://localhost');
});

test('local browser keeps NativeClient and same-origin transport without any desktop capability', async () => {
  browser.happyDOM.setURL('http://127.0.0.1:49801');
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json({ available: true, protocolVersion: 1, capabilities: [] });
  };
  setRuntimeExtraHeaders({ 'x-old-fixture': 'stale' });
  const client: NativeClient = initializeNativeWebRuntime();
  expect(initializeNativeDesktopCapability()).toBeUndefined();
  await client.status();
  expect(requests).toEqual(['http://127.0.0.1:49801/api/omo/status']);
  expect(getRuntimeUrlResolver().websocket('/api/terminal/ws')).toBe('ws://127.0.0.1:49801/api/terminal/ws');
  expect(getRuntimeExtraHeadersSync()).toEqual({});
});

test('packaged desktop boot keeps custom-scheme HTTP and owned loopback realtime with parsed capabilities', async () => {
  browser.happyDOM.setURL('openchamber-ui://app/index.html');
  const calls: string[] = [];
  const bridge: NativeDesktopBridge = {
    selectFolder: async () => '/canonical/project', selectFile: async () => null,
    openPath: async (path) => { calls.push(path); return null; },
    revealPath: async () => null, notify: async () => ({ supported: true }),
  };
  for (const [key, value] of Object.entries({
    __OMOCHAMBER_DESKTOP__: bridge, __OPENCHAMBER_API_BASE_URL__: 'openchamber-ui://app',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:49802', __OPENCHAMBER_CLIENT_TOKEN__: 'fixture-token',
  })) Object.defineProperty(browser, key, { configurable: true, value });
  const client: NativeClient = initializeNativeWebRuntime();
  const desktop = initializeNativeDesktopCapability();
  if (!desktop) throw new Error('Missing desktop fixture capability');
  expect(client.runtimeKey()).toBe('openchamber-ui://app/api/omo');
  expect(getRuntimeUrlResolver().api('/api/omo/status')).toBe('openchamber-ui://app/api/omo/status');
  expect(getRuntimeUrlResolver().websocket('/api/terminal/ws')).toBe('ws://127.0.0.1:49802/api/terminal/ws');
  expect(getRuntimeBearerTokenSync()).toBe('fixture-token');
  expect(await desktop.selectFolder()).toBe('/canonical/project');
  expect(await desktop.openPath('/canonical/project')).toBeNull();
  expect(calls).toEqual(['/canonical/project']);
});
