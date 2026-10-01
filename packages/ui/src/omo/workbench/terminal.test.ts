import { describe, expect, test } from 'bun:test';
import type { CreateTerminalOptions, TerminalHandlers, TerminalSession } from '@/lib/api/types';
import { createTerminalWorkspace } from './terminal';

function fixture() {
  const calls: Array<{ action: string; id?: string; directory?: string | null; cols?: number; rows?: number; data?: string }> = [];
  const handlers = new Map<string, TerminalHandlers>();
  let failClose = false;
  const session: TerminalSession = { sessionId: 'peer', status: 'running', cols: 80, rows: 24 };
  const api = {
    create: async (options: CreateTerminalOptions) => {
      calls.push({ action: 'create', id: options.sessionId, directory: options.cwd });
      return { ...session, sessionId: options.sessionId ?? 'created' };
    },
    list: async (directory: string) => {
      calls.push({ action: 'list', directory });
      return [{ ...session, cwd: directory, status: 'running' as const, createdAt: 1 }];
    },
    close: async (id: string, directory?: string | null) => {
      calls.push({ action: 'close', id, directory });
      if (failClose) throw new Error('refused');
      handlers.get(id)?.onError?.(new Error('Terminal closed'), true);
    },
    connect: (id: string, onEvent: TerminalHandlers['onEvent'], onError?: TerminalHandlers['onError'], directory?: string | null) => {
      calls.push({ action: 'attach', id, directory });
      handlers.set(id, { onEvent, onError });
      return () => { calls.push({ action: 'detach', id, directory }); handlers.delete(id); };
    },
    write: async (id: string, data: string, directory?: string | null) => { calls.push({ action: 'write', id, data, directory }); },
    resize: async (id: string, cols: number, rows: number, directory?: string | null) => { calls.push({ action: 'resize', id, cols, rows, directory }); },
    appearance: async () => {},
  };
  return { calls, handlers, api, refuseClose: () => { failClose = true; } };
}

describe('native terminal ownership and replay', () => {
  test('adopts only the selected directory and scopes attach resize write close', async () => {
    const { api, calls, handlers } = fixture();
    const workspace = createTerminalWorkspace('/project', api);
    workspace.setActive(true);
    await workspace.refresh();
    handlers.get('peer')?.onEvent({ type: 'snapshot', sequence: 2, status: 'running', data: 'ready', cols: 90, rows: 30 });
    expect(workspace.getBuffer('peer').chunks[0].size).toEqual({ cols: 90, rows: 30 });
    await workspace.write('printf marker\r');
    await workspace.resize('peer', 100, 35);
    await workspace.close('peer');
    expect(calls.filter((call) => ['attach', 'resize', 'write', 'close'].includes(call.action))).toEqual([
      { action: 'attach', id: 'peer', directory: '/project' },
      { action: 'write', id: 'peer', data: 'printf marker\r', directory: '/project' },
      { action: 'resize', id: 'peer', cols: 100, rows: 35, directory: '/project' },
      { action: 'close', id: 'peer', directory: '/project' },
    ]);
    expect(workspace.getTabs()).toEqual([]);
    expect(workspace.getError()).toBeNull();
    workspace.dispose();
  });

  test('output does not change tab metadata and duplicate sequences do not replay', async () => {
    const { api, handlers } = fixture();
    const workspace = createTerminalWorkspace('/project', api);
    workspace.setActive(true);
    await workspace.refresh();
    const onEvent = handlers.get('peer')?.onEvent;
    onEvent?.({ type: 'snapshot', sequence: 1, status: 'running', data: 'a' });
    const tabs = workspace.getTabs();
    onEvent?.({ type: 'data', sequence: 2, data: 'b' });
    const buffer = workspace.getBuffer('peer');
    onEvent?.({ type: 'data', sequence: 2, data: 'duplicate' });
    expect(workspace.getTabs()).toBe(tabs);
    expect(workspace.getBuffer('peer')).toBe(buffer);
    expect(buffer.chunks.map((chunk) => chunk.data).join('')).toBe('ab');
    workspace.dispose();
  });

  test('tab hide detaches without closing and reconnect snapshot replaces history', async () => {
    const { api, calls, handlers } = fixture();
    const workspace = createTerminalWorkspace('/project', api);
    workspace.setActive(true);
    await workspace.refresh();
    handlers.get('peer')?.onEvent({ type: 'snapshot', sequence: 1, data: 'old', status: 'running' });
    workspace.setActive(false);
    expect(calls.filter((call) => call.action === 'close')).toHaveLength(0);
    workspace.setActive(true);
    handlers.get('peer')?.onEvent({ type: 'snapshot', sequence: 4, data: 'authoritative', status: 'running', cols: 120, rows: 40 });
    expect(workspace.getBuffer('peer').chunks.map((chunk) => chunk.data)).toEqual(['authoritative']);
    expect(workspace.getBuffer('peer').chunks[0].size).toEqual({ cols: 120, rows: 40 });
    workspace.dispose();
    expect(calls.filter((call) => call.action === 'close')).toHaveLength(0);
  });

  test('close failure preserves tabs and captured output', async () => {
    const { api, handlers, refuseClose } = fixture();
    const workspace = createTerminalWorkspace('/project', api);
    workspace.setActive(true);
    await workspace.refresh();
    handlers.get('peer')?.onEvent({ type: 'snapshot', sequence: 1, data: 'keep', status: 'running' });
    const previous = workspace.getBuffer('peer');
    refuseClose();
    await workspace.close('peer');
    expect(workspace.getTabs()).toHaveLength(1);
    expect(workspace.getBuffer('peer')).toBe(previous);
    expect(workspace.getError()).toBeInstanceOf(Error);
    workspace.dispose();
  });

  test('effect cleanup and reactivation leave terminal creation usable', async () => {
    const { api, calls } = fixture();
    const workspace = createTerminalWorkspace('/project', api);
    workspace.setActive(false);
    workspace.dispose();
    workspace.setActive(true);
    await workspace.create({ themeMode: 'dark' });
    expect(calls.filter((call) => call.action === 'create')).toHaveLength(1);
    expect(workspace.getTabs()).toHaveLength(1);
    workspace.dispose();
  });

  test('dispose during create cleans only the allocated terminal, not an adopted peer', async () => {
    for (const reactivate of [false, true]) for (const peer of [false, true]) {
      const { api, calls } = fixture();
      let settle!: (session: TerminalSession) => void;
      let allocated = '';
      api.create = async (options) => {
        allocated = options.sessionId ?? '';
        return new Promise<TerminalSession>((resolve) => { settle = resolve; });
      };
      const workspace = createTerminalWorkspace('/project', api);
      const pending = workspace.create({ themeMode: 'dark' });
      workspace.dispose();
      if (reactivate) workspace.setActive(true);
      settle({ sessionId: peer ? 'other-owner' : allocated, cols: 80, rows: 24, status: 'running' });
      await pending;
      expect(calls.filter((call) => call.action === 'close')).toEqual(peer ? [] : [{ action: 'close', id: allocated, directory: '/project' }]);
      expect(workspace.getTabs()).toHaveLength(0);
      workspace.dispose();
    }
  });
});
