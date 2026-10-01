import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('./omochamber-browser.mjs', import.meta.url));

test('help works without a browser, native server or staged runtime', async () => {
  const result = await run(process.execPath, [entry, '--help'], {
    env: { ...process.env, OMOWRIGHT_ENTRY: '', OMO_BROWSER_PATH: '' },
  });
  assert.equal(result.stderr, '');
});

test('foreign targets are rejected before acquiring browser resources', async () => {
  await assert.rejects(run(process.execPath, [entry, '--base-url', 'https://foreign.example']), {
    code: 1,
  });
});

test('chat cannot submit a provider prompt without parent authorization', async () => {
  await assert.rejects(run(process.execPath, [
    entry, '--scenario', 'chat', '--base-url', 'http://127.0.0.1',
    '--omowright-entry', '/not-used/omowright.js', '--browser-path', '/not-used/chrome',
  ]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--allow-provider-prompts/);
    return true;
  });
});
