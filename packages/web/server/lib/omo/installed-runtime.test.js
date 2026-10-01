import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveInstalledRuntime } from './installed-runtime.js';

const BUILD_ID = 'runtime-build-1';
const roots = [];
let fixture;

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeExecutable = async (filePath, contents = '#!/bin/sh\nexit 0\n') => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
};

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-installed-runtime-'));
  roots.push(root);

  const homeDir = path.join(root, 'home');
  const omoRoot = path.join(root, 'global', 'node_modules', 'omo-ai');
  const engineTarget = path.join(root, 'engine-install');
  const engineInstallRoot = path.join(root, 'global', 'node_modules', '@code-yeongyu', 'senpi');
  const agentDir = path.join(root, 'state', 'agent');
  const binDir = path.join(root, 'bin');
  const bunBinary = path.join(root, 'bun', 'bin', 'bun');
  const omoEntry = path.join(omoRoot, 'bin', 'omo.js');

  await writeJson(path.join(omoRoot, 'package.json'), {
    name: 'omo-ai',
    version: '5.1.6',
    bin: { omo: 'bin/omo.js' },
    dependencies: { '@code-yeongyu/senpi': '2026.9.30' },
  });
  await writeExecutable(omoEntry, '#!/usr/bin/env node\n');
  await fs.mkdir(path.dirname(engineInstallRoot), { recursive: true });
  await fs.symlink(engineTarget, engineInstallRoot, 'dir');
  await writeJson(path.join(engineTarget, 'package.json'), {
    name: '@code-yeongyu/senpi',
    version: '2026.9.30',
  });
  await writeExecutable(path.join(engineTarget, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await writeExecutable(path.join(engineTarget, 'dist', 'rpc-entry.js'), '#!/usr/bin/env node\n');
  await writeJson(path.join(engineTarget, 'dist', 'bundle', 'runtime-manifest.json'), {
    buildId: BUILD_ID,
    externals: [],
  });
  await writeJson(path.join(omoRoot, 'plugin', 'daemon-launch-spec.json'), {
    spec_version: 1,
    core: { extensions: ['.', './extensions/omo-member.js'] },
  });
  await fs.mkdir(path.join(omoRoot, 'plugin', 'extensions'), { recursive: true });

  const installId = createHash('sha256').update(await fs.realpath(engineInstallRoot)).digest('hex').slice(0, 12);
  const engineRoot = path.join(agentDir, 'runtime', `${BUILD_ID}-${installId}`);
  await writeJson(path.join(engineRoot, 'package.json'), {
    name: '@code-yeongyu/senpi',
    version: '2026.9.30',
  });
  await writeExecutable(path.join(engineRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await writeExecutable(path.join(engineRoot, 'dist', 'rpc-entry.js'), '#!/usr/bin/env node\n');
  await writeJson(path.join(engineRoot, 'runtime-snapshot.json'), {
    buildId: BUILD_ID,
    installPackageDir: await fs.realpath(engineInstallRoot),
  });
  await writeExecutable(bunBinary);
  await fs.mkdir(binDir, { recursive: true });
  const omoLink = path.join(binDir, 'omo');
  await fs.symlink(omoEntry, omoLink);

  return {
    root,
    homeDir,
    omoRoot,
    omoEntry,
    omoLink,
    engineInstallRoot,
    engineTarget,
    engineRoot,
    agentDir,
    binDir,
    bunBinary,
    env: {
      HOME: homeDir,
      BUN_INSTALL: path.dirname(path.dirname(bunBinary)),
      PATH: binDir,
    },
  };
}

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('resolveInstalledRuntime', () => {
  test('resolves explicit paths and follows executable and package symlinks', async () => {
    const explicitOmoLink = path.join(fixture.root, 'configured', 'omo');
    const explicitAgentDir = path.join(fixture.root, 'explicit-agent');
    await fs.mkdir(path.dirname(explicitOmoLink), { recursive: true });
    const installId = createHash('sha256')
      .update(await fs.realpath(fixture.engineInstallRoot))
      .digest('hex')
      .slice(0, 12);
    const explicitEngineRoot = path.join(explicitAgentDir, 'runtime', `${BUILD_ID}-${installId}`);
    await fs.symlink(fixture.omoEntry, explicitOmoLink);
    await writeJson(path.join(explicitEngineRoot, 'runtime-snapshot.json'), {
      buildId: BUILD_ID,
      installPackageDir: await fs.realpath(fixture.engineInstallRoot),
    });
    await writeJson(path.join(explicitEngineRoot, 'package.json'), {
      name: '@code-yeongyu/senpi',
      version: '2026.9.30',
    });
    await writeExecutable(path.join(explicitEngineRoot, 'dist', 'cli.js'));
    await writeExecutable(path.join(explicitEngineRoot, 'dist', 'rpc-entry.js'));

    await expect(resolveInstalledRuntime({
      omoBinary: explicitOmoLink,
      agentDir: explicitAgentDir,
      bunBinary: fixture.bunBinary,
      env: { HOME: fixture.homeDir },
    })).resolves.toEqual({
      omoBinary: await fs.realpath(fixture.omoEntry),
      engineRoot: await fs.realpath(explicitEngineRoot),
      pluginRoot: path.join(await fs.realpath(fixture.omoRoot), 'plugin'),
      agentDir: explicitAgentDir,
      cliPath: path.join(await fs.realpath(explicitEngineRoot), 'dist', 'cli.js'),
      rpcEntryPath: path.join(await fs.realpath(explicitEngineRoot), 'dist', 'rpc-entry.js'),
      launchSpecPath: path.join(await fs.realpath(fixture.omoRoot), 'plugin', 'daemon-launch-spec.json'),
      bunBinary: await fs.realpath(fixture.bunBinary),
    });
  });

  test('discovers defaults from PATH and uses OMO canonical agent settings', async () => {
    const canonicalAgentDir = path.join(fixture.root, 'canonical-agent');
    const installId = createHash('sha256')
      .update(await fs.realpath(fixture.engineInstallRoot))
      .digest('hex')
      .slice(0, 12);
    const canonicalEngineRoot = path.join(canonicalAgentDir, 'runtime', `${BUILD_ID}-${installId}`);
    await writeJson(path.join(canonicalEngineRoot, 'runtime-snapshot.json'), {
      buildId: BUILD_ID,
      installPackageDir: await fs.realpath(fixture.engineInstallRoot),
    });
    await writeJson(path.join(canonicalEngineRoot, 'package.json'), {
      name: '@code-yeongyu/senpi',
      version: '2026.9.30',
    });
    await writeExecutable(path.join(canonicalEngineRoot, 'dist', 'cli.js'));
    await writeExecutable(path.join(canonicalEngineRoot, 'dist', 'rpc-entry.js'));

    const runtime = await resolveInstalledRuntime({
      env: {
        ...fixture.env,
        OMO_CODING_AGENT_DIR: canonicalAgentDir,
        SENPI_CODING_AGENT_DIR: path.join(fixture.root, 'lower-priority-agent'),
      },
    });

    expect(runtime).toEqual({
      omoBinary: await fs.realpath(fixture.omoEntry),
      engineRoot: await fs.realpath(canonicalEngineRoot),
      pluginRoot: path.join(await fs.realpath(fixture.omoRoot), 'plugin'),
      agentDir: canonicalAgentDir,
      cliPath: path.join(await fs.realpath(canonicalEngineRoot), 'dist', 'cli.js'),
      rpcEntryPath: path.join(await fs.realpath(canonicalEngineRoot), 'dist', 'rpc-entry.js'),
      launchSpecPath: path.join(await fs.realpath(fixture.omoRoot), 'plugin', 'daemon-launch-spec.json'),
      bunBinary: await fs.realpath(fixture.bunBinary),
    });
  });

  test('uses the canonical default agent directory when no override exists', async () => {
    const defaultAgentDir = path.join(fixture.homeDir, '.omo', 'agent');
    const installId = createHash('sha256')
      .update(await fs.realpath(fixture.engineInstallRoot))
      .digest('hex')
      .slice(0, 12);
    const defaultEngineRoot = path.join(defaultAgentDir, 'runtime', `${BUILD_ID}-${installId}`);
    await writeJson(path.join(defaultEngineRoot, 'runtime-snapshot.json'), {
      buildId: BUILD_ID,
      installPackageDir: await fs.realpath(fixture.engineInstallRoot),
    });
    await writeJson(path.join(defaultEngineRoot, 'package.json'), {
      name: '@code-yeongyu/senpi',
      version: '2026.9.30',
    });
    await writeExecutable(path.join(defaultEngineRoot, 'dist', 'cli.js'));
    await writeExecutable(path.join(defaultEngineRoot, 'dist', 'rpc-entry.js'));

    const runtime = await resolveInstalledRuntime({ env: fixture.env });

    expect(runtime.agentDir).toBe(defaultAgentDir);
    expect(runtime.engineRoot).toBe(await fs.realpath(defaultEngineRoot));
  });

  test('rejects a missing explicit executable instead of falling back to PATH', async () => {
    await expect(resolveInstalledRuntime({
      omoBinary: path.join(fixture.root, 'missing-omo'),
      bunBinary: fixture.bunBinary,
      env: fixture.env,
    })).rejects.toThrow('OMO executable is missing or not executable');
  });

  test('rejects a missing snapshot without creating runtime state', async () => {
    await fs.rm(fixture.engineRoot, { recursive: true });
    const runtimeDir = path.dirname(fixture.engineRoot);

    await expect(resolveInstalledRuntime({
      omoBinary: fixture.omoLink,
      bunBinary: fixture.bunBinary,
      agentDir: fixture.agentDir,
      env: fixture.env,
    })).rejects.toThrow('Installed Senpi runtime snapshot is missing');

    await expect(fs.readdir(runtimeDir)).resolves.toEqual([]);
  });

  test('rejects snapshot metadata for a different installed package', async () => {
    await writeJson(path.join(fixture.engineRoot, 'runtime-snapshot.json'), {
      buildId: 'stale-build',
      installPackageDir: await fs.realpath(fixture.engineInstallRoot),
    });

    await expect(resolveInstalledRuntime({
      omoBinary: fixture.omoLink,
      bunBinary: fixture.bunBinary,
      agentDir: fixture.agentDir,
      env: fixture.env,
    })).rejects.toThrow('Senpi runtime snapshot does not match the installed package');
  });

  test('rejects missing CLI and RPC modules', async () => {
    await fs.rm(path.join(fixture.engineRoot, 'dist', 'cli.js'));
    await expect(resolveInstalledRuntime({
      omoBinary: fixture.omoLink,
      bunBinary: fixture.bunBinary,
      agentDir: fixture.agentDir,
      env: fixture.env,
    })).rejects.toThrow('Senpi CLI is missing or not a file');

    await writeExecutable(path.join(fixture.engineRoot, 'dist', 'cli.js'));
    await fs.rm(path.join(fixture.engineRoot, 'dist', 'rpc-entry.js'));
    await expect(resolveInstalledRuntime({
      omoBinary: fixture.omoLink,
      bunBinary: fixture.bunBinary,
      agentDir: fixture.agentDir,
      env: fixture.env,
    })).rejects.toThrow('Senpi RPC entry is missing or not a file');
  });

  test('rejects a missing daemon launch spec without preparing it', async () => {
    await fs.rm(path.join(fixture.omoRoot, 'plugin', 'daemon-launch-spec.json'));

    await expect(resolveInstalledRuntime({
      omoBinary: fixture.omoLink,
      bunBinary: fixture.bunBinary,
      agentDir: fixture.agentDir,
      env: fixture.env,
    })).rejects.toThrow('OMO daemon launch spec is missing or not a file');

    await expect(fs.readdir(path.join(fixture.omoRoot, 'plugin'))).resolves.toEqual(['extensions']);
  });
});
