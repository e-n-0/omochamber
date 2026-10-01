#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBunExecutable } from './lib/bun-executable.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createProductTaskPipelines({
  bunBinary = resolveBunExecutable(),
  nodeBinary = process.execPath,
} = {}) {
  const bun = (args, env = {}) => ({
    command: bunBinary,
    args,
    cwd: repoRoot,
    env,
  });

  return {
    postinstall: [
      { command: nodeBinary, args: ['./fix-deprecation.js'], cwd: repoRoot },
      bun(['run', '--cwd', 'packages/sdk', 'build']),
      bun(['run', 'extensions:build']),
    ],
    'web-build': [
      bun(['run', 'extensions:build']),
      bun(['run', '--cwd', 'packages/web', 'vite', 'build'], {
        NODE_OPTIONS: '--max-old-space-size=6144',
      }),
    ],
    build: [
      bun(['run', '--cwd', 'packages/sdk', 'build']),
      bun(['run', 'build:ui']),
      bun(['run', 'build:web']),
      bun(['run', 'build:electron']),
    ],
  };
}

export async function runSequentially(steps, execute = executeStep) {
  for (const step of steps) {
    const exitCode = await execute(step);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

function executeStep({ command, args, cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const pipeline = createProductTaskPipelines()[process.argv[2]];
  if (!pipeline) {
    console.error('Choose one product task: build, postinstall, web-build.');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await runSequentially(pipeline);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
