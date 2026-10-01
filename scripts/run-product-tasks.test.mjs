import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { createProductTaskPipelines, runSequentially } from './run-product-tasks.mjs';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('product task pipelines', () => {
  test('builds only shared, web, and desktop targets', () => {
    const pipelines = createProductTaskPipelines({ bunBinary: 'bun', nodeBinary: 'node' });

    expect(pipelines.build.map(({ args }) => args)).toEqual([
      ['run', '--cwd', 'packages/sdk', 'build'],
      ['run', 'build:ui'],
      ['run', 'build:web'],
      ['run', 'build:electron'],
    ]);
  });

  test('postinstall does not prepare Electron or OpenCode binaries', () => {
    const pipelines = createProductTaskPipelines({ bunBinary: 'bun', nodeBinary: 'node' });

    expect(pipelines.postinstall.map(({ args }) => args)).toEqual([
      ['./fix-deprecation.js'],
      ['run', '--cwd', 'packages/sdk', 'build'],
      ['run', 'extensions:build'],
    ]);
  });

  test('root desktop commands delegate to native package-owned scripts', () => {
    expect(rootPackage.scripts['build:electron']).toBe('bun run --cwd packages/electron native:build');
    expect(rootPackage.scripts['electron:dev']).toBe('bun run --cwd packages/electron native:dev');
    expect(rootPackage.scripts['electron:build']).toBe('bun run --cwd packages/electron native:build');
    expect(rootPackage.scripts['electron:dev:bundled']).toBeUndefined();
  });

  test('stops after the first failed step and preserves its exit code', async () => {
    const calls = [];
    const steps = [{ id: 'first' }, { id: 'failed' }, { id: 'not-run' }];

    const exitCode = await runSequentially(steps, async ({ id }) => {
      calls.push(id);
      return id === 'failed' ? 7 : 0;
    });

    expect(exitCode).toBe(7);
    expect(calls).toEqual(['first', 'failed']);
  });
});
