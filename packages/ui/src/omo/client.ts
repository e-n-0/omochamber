import { z } from 'zod';
import { runtimeFetch, type RuntimeFetchOptions } from '../lib/runtime-fetch';
import { getRuntimeUrlResolver } from '../lib/runtime-url';
import {
  commandAcceptedSchema, commandEnvelopeSchema, createSessionSchema, hostViewSchema,
  nativeSettingsSchema, projectInputSchema, projectSchema, projectUpdateSchema,
  sessionEventSchema, sessionSummarySchema, settingsUpdateSchema, snapshotSchema,
  statusSchema, taskOutputOptionsSchema, taskOutputSchema, uiResponseEnvelopeSchema,
} from './contracts';
import type {
  CommandEnvelope, CreateSession, ProjectInput, ProjectUpdate, SessionEvent,
  SettingsUpdate, TaskOutputOptions, UiResponseEnvelope,
} from './contracts';

export class NativeClientError extends Error {
  readonly name = 'NativeClientError';
  constructor(
    readonly kind: 'http' | 'transport' | 'invalid-response' | 'correlation' | 'stream-ended',
    message: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export interface NativeSubscription {
  /** Resolves once the HTTP event stream is open, before snapshot hydration. */
  readonly ready: Promise<void>;
  /** Rejects on loss/malformed data; deliberate close resolves. */
  readonly done: Promise<void>;
  close(): void;
}
export interface NativeClientOptions {
  readonly fetch?: (path: string, options?: RuntimeFetchOptions) => Promise<Response>;
  readonly requestTimeoutMs?: number;
}
const sessionPath = (key: string) => `/api/omo/sessions/${encodeURIComponent(key)}`;

/** No SDK, legacy sync singleton or store initialization belongs in this client. */
export function createNativeClient(options: NativeClientOptions = {}) {
  const fetchRuntime = options.fetch ?? runtimeFetch;
  const timeoutMs = options.requestTimeoutMs ?? 15_000;

  async function request<T>(
    path: string, schema: z.ZodType<T>, init: RuntimeFetchOptions = {}, expectedStatus?: number,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await fetchRuntime(path, { ...init, signal });
    } catch (cause) {
      throw new NativeClientError('transport', 'Native request did not settle', null, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NativeClientError('http', `Native request returned ${response.status}`, response.status);
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      await response.body?.cancel();
      throw new NativeClientError('invalid-response', `Expected HTTP ${expectedStatus}, received ${response.status}`);
    }
    try {
      return schema.parse(await response.json());
    } catch (cause) {
      throw new NativeClientError('invalid-response', 'Invalid native response', null, { cause });
    }
  }

  const json = (
    method: 'POST' | 'PATCH',
    body: ProjectInput | ProjectUpdate | CreateSession | SettingsUpdate | CommandEnvelope | UiResponseEnvelope,
    signal?: AbortSignal,
  ): RuntimeFetchOptions => ({
    method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  async function submit(key: string, envelope: CommandEnvelope | UiResponseEnvelope, ui: boolean, signal?: AbortSignal) {
    const accepted = await request(
      `${sessionPath(key)}/${ui ? 'ui-responses' : 'commands'}`, commandAcceptedSchema,
      json('POST', envelope, signal), 202,
    );
    if (accepted.requestId !== envelope.requestId || accepted.connectionEpoch !== envelope.connectionEpoch) {
      throw new NativeClientError('correlation', 'Native submission identity mismatch');
    }
    return accepted;
  }

  function subscribe(key: string, listener: (event: SessionEvent) => void, signal?: AbortSignal): NativeSubscription {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const opened = (async () => {
      const response = await fetchRuntime(`${sessionPath(key)}/events`, {
        headers: { Accept: 'text/event-stream' }, signal: combined,
      });
      if (combined.aborted) {
        await response.body?.cancel();
        throw new NativeClientError('transport', 'Native event subscription cancelled');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new NativeClientError('http', `Native event stream returned ${response.status}`, response.status);
      }
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body.cancel();
        throw new NativeClientError('invalid-response', 'Native event stream has invalid content type');
      }
      return response.body.getReader();
    })();
    const ready = opened.then(() => undefined);
    const done = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel(); };
      try {
        reader = await opened;
        combined.addEventListener('abort', cancel, { once: true });
        const decoder = new TextDecoder();
        let pending = '';
        let data: string[] = [];
        // Fetch SSE preserves header auth and runtime routing. No EventSource's
        // implicit reconnect or URL credential management is hidden here.
        while (!combined.aborted) {
          const chunk = await reader.read();
          if (chunk.done) throw new NativeClientError('stream-ended', 'Native event stream disconnected');
          pending += decoder.decode(chunk.value, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            if (line === '') {
              if (data.length && !combined.aborted) {
                const event = sessionEventSchema.parse(JSON.parse(data.join('\n')));
                if (event.sessionKey !== key) {
                  throw new NativeClientError('correlation', 'Native event belongs to another session');
                }
                listener(event);
              }
              data = [];
            } else if (line === 'data' || line.startsWith('data:')) {
              data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
            }
            newline = pending.indexOf('\n');
          }
        }
      } catch (cause) {
        if (combined.aborted) return;
        const error = cause instanceof NativeClientError ? cause
          : new NativeClientError('invalid-response', 'Native event stream failed', null, { cause });
        throw error;
      } finally {
        combined.removeEventListener('abort', cancel);
        await reader?.cancel();
        reader?.releaseLock();
      }
    })();
    // Consumers still receive the rejected promises, but subscription creation
    // cannot cause an unhandled rejection before they install both observers.
    void ready.catch(() => undefined);
    void done.catch(() => undefined);
    return { ready, done, close: () => controller.abort() };
  }

