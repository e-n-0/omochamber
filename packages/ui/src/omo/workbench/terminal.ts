import type { CreateTerminalOptions, TerminalHandlers, TerminalSession, TerminalStreamEvent } from '@/lib/api/types';
import {
  closeTerminal, connectTerminalStream, createTerminalSession, listTerminalSessions,
  resizeTerminal, sendTerminalInput, terminalSnapshotSize, updateTerminalAppearance,
} from '@/lib/terminalApi';
import type { TerminalChunk } from '@/stores/useTerminalStore';

const services = {
  create: createTerminalSession, list: listTerminalSessions, close: closeTerminal,
  connect: connectTerminalStream, resize: resizeTerminal, write: sendTerminalInput,
  appearance: updateTerminalAppearance,
};
type TerminalServices = typeof services;
type TerminalTab = Pick<TerminalSession, 'sessionId' | 'status'>;
type TerminalBuffer = {
  chunks: TerminalChunk[];
  sequence: number;
  status: 'attaching' | 'running' | 'exited' | 'reconnecting' | 'error';
  truncated: boolean;
};
const EMPTY_BUFFER: TerminalBuffer = { chunks: [], sequence: -1, status: 'attaching', truncated: false };
const MAX_BUFFER_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const errorOf = (cause: unknown) => cause instanceof Error ? cause : new Error('Terminal operation failed', { cause });

