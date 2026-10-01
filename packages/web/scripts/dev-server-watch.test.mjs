import { describe, expect, it } from 'vitest';

import { createDevServerWatchCommand } from './dev-server-watch.mjs';

describe('createDevServerWatchCommand', () => {
  it('uses the native CLI and built assets on the package default port', () => {
    const command = createDevServerWatchCommand({
      platform: 'win32',
      env: {},
      bunExecutable: '/opt/bun/bin/bun',
    });

    expect(command.command).toBe('/opt/bun/bin/bun');
    expect(command.args).toEqual(['--watch', 'bin/omochamber.js', '--port', '3001', '--ui-dir', 'dist']);
    expect(command.spawnOptions.windowsHide).toBe(true);
  });

  it('prefers the native port over the old development variable', () => {
    const command = createDevServerWatchCommand({
      platform: 'win32',
      env: {
        OPENCHAMBER_PORT: '58992',
        OMOCHAMBER_PORT: '58993',
      },
      bunExecutable: 'C:\\Tools\\Bun\\bun.exe',
    });

    expect(command.args).toEqual(['--watch', 'bin/omochamber.js', '--port', '58993', '--ui-dir', 'dist']);
  });

  it('rejects an invalid configured port before spawning', () => {
    expect(() => createDevServerWatchCommand({
      platform: 'win32',
      env: { OPENCHAMBER_PORT: 'not-a-port' },
      bunExecutable: 'bun',
    })).toThrow(/Invalid native web port/);
  });

  it('preserves the nodemon watcher command outside Windows', () => {
    const command = createDevServerWatchCommand({
      platform: 'linux',
      env: { OPENCHAMBER_PORT: '4200' },
      bunExecutable: '/opt/bun/bin/bun',
    });

    expect(command.command).toBe('/opt/bun/bin/bun');
    expect(command.args).toEqual([
      'x',
      'nodemon',
      '--watch',
      'server',
      '--watch',
      'bin/omochamber.js',
      '--ext',
      'js',
      '--exec',
      'bun bin/omochamber.js --port 4200 --ui-dir dist',
    ]);
  });
});