  return {
    /** Resolve at call time; stores must reset when runtime identity changes. */
    runtimeKey: () => getRuntimeUrlResolver().api('/api/omo'),
    status: (signal?: AbortSignal) => request('/api/omo/status', statusSchema, { signal }),
    hosts: (signal?: AbortSignal) => request('/api/omo/hosts', z.array(hostViewSchema), { signal }),
    projects: (signal?: AbortSignal) => request('/api/omo/projects', z.array(projectSchema), { signal }),
    addProject: (input: ProjectInput, signal?: AbortSignal) => request(
      '/api/omo/projects', projectSchema, json('POST', projectInputSchema.parse(input), signal),
    ),
    updateProject: (projectId: string, input: ProjectUpdate, signal?: AbortSignal) => request(
      `/api/omo/projects/${encodeURIComponent(projectId)}`, projectSchema,
      json('PATCH', projectUpdateSchema.parse(input), signal),
    ),
    async removeProject(projectId: string, signal?: AbortSignal): Promise<void> {
      const response = await fetchRuntime(`/api/omo/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) throw new NativeClientError('http', `Native request returned ${response.status}`, response.status);
    },
    sessions: (projectId?: string, signal?: AbortSignal) => request(
      '/api/omo/sessions', z.array(sessionSummarySchema), { query: { projectId }, signal },
    ),
    createSession: (input: CreateSession, signal?: AbortSignal) => request(
      '/api/omo/sessions', sessionSummarySchema, json('POST', createSessionSchema.parse(input), signal),
    ),
    attachSession: (key: string, signal?: AbortSignal) => request(
      `${sessionPath(key)}/attach`, snapshotSchema, { method: 'POST', signal },
    ),
    getSnapshot: (key: string, signal?: AbortSignal) => request(`${sessionPath(key)}/snapshot`, snapshotSchema, { signal }),
    execute: (key: string, envelope: CommandEnvelope, signal?: AbortSignal) =>
      submit(key, commandEnvelopeSchema.parse(envelope), false, signal),
    respond: (key: string, envelope: UiResponseEnvelope, signal?: AbortSignal) =>
      submit(key, uiResponseEnvelopeSchema.parse(envelope), true, signal),
    getTaskOutput: (key: string, taskId: string, input: TaskOutputOptions = {}, signal?: AbortSignal) => request(
      `${sessionPath(key)}/tasks/${encodeURIComponent(taskId)}/output`, taskOutputSchema,
      { query: taskOutputOptionsSchema.parse(input), signal },
    ),
    settings: (signal?: AbortSignal) => request('/api/omo/settings', nativeSettingsSchema, { signal }),
    updateSettings: (input: SettingsUpdate, signal?: AbortSignal) => request(
      '/api/omo/settings', nativeSettingsSchema, json('PATCH', settingsUpdateSchema.parse(input), signal),
    ),
    subscribe,
  };
}
export type NativeClient = ReturnType<typeof createNativeClient>;
