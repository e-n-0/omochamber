import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createNativeDesktopCapabilities, type NativeDesktopBridge } from './adapter';

function bridge(replies = {
  folder: '/canonical/project', file: '/canonical/project/source.ts', path: null,
  notification: { supported: true },
}): NativeDesktopBridge {
  return {
    selectFolder: async () => replies.folder,
    selectFile: async () => replies.file,
    openPath: async () => replies.path,
    revealPath: async () => replies.path,
    notify: async () => replies.notification,
  };
}

test('missing preload leaves the desktop capability absent', () => {
  expect(createNativeDesktopCapabilities(undefined)).toBeUndefined();
});

test('all five methods preserve native arguments and parse replies', async () => {
  const recorded: unknown[][] = [];
  const native = createNativeDesktopCapabilities({
    selectFolder: async (options) => { recorded.push(['selectFolder', options]); return '/canonical/project'; },
    selectFile: async (options) => { recorded.push(['selectFile', options]); return null; },
    openPath: async (path) => { recorded.push(['openPath', path]); return null; },
    revealPath: async (path) => { recorded.push(['revealPath', path]); return null; },
    notify: async (input) => { recorded.push(['notify', input]); return { supported: false }; },
  });
  if (!native) throw new Error('Desktop fixture missing');
  expect(await native.selectFolder({ defaultPath: '/typed' })).toBe('/canonical/project');
  expect(await native.selectFile({ defaultPath: '/canonical/project' })).toBeNull();
  expect(await native.openPath('/canonical/project/source.ts')).toBeNull();
  expect(await native.revealPath('/canonical/project/source.ts')).toBeNull();
  expect(await native.notify({ title: 'OmoChamber', body: 'BODY_SENTINEL' })).toEqual({ supported: false });
  expect(recorded).toEqual([
    ['selectFolder', { defaultPath: '/typed' }],
    ['selectFile', { defaultPath: '/canonical/project' }],
    ['openPath', '/canonical/project/source.ts'],
    ['revealPath', '/canonical/project/source.ts'],
    ['notify', { title: 'OmoChamber', body: 'BODY_SENTINEL' }],
  ]);
});

test('malformed IPC results never become trusted consumer values', async () => {
  const native = createNativeDesktopCapabilities({
    ...bridge(), selectFolder: async () => ({ supported: true }), selectFile: async () => '',
    openPath: async () => '/unexpected', revealPath: async () => ({ supported: true }),
    notify: async () => null,
  });
  if (!native) throw new Error('Desktop fixture missing');
  await expect(native.selectFolder()).rejects.toThrow(z.ZodError);
  await expect(native.selectFile()).rejects.toThrow(z.ZodError);
  await expect(native.openPath('/canonical/project')).rejects.toThrow(z.ZodError);
  await expect(native.revealPath('/canonical/project')).rejects.toThrow(z.ZodError);
  await expect(native.notify({ title: 'OmoChamber' })).rejects.toThrow(z.ZodError);
});

test('native permission refusal is preserved without retry or fabricated success', async () => {
  let calls = 0;
  const refusal = new Error('NATIVE_GRANT_REFUSED');
  const native = createNativeDesktopCapabilities({
    ...bridge(), openPath: async () => { calls++; throw refusal; },
  });
  if (!native) throw new Error('Desktop fixture missing');
  await expect(native.openPath('/outside')).rejects.toThrow(refusal.message);
  expect(calls).toBe(1);
});
