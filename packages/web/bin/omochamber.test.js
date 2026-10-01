import { describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { runNativeCli } from './omochamber.js';

function io() {
  const output = { stdout: '', stderr: '' };
  return {
    output, signals: new EventEmitter(),
    stdout: { write(text) { output.stdout += text; } },
    stderr: { write(text) { output.stderr += text; } },
  };
}
describe('direct native CLI', () => {
  test('help does not resolve or start an engine in non-TTY mode', async () => {
    const f = io();
    const result = await runNativeCli(['--help', '--json'], {
      ...f, startServer() { throw new Error('must not start'); },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(f.output.stdout).status).toBe('ok');
    expect(f.output.stderr).toBe('');
    expect(f.signals.listenerCount('SIGINT')).toBe(0);
  });
  test.each([{ mode: ['--json'] }, { mode: ['--quiet'] }, { mode: [] }])('starts foreground and cleans signal listeners for %j', async ({ mode }) => {
    const f = io();
    let options;
    let stops = 0;
    const result = await runNativeCli(['serve', '--port', '0', ...mode], {
      ...f, async startServer(input) {
        options = input;
        return { getPort: () => 4321, async stop() { stops += 1; } };
      },
    });
    expect(options).toEqual({ port: 0, host: '127.0.0.1', runtimeOptions: {} });
    expect(result.exitCode).toBe(0);
    if (mode[0] === '--json') expect(JSON.parse(f.output.stdout)).toEqual({ status: 'ok', runtime: 'omo', url: 'http://127.0.0.1:4321', port: 4321 });
    else expect(f.output.stdout).toBe('http://127.0.0.1:4321\n');
    f.signals.emit('SIGINT');
    await result.stop();
    expect(stops).toBe(1);
    expect(f.signals.listenerCount('SIGINT')).toBe(0);
    expect(f.signals.listenerCount('SIGTERM')).toBe(0);
  });
  test.each([['--port', '-1'], ['--port', '1.5'], ['--port', '65536'], ['unknown'], ['--lan']].map((args) => ({ args })))('rejects %j without startup', async ({ args }) => {
    const f = io();
    const result = await runNativeCli([...args, '--json'], {
      ...f, startServer() { throw new Error('must not start'); },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(f.output.stdout).status).toBe('error');
    expect(f.output.stderr).toBe('');
  });
  test('reports a startup failure in human mode without hanging', async () => {
    const f = io();
    const result = await runNativeCli([], { ...f, async startServer() { throw new Error('Installed runtime unavailable'); } });
    expect(result.exitCode).toBe(1);
    expect(f.output.stdout).toBe('');
    expect(f.output.stderr).toContain('Installed runtime unavailable');
  });
});
