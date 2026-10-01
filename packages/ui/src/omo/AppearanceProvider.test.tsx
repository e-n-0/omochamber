import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createNativeClient } from './client';
import type { NativeSettings, SettingsUpdate } from './contracts';
import { OmoAppearanceProvider } from './AppearanceProvider';
import { useOmoAppearance, type NativeAppearance } from './appearance/context';
import { createAppearanceController } from './appearance/state';
import { useThemeSystem } from '../contexts/useThemeSystem';
import type { ThemeContextValue } from '../contexts/theme-system-context';
import { getDefaultTheme, getThemeById } from '../lib/theme/themes';
import { CSSVariableGenerator } from '../lib/theme/cssGenerator';
import { UI_FONT_OPTION_MAP, CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '../lib/fontOptions';
import { convertThemeToXterm } from '../lib/terminalTheme';
import { createFlexokiCodeMirrorTheme } from '../lib/codemirror/flexokiTheme';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('native appearance ordering', () => {
  test('hydrates without writes and rejects edits before authority arrives', async () => {
    const calls: string[] = [];
    const settings = deferred<Response>();
    const client = createNativeClient({ fetch: async (path) => { calls.push(path); return settings.promise; } });
    const controller = createAppearanceController(client);
    try {
      const loaded = controller.start();
      await expect(controller.getSnapshot().updateSettings({ theme: 'dark' })).rejects.toThrow();
      settings.resolve(Response.json({ schemaVersion: 1, theme: 'flexoki-dark', fontSize: 18, layout: 'compact' }));
      await loaded;
      expect(controller.getSnapshot().settings).toEqual({
        schemaVersion: 1, theme: 'flexoki-dark', fontSize: 18, layout: 'compact',
      });
      expect(calls).toEqual(['/api/omo/settings']);
    } finally { controller.dispose(); }
  });

  test('serializes choices including a return to the pre-write theme and rejects stale hydration', async () => {
    const first = deferred<Response>();
    const secondStarted = deferred<void>();
    const reloaded = deferred<Response>();
    const patches: SettingsUpdate[] = [];
    let reads = 0;
    let saved: NativeSettings = { schemaVersion: 1, theme: 'light', fontFamily: 'system', fontSize: 16 };
    const client = createNativeClient({ fetch: async (_path, options) => {
      if (options?.method !== 'PATCH') return ++reads === 1 ? Response.json(saved) : reloaded.promise;
      const patch = JSON.parse(String(options.body));
      patches.push(patch);
      if (patches.length === 1) return first.promise;
      saved = { ...saved, ...patch };
      secondStarted.resolve();
      return Response.json(saved);
    } });
    const controller = createAppearanceController(client);
    try {
      await controller.start();
      const oldRead = controller.getSnapshot().reload();
      const dark = controller.getSnapshot().updateSettings({ theme: 'dark', layout: 'compact' });
      const light = controller.getSnapshot().updateSettings({ theme: 'light' });
      expect(controller.getSnapshot().saving).toBe(true);
      saved = { ...saved, theme: 'dark', layout: 'compact' };
      first.resolve(Response.json(saved));
      await dark;
      await secondStarted.promise;
      await light;
      reloaded.resolve(Response.json({ schemaVersion: 1, theme: 'stale-theme' }));
      await oldRead;
      expect(patches).toEqual([{ theme: 'dark', layout: 'compact' }, { theme: 'light' }]);
      expect(controller.getSnapshot().settings).toEqual({
        schemaVersion: 1, theme: 'light', fontFamily: 'system', fontSize: 16, layout: 'compact',
      });
      expect(controller.getSnapshot().saving).toBe(false);
    } finally { controller.dispose(); }
  });

  test('preserves settings on failed read/write, exposes failures and permits an explicit later save', async () => {
    let failed = false;
    let calls = 0;
    const client = createNativeClient({ fetch: async (_path, options) => {
      calls += 1;
      if (failed) return new Response('', { status: 503 });
      return Response.json({ schemaVersion: 1, theme: 'openchamber-dark', fontSize: options?.method === 'PATCH' ? 20 : 16 });
    } });
    const controller = createAppearanceController(client);
    try {
      await controller.start();
      const previous = controller.getSnapshot().settings;
      failed = true;
      await expect(controller.getSnapshot().updateSettings({ fontSize: 20 })).rejects.toThrow();
      expect(controller.getSnapshot().settings).toBe(previous);
      expect(controller.getSnapshot().error).toBeInstanceOf(Error);
      expect(controller.getSnapshot().saving).toBe(false);
      await expect(controller.getSnapshot().reload()).rejects.toThrow();
      expect(controller.getSnapshot().status).toBe('unavailable');
      expect(controller.getSnapshot().settings).toBe(previous);
      failed = false;
      await controller.getSnapshot().reload();
      await controller.getSnapshot().updateSettings({ fontSize: 20 });
      expect(controller.getSnapshot().settings.fontSize).toBe(20);
      expect(controller.getSnapshot().error).toBeNull();
      expect(calls).toBe(5);
    } finally { controller.dispose(); }
  });

  test('invalid and unchanged edits never hit native persistence', async () => {
    let calls = 0;
    const client = createNativeClient({ fetch: async () => {
      calls += 1;
      return Response.json({ schemaVersion: 1, theme: 'system' });
    } });
    const controller = createAppearanceController(client);
    try {
      await controller.start();
      await controller.getSnapshot().updateSettings({ theme: 'system' });
      await expect(controller.getSnapshot().updateSettings({ fontSize: 101 })).rejects.toThrow();
      await expect(controller.getSnapshot().updateSettings({ fontSize: 0 })).rejects.toThrow();
      await expect(controller.getSnapshot().updateSettings({ fontFamily: ' ' })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { controller.dispose(); }
  });

  test('a reload started during a save cannot overwrite its later authoritative result', async () => {
    const read = deferred<Response>();
    const save = deferred<Response>();
    const started = deferred<void>();
    let reads = 0;
    const client = createNativeClient({ fetch: async (_path, options) => {
      if (options?.method === 'PATCH') { started.resolve(); return save.promise; }
      return ++reads === 1 ? Response.json({ schemaVersion: 1, theme: 'light' }) : read.promise;
    } });
    const controller = createAppearanceController(client);
    try {
      await controller.start();
      const saving = controller.getSnapshot().updateSettings({ theme: 'dark' });
      await started.promise;
      const loading = controller.getSnapshot().reload();
      save.resolve(Response.json({ schemaVersion: 1, theme: 'dark' }));
      await saving;
      read.resolve(Response.json({ schemaVersion: 1, theme: 'light' }));
      await loading;
      expect(controller.getSnapshot().settings.theme).toBe('dark');
    } finally { controller.dispose(); }
  });

  test('rejects a changed runtime before forwarding queued saves or adopting old hydration', async () => {
    const read = deferred<Response>();
    let runtimeKey = 'first-runtime';
    let writes = 0;
    const client = {
      ...createNativeClient({ fetch: async (_path, options) => {
        if (options?.method === 'PATCH') writes += 1;
        return read.promise;
      } }),
      runtimeKey: () => runtimeKey,
    };
    const controller = createAppearanceController(client);
    try {
      const loading = controller.start();
      runtimeKey = 'next-runtime';
      read.resolve(Response.json({ schemaVersion: 1, theme: 'dark' }));
      await loading;
      expect(controller.getSnapshot().status).toBe('loading');
      expect(controller.getSnapshot().settings).toEqual({ schemaVersion: 1 });
      await expect(controller.getSnapshot().updateSettings({ theme: 'light' })).rejects.toThrow();
      expect(writes).toBe(0);
    } finally { controller.dispose(); }
  });

  test('disposal aborts hydration, ignores its completion and drains an accepted save', async () => {
    const read = deferred<Response>();
    const save = deferred<Response>();
    const saveStarted = deferred<void>();
    let signal: AbortSignal | undefined;
    let reads = 0;
    const client = createNativeClient({ fetch: async (_path, options) => {
      if (options?.method === 'PATCH') { saveStarted.resolve(); return save.promise; }
      if (++reads > 1) { signal = options?.signal ?? undefined; return read.promise; }
      return Response.json({ schemaVersion: 1, theme: 'light' });
    } });
    const controller = createAppearanceController(client);
    await controller.start();
    const loaded = controller.getSnapshot().reload();
    const saving = controller.getSnapshot().updateSettings({ theme: 'dark' });
    await saveStarted.promise;
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    read.resolve(Response.json({ schemaVersion: 1, theme: 'stale' }));
    save.resolve(Response.json({ schemaVersion: 1, theme: 'dark' }));
    await Promise.all([loaded, saving]);
    expect(controller.getSnapshot().settings.theme).toBe('light');
  });
});

describe('native appearance React compatibility', () => {
  let dom: Window;
  let root: Root;
  let originals: Map<string, PropertyDescriptor | undefined>;
  let current: { appearance: NativeAppearance; theme: ThemeContextValue } | undefined;
  const observers = new Set<() => void>();
  function Probe() {
    const appearance = useOmoAppearance();
    const theme = useThemeSystem();
    current = { appearance, theme };
    useEffect(() => { for (const observer of observers) observer(); });
    return <div className="bg-background text-foreground typography-ui-label">native appearance</div>;
  }
  function view() {
    if (!current) throw new Error('Appearance consumer did not mount');
    return current;
  }
  function observe(predicate: () => boolean) {
    const signal = deferred<void>();
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timer);
      observers.delete(check);
      signal.resolve();
    };
    const timer = setTimeout(() => {
      observers.delete(check);
      signal.reject(new Error('Appearance transition did not arrive'));
    }, 5_000);
    observers.add(check);
    return signal.promise;
  }
  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    originals = new Map();
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
      Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    current = undefined;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    observers.clear();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  });

  test('hydrates semantic colors/fonts/density and shares native saves with editor/terminal contexts', async () => {
    const patches: SettingsUpdate[] = [];
    let saved: NativeSettings = {
      schemaVersion: 1, theme: 'flexoki-dark', fontSize: 18, fontFamily: 'system', layout: 'compact',
    };
    const paths: string[] = [];
    const client = createNativeClient({ fetch: async (path, options) => {
      paths.push(path);
      if (options?.method === 'PATCH') {
        const patch = JSON.parse(String(options.body));
        patches.push(patch);
        saved = { ...saved, ...patch };
      }
      return Response.json(saved);
    } });
    const loaded = observe(() => current?.appearance.status === 'ready');
    await act(async () => root.render(<OmoAppearanceProvider client={client}><Probe /></OmoAppearanceProvider>));
    await act(async () => loaded);
    const dark = getThemeById('flexoki-dark');
    expect(view().theme.currentTheme).toBe(dark);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.getElementById('opencode-theme-variables')?.textContent).toContain(
      new CSSVariableGenerator().generate(view().theme.currentTheme),
    );
    expect(document.documentElement.style.fontSize).toBe('18px');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe(UI_FONT_OPTION_MAP.system.stack);
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe(CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack);
    expect(document.documentElement.style.getPropertyValue('--padding-scale')).toBe(String(Math.sqrt(0.75)));
    expect(patches).toHaveLength(0);
    expect(convertThemeToXterm(view().theme.currentTheme).background).toBe(dark?.colors.surface.background);
    expect(createFlexokiCodeMirrorTheme(view().theme.currentTheme)).toBeDefined();

    const light = observe(() => current?.theme.currentTheme.metadata.variant === 'light' && !current.appearance.saving);
    await act(async () => view().theme.setThemeMode('light'));
    await act(async () => light);
    expect(view().theme.currentTheme).toBe(getDefaultTheme(false));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(getDefaultTheme(false).colors.surface.background);
    await act(async () => view().appearance.updateSettings({ fontSize: 20, fontFamily: UI_FONT_OPTION_MAP.system.stack, layout: 'comfortable' }));
    expect(document.documentElement.style.fontSize).toBe('20px');
    expect(document.documentElement.style.getPropertyValue('--padding-scale')).toBe('1');
    expect(saved.theme).toBe(getDefaultTheme(false).metadata.id);
    expect(saved.fontSize).toBe(20);
    expect(saved.layout).toBe('comfortable');
    expect(patches).toEqual([
      { theme: getDefaultTheme(false).metadata.id },
      { fontSize: 20, fontFamily: UI_FONT_OPTION_MAP.system.stack, layout: 'comfortable' },
    ]);
    expect(paths.every((path) => path === '/api/omo/settings')).toBe(true);
    expect(window.localStorage.length).toBe(0);
    await expect(view().theme.importTheme(getDefaultTheme(false))).rejects.toThrow();
  });

  test('StrictMode reattachment hydrates without writes and restores owned document styles', async () => {
    document.documentElement.style.setProperty('--font-sans', 'previous-font');
    document.documentElement.style.fontSize = '17px';
    document.documentElement.classList.add('light');
    const oldStyle = document.createElement('style');
    oldStyle.id = 'opencode-theme-variables';
    oldStyle.textContent = ':root { --test-before: preserved; }';
    document.head.appendChild(oldStyle);
    let writes = 0;
    const client = createNativeClient({ fetch: async (_path, options) => {
      if (options?.method === 'PATCH') writes += 1;
      return Response.json({ schemaVersion: 1, theme: 'dark' });
    } });
    const loaded = observe(() => current?.appearance.status === 'ready');
    await act(async () => root.render(<StrictMode><OmoAppearanceProvider client={client}><Probe /></OmoAppearanceProvider></StrictMode>));
    await act(async () => loaded);
    expect(view().theme.currentTheme).toBe(getDefaultTheme(true));
    expect(writes).toBe(0);
    await act(async () => root.unmount());
    expect(document.documentElement.style.fontSize).toBe('17px');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('previous-font');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.getElementById('opencode-theme-variables')).toBe(oldStyle);
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  });
});
