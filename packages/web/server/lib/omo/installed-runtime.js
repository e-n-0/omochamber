import { constants, accessSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ENGINE_PACKAGE_NAME = '@code-yeongyu/senpi';
const OMO_PACKAGE_NAME = 'omo-ai';
const SNAPSHOT_MARKER = 'runtime-snapshot.json';
const AGENT_DIR_ENV_NAMES = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'];

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label}${isMissing(error) ? '' : `: ${error.message}`}`);
  }
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function requireFile(filePath, label) {
  if (!isRegularFile(filePath)) throw new Error(`${label} is missing or not a file`);
  return filePath;
}

function isExecutable(filePath, platform) {
  if (!isRegularFile(filePath)) return false;
  if (platform === 'win32') return true;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env, platform) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  const separator = platform === 'win32' ? ';' : ':';
  return key ? (env[key] ?? '').split(separator).filter(Boolean) : [];
}

function findExecutable(name, env, platform) {
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean)
    : [''];
  for (const directory of pathEntries(env, platform)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function resolveOmoEntry(binaryPath, platform) {
  const absolutePath = path.resolve(binaryPath);
  if (!isExecutable(absolutePath, platform)) {
    throw new Error('OMO executable is missing or not executable');
  }

  const realPath = realpathSync(absolutePath);
  if (path.extname(realPath) === '.js' || path.extname(realPath) === '.mjs') return realPath;

  const contents = readFileSync(realPath, 'utf8');
  if (!contents.includes('omo-ai bun launcher shim')) {
    throw new Error('OMO executable does not identify its installed package');
  }
  const entry = contents.match(/^# entry: (.+)$/m)?.[1]?.trim();
  if (!entry || !path.isAbsolute(entry) || !isRegularFile(entry)) {
    throw new Error('OMO launcher metadata does not identify an existing entry point');
  }
  return realpathSync(entry);
}

function findOmoPackageRoot(entryPath) {
  for (let directory = path.dirname(entryPath); ; directory = path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (isRegularFile(manifestPath)) {
      const manifest = readJson(manifestPath, 'OMO package metadata');
      if (manifest.name === OMO_PACKAGE_NAME) {
        if (manifest.bin?.omo !== 'bin/omo.js') {
          throw new Error('OMO package metadata points to a different executable');
        }
        const binPath = realpathSync(path.join(directory, 'bin', 'omo.js'));
        if (binPath !== entryPath) throw new Error('OMO package metadata points to a different executable');
        return realpathSync(directory);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  throw new Error('OMO executable is not inside an installed omo-ai package');
}

function resolveEngineInstallRoot(omoRoot) {
  for (let directory = omoRoot; ; directory = path.dirname(directory)) {
    const candidates = [path.join(directory, 'node_modules', ...ENGINE_PACKAGE_NAME.split('/'))];
    if (path.basename(directory) === 'node_modules') {
      candidates.unshift(path.join(directory, ...ENGINE_PACKAGE_NAME.split('/')));
    }
    for (const candidate of candidates) {
      const manifestPath = path.join(candidate, 'package.json');
      if (!isRegularFile(manifestPath)) continue;
      const manifest = readJson(manifestPath, 'Senpi package metadata');
      if (manifest.name !== ENGINE_PACKAGE_NAME) continue;
      return realpathSync(candidate);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  throw new Error('Installed omo-ai package has no resolvable Senpi dependency');
}

function resolveEngineRoot(engineInstallRoot, agentDir) {
  const manifestPath = path.join(engineInstallRoot, 'dist', 'bundle', 'runtime-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return engineInstallRoot;
    throw new Error(`Could not read Senpi runtime manifest: ${error.message}`);
  }

  if (
    !manifest
    || manifest.buildId !== String(manifest.buildId)
    || !/^[A-Za-z0-9._-]+$/.test(manifest.buildId)
    || !Array.isArray(manifest.externals)
    || !manifest.externals.every((name) => name === String(name))
  ) {
    throw new Error('Senpi runtime manifest is invalid');
  }

  const installId = createHash('sha256').update(engineInstallRoot).digest('hex').slice(0, 12);
  const snapshotPath = path.join(agentDir, 'runtime', `${manifest.buildId}-${installId}`);
  let snapshotRoot;
  try {
    snapshotRoot = realpathSync(snapshotPath);
  } catch {
    throw new Error('Installed Senpi runtime snapshot is missing');
  }

  const marker = readJson(path.join(snapshotRoot, SNAPSHOT_MARKER), 'Senpi runtime snapshot metadata');
  let markerInstallRoot;
  try {
    markerInstallRoot = realpathSync(marker.installPackageDir);
  } catch {
    throw new Error('Senpi runtime snapshot points to a missing installed package');
  }
  if (marker.buildId !== manifest.buildId || markerInstallRoot !== engineInstallRoot) {
    throw new Error('Senpi runtime snapshot does not match the installed package');
  }
  return snapshotRoot;
}

function resolveAgentDir(explicitAgentDir, env, homeDir) {
  if (explicitAgentDir !== undefined) return path.resolve(explicitAgentDir);
  for (const name of AGENT_DIR_ENV_NAMES) {
    const configured = env[name]?.trim();
    if (configured) return path.resolve(configured);
  }
  return path.join(homeDir, '.omo', 'agent');
}

function resolveBunBinary(explicitBunBinary, env, homeDir, platform) {
  if (explicitBunBinary !== undefined) {
    const explicitPath = path.resolve(explicitBunBinary);
    if (!isExecutable(explicitPath, platform)) throw new Error('Configured Bun executable is missing or not executable');
    return realpathSync(explicitPath);
  }
  if (process.versions.bun && isExecutable(process.execPath, platform)) return realpathSync(process.execPath);

  const name = platform === 'win32' ? 'bun.exe' : 'bun';
  const installRoot = env.BUN_INSTALL || path.join(homeDir, '.bun');
  const candidates = [
    path.join(installRoot, 'bin', name),
    path.join(homeDir, '.bun', 'bin', name),
    findExecutable('bun', env, platform),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isExecutable(candidate, platform)) return realpathSync(candidate);
  }
  throw new Error('Bun executable is missing; configure bunBinary or BUN_INSTALL');
}

/**
 * Resolves the installed OMO/Senpi runtime without creating or preparing any runtime files.
 *
 * `omoBinary`, `bunBinary`, and `agentDir` may be supplied explicitly; otherwise the installed
 * OMO launcher metadata, PATH, and OMO's canonical agent-directory environment are used.
 */
export async function resolveInstalledRuntime(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const configuredOmo = options.omoBinary ?? env.OMO_BIN;
  const omoCandidate = configuredOmo ?? findExecutable('omo', env, platform);
  if (!omoCandidate) throw new Error('OMO executable is missing; configure omoBinary or OMO_BIN');

  const omoBinary = resolveOmoEntry(omoCandidate, platform);
  const omoRoot = findOmoPackageRoot(omoBinary);
  const engineInstallRoot = resolveEngineInstallRoot(omoRoot);
  const agentDir = resolveAgentDir(options.agentDir, env, homeDir);
  const engineRoot = resolveEngineRoot(engineInstallRoot, agentDir);
  const cliPath = requireFile(path.join(engineRoot, 'dist', 'cli.js'), 'Senpi CLI');
  const rpcEntryPath = requireFile(path.join(engineRoot, 'dist', 'rpc-entry.js'), 'Senpi RPC entry');
  const pluginRoot = path.join(omoRoot, 'plugin');
  if (!statSync(pluginRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Installed OMO plugin directory is missing');
  }
  const launchSpecPath = requireFile(path.join(pluginRoot, 'daemon-launch-spec.json'), 'OMO daemon launch spec');
  const launchSpec = readJson(launchSpecPath, 'OMO daemon launch spec');
  if (launchSpec.spec_version !== 1) throw new Error('OMO daemon launch spec is unsupported');
  const bunBinary = resolveBunBinary(options.bunBinary, env, homeDir, platform);

  return {
    omoBinary,
    engineRoot,
    pluginRoot,
    agentDir,
    cliPath,
    rpcEntryPath,
    launchSpecPath,
    bunBinary,
  };
}
