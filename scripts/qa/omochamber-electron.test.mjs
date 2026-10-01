import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { matchingLine, parseDesktopQaArgs } from './omochamber-electron.mjs';

test('desktop QA accepts only scoped modes and records capture opt-out explicitly', () => {
  const options = parseDesktopQaArgs(['--mode', 'bundled', '--manual-pickers', '--skip-os-capture']);
  assert.equal(options.mode, 'bundled');
  assert.equal(options.manualPickers, true);
  assert.equal(options.skipOsCapture, true);
  assert(options.evidenceDir.endsWith('/product/desktop/bundled'));
  assert.throws(() => parseDesktopQaArgs(['--mode', 'remote']));
  assert.throws(() => parseDesktopQaArgs(['--allow-provider-prompts']));
});

test('readiness listener handles split records without elapsed-time polling', async () => {
  const child = new EventEmitter();
  const stream = new PassThrough();
  const ready = matchingLine(child, stream, /READY (\d+)/);
  stream.write('unrelated\nRE');
  stream.write('ADY 4318\n');
  assert.equal((await ready)[1], '4318');
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('child exit fails pending readiness instead of becoming a successful launch', async () => {
  const child = new EventEmitter();
  const stream = new PassThrough();
  const ready = matchingLine(child, stream, /READY/);
  const failed = assert.rejects(ready, /exited/);
  child.emit('exit', 1, null);
  await failed;
  assert.equal(stream.listenerCount('data'), 0);
});

test('readiness deadline is deterministic and releases subscriptions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter();
  const stream = new PassThrough();
  const ready = matchingLine(child, stream, /READY/, 1000);
  const failed = assert.rejects(ready, /deadline/);
  t.mock.timers.tick(1000);
  await failed;
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});
