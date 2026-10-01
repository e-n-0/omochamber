import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ThemeSystemContext } from '../contexts/theme-system-context';
import type { ThemeContextValue } from '../contexts/theme-system-context';
import { CSSVariableGenerator } from '../lib/theme/cssGenerator';
import { getDefaultTheme, getThemeById, themes } from '../lib/theme/themes';
import { DEFAULT_UI_FONT, DEFAULT_MONO_FONT, UI_FONT_OPTION_MAP, CODE_FONT_OPTION_MAP, UI_FONT_OPTIONS } from '../lib/fontOptions';
import { loadUiFont } from '../lib/fontLoader';
import { subscribeRuntimeEndpointChanged } from '../lib/runtime-switch';
import type { ThemeMode } from '../types/theme';
import type { NativeClient } from './client';
import { NativeAppearanceContext } from './appearance/context';
import { createAppearanceController } from './appearance/state';

const subscribeRuntime = (listener: () => void) => subscribeRuntimeEndpointChanged(() => listener());

export function OmoAppearanceProvider({ client, children }: { client: NativeClient; children: ReactNode }) {
  const runtimeKey = useSyncExternalStore(subscribeRuntime, client.runtimeKey, client.runtimeKey);
  return <AppearanceScope key={runtimeKey} client={client}>{children}</AppearanceScope>;
}

function AppearanceScope({ client, children }: { client: NativeClient; children: ReactNode }) {
  const controller = useMemo(() => createAppearanceController(client), [client]);
  const appearance = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { settings, updateSettings, reload } = appearance;
  const [systemDark, setSystemDark] = useState(() => globalThis.window?.matchMedia('(prefers-color-scheme: dark)').matches ?? false);
  const generator = useMemo(() => new CSSVariableGenerator(), []);
  const selection = settings.theme ?? 'system';
  const selectedTheme = getThemeById(selection);
  const themeMode: ThemeMode = selection === 'system' ? 'system'
    : selectedTheme?.metadata.variant ?? (selection === 'dark' ? 'dark' : 'light');
  const currentTheme = selectedTheme ?? getDefaultTheme(themeMode === 'system' ? systemDark : themeMode === 'dark');
  const font = UI_FONT_OPTIONS.find((option) => option.id === settings.fontFamily || option.stack === settings.fontFamily);
  const fontFamily = font?.stack ?? settings.fontFamily ?? UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack;

  useEffect(() => {
    void controller.start().catch(() => {}); // Failure stays visible through the native context.
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (font) void loadUiFont(font.id);
  }, [font]);

  // Restore only the document cosmetics owned by this provider when it unmounts.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const properties = ['font-size', '--font-sans', '--font-mono', '--padding-scale', 'color-scheme'];
    const original = properties.map((name) => ({
      name, value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name),
    }));
    const dark = root.classList.contains('dark');
    const light = root.classList.contains('light');
    const dataTheme = root.getAttribute('data-theme');
    const oldStyle = document.getElementById('opencode-theme-variables');
    const bodyBackground = document.body.style.backgroundColor;
    const meta = document.querySelector('meta[name="theme-color"]');
    const metaContent = meta?.getAttribute('content') ?? null;
    return () => {
      for (const { name, value, priority } of original) {
        if (value) root.style.setProperty(name, value, priority);
        else root.style.removeProperty(name);
      }
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', light);
      if (dataTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', dataTheme);
      document.getElementById('opencode-theme-variables')?.remove();
      if (oldStyle) document.head.appendChild(oldStyle);
      document.body.style.backgroundColor = bodyBackground;
      const currentMeta = document.querySelector('meta[name="theme-color"]');
      if (!meta) currentMeta?.remove();
      else if (metaContent === null) meta.removeAttribute('content');
      else meta.setAttribute('content', metaContent);
    };
  }, []);

  useLayoutEffect(() => {
    generator.apply(currentTheme);
    document.documentElement.style.colorScheme = currentTheme.metadata.variant;
    document.body.style.backgroundColor = currentTheme.colors.surface.background;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', currentTheme.colors.surface.background);
  }, [currentTheme, generator]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (settings.fontSize === undefined) root.style.removeProperty('font-size');
    else root.style.fontSize = `${settings.fontSize}px`;
    root.style.setProperty('--font-sans', fontFamily);
    root.style.setProperty('--font-mono', CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack);
    // Native density uses the same spacing scale as the existing appearance slider.
    root.style.setProperty('--padding-scale', String(settings.layout === 'compact' ? Math.sqrt(0.75) : 1));
  }, [settings.fontSize, settings.layout, fontFamily]);

  const themeContext = useMemo<ThemeContextValue>(() => {
    const choose = (id: string) => {
      const theme = getThemeById(id);
      if (!theme) return;
      void updateSettings({ theme: theme.metadata.id }).catch(() => {});
    };
    const mode = (value: ThemeMode) => {
      void updateSettings({ theme: value === 'system' ? 'system' : getDefaultTheme(value === 'dark').metadata.id }).catch(() => {});
    };
    return {
      currentTheme, availableThemes: themes, customThemeIds: [], customThemesLoading: false,
      setTheme: choose, themeMode, setThemeMode: mode,
      isSystemPreference: themeMode === 'system',
      setSystemPreference: (use) => mode(use ? 'system' : currentTheme.metadata.variant),
      lightThemeId: currentTheme.metadata.variant === 'light' ? currentTheme.metadata.id : getDefaultTheme(false).metadata.id,
      darkThemeId: currentTheme.metadata.variant === 'dark' ? currentTheme.metadata.id : getDefaultTheme(true).metadata.id,
      // Native settings keep one active theme, not legacy per-mode preferences.
      setLightThemePreference: (id) => { if (getThemeById(id)?.metadata.variant === 'light') choose(id); },
      setDarkThemePreference: (id) => { if (getThemeById(id)?.metadata.variant === 'dark') choose(id); },
      reloadCustomThemes: reload,
      importTheme: async () => { throw new Error('Native theme import is unavailable'); },
      deleteImportedTheme: async () => { throw new Error('Native theme deletion is unavailable'); },
    };
  }, [currentTheme, themeMode, updateSettings, reload]);

  return (
    <NativeAppearanceContext.Provider value={appearance}>
      <ThemeSystemContext.Provider value={themeContext}>{children}</ThemeSystemContext.Provider>
    </NativeAppearanceContext.Provider>
  );
}