/** Metadata is independent of output so text deltas only notify the viewport leaf. */
export function createTerminalWorkspace(directory: string, api: TerminalServices = services) {
  const listeners = new Set<() => void>();
  let tabs: TerminalTab[] = [];
  let selected: string | null = null;
  let error: Error | null = null;
  let busy = false;
  let active = false;
  let disposed = false;
  let lifetime = 0;
  let listRevision = 0;
  let detach: (() => void) | null = null;
  let attachment = 0;
  let chunkId = 0;
  const buffers = new Map<string, TerminalBuffer>();
  const notify = () => { if (!disposed) listeners.forEach((listener) => listener()); };
  function receive(id: string, event: TerminalStreamEvent) {
    const previous = buffers.get(id) ?? EMPTY_BUFFER;
    if (event.type === 'reconnecting') {
      buffers.set(id, { ...previous, status: 'reconnecting' });
      notify();
      return;
    }
    if (event.type !== 'snapshot' && event.sequence !== undefined && event.sequence <= previous.sequence) return;
    let chunks = event.type === 'snapshot' ? [] : previous.chunks;
    let truncated = event.type === 'snapshot' ? false : previous.truncated;
    if (event.data !== undefined) {
      let data = event.data;
      let replayData = event.replayData;
      const bytes = encoder.encode(data);
      if (bytes.byteLength > MAX_BUFFER_BYTES) {
        let start = bytes.byteLength - MAX_BUFFER_BYTES;
        while ((bytes[start] & 0xc0) === 0x80) start++;
        data = decoder.decode(bytes.subarray(start));
        replayData = data;
        truncated = true;
      }
      const chunk: TerminalChunk = {
        id: ++chunkId, data, replayData,
        byteLength: encoder.encode(data).byteLength, size: terminalSnapshotSize(event),
      };
      chunks = [...chunks, chunk];
      let bytesRetained = chunks.reduce((sum, value) => sum + value.byteLength, 0);
      while (bytesRetained > MAX_BUFFER_BYTES && chunks.length > 1) {
        const removed = chunks.shift();
        if (removed) bytesRetained -= removed.byteLength;
        truncated = true;
      }
      if (event.type === 'snapshot' && chunk.byteLength >= MAX_BUFFER_BYTES - 4) truncated = true;
    }
    const status = event.type === 'exit' ? 'exited' : event.status ?? (event.type === 'snapshot' ? 'running' : previous.status);
    buffers.set(id, { chunks, truncated, sequence: event.sequence ?? previous.sequence, status });
    if (event.type === 'exit' || event.type === 'snapshot') {
      const tab = tabs.find((value) => value.sessionId === id);
      const tabStatus = status === 'exited' ? 'exited' : status === 'error' ? 'error' : 'running';
      if (tab && tab.status !== tabStatus) tabs = tabs.map((value) => value === tab ? { ...value, status: tabStatus } : value);
      if (event.type === 'snapshot') error = null;
    }
    notify();
  }
  function attach() {
    const generation = ++attachment;
    detach?.();
    detach = null;
    const id = selected;
    if (!active || !id || disposed) return;
    const previous = buffers.get(id) ?? EMPTY_BUFFER;
    buffers.set(id, { ...previous, status: 'attaching' });
    const onError: TerminalHandlers['onError'] = (cause, fatal) => {
      if (generation !== attachment || disposed) return;
      error = cause;
      buffers.set(id, { ...(buffers.get(id) ?? EMPTY_BUFFER), status: fatal ? 'error' : 'reconnecting' });
      notify();
    };
    detach = api.connect(id, (event) => {
      if (generation === attachment && !disposed) receive(id, event);
    }, onError, directory);
    notify();
  }
  async function refresh() {
    const generation = ++listRevision;
    try {
      const sessions = await api.list(directory);
      if (generation !== listRevision || disposed) return;
      tabs = sessions.filter((session) => session.cwd === directory && session.mode !== 'command'
        && (!session.purpose || session.purpose.type === 'terminal'))
        .map((session) => ({ sessionId: session.sessionId, status: session.status }));
      error = null;
      if (!tabs.some((tab) => tab.sessionId === selected)) {
        selected = tabs[0]?.sessionId ?? null;
        attach();
      }
    } catch (cause) { if (generation === listRevision && !disposed) error = errorOf(cause); }
    notify();
  }
  async function create(appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>) {
    if (busy || disposed) return;
    const allocated = crypto.randomUUID();
    const generation = lifetime;
    busy = true;
    ++listRevision;
    error = null;
    notify();
    try {
      const session = await api.create({ cwd: directory, sessionId: allocated, cols: 80, rows: 24, mode: 'interactive', purpose: { type: 'terminal' }, ...appearance });
      if (disposed || generation !== lifetime) {
        // Deduplicated peers are not ours to clean up.
        if (session.sessionId === allocated) await api.close(allocated, directory);
        return;
      }
      if (!tabs.some((tab) => tab.sessionId === session.sessionId)) tabs = [...tabs, { sessionId: session.sessionId, status: session.status }];
      selected = session.sessionId;
      attach();
    } catch (cause) { error = errorOf(cause); }
    finally { busy = false; notify(); }
  }
  async function close(id: string) {
    if (busy || disposed) return;
    busy = true;
    ++listRevision;
    error = null;
    notify();
    try {
      await api.close(id, directory);
      error = null;
      tabs = tabs.filter((tab) => tab.sessionId !== id);
      buffers.delete(id);
      if (selected === id) { selected = tabs[0]?.sessionId ?? null; attach(); }
    } catch (cause) { error = errorOf(cause); }
    finally { busy = false; notify(); }
  }
  async function write(data: string) {
    const id = selected;
    if (!id || !active || buffers.get(id)?.status !== 'running') return;
    try { await api.write(id, data, directory); }
    catch (cause) { error = errorOf(cause); notify(); }
  }
  async function resize(id: string, cols: number, rows: number) {
    if (disposed || !tabs.some((tab) => tab.sessionId === id)) return;
    try { await api.resize(id, cols, rows, directory); }
    catch (cause) { error = errorOf(cause); notify(); }
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getTabs: () => tabs, getSelected: () => selected, getError: () => error, isBusy: () => busy,
    getBuffer: (id: string | null) => id ? buffers.get(id) ?? EMPTY_BUFFER : EMPTY_BUFFER,
    select(id: string) { if (id !== selected && tabs.some((tab) => tab.sessionId === id)) { selected = id; attach(); } },
    setActive(value: boolean) {
      // React's development effect replay reuses this owner after cleanup.
      if (value && disposed) { disposed = false; active = false; }
      if (active !== value) { active = value; attach(); }
    },
    async appearance(value: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>) {
      const id = selected;
      if (!active || !id) return;
      try { await api.appearance(id, value, directory); }
      catch (cause) { error = errorOf(cause); notify(); }
    },
    refresh, create, close, write, resize,
    dispose() { disposed = true; ++lifetime; ++listRevision; ++attachment; detach?.(); detach = null; listeners.clear(); },
  };
}
export type TerminalWorkspace = ReturnType<typeof createTerminalWorkspace>;
