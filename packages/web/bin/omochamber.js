#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { startWebUiServer } from '../server/native.js';
import { createSpinner, canPrompt, intro, outro } from './cli-output.js';

const help = `OmoChamber

Usage: bun packages/web/bin/omochamber.js [serve] [options]

  --port <number>       Loopback HTTP port, default 3000; 0 selects a free port
  --host <address>      Loopback address, default 127.0.0.1
  --data-dir <path>     App-owned settings and worktree directory
  --ui-dir <path>       Serve native browser assets from this directory
  --ui-password <text>  Password for browser login
  --omo-binary <path>   Existing installed OMO executable
  --bun-binary <path>   Existing Bun executable for native hosts
  --agent-dir <path>    Existing native OMO agent directory
  --quiet              Print the listening URL only
  --json               Print machine-readable results
  --help               Show usage without starting a server

OMOCHAMBER_UI_PASSWORD and OMOCHAMBER_DATA_DIR set local defaults.
Runs in the foreground. Ctrl+C stops owned HTTP and terminal resources.
Retained native hosts and sessions stay running.
`;

/** Direct native CLI, independent of the legacy command registry. */
export async function runNativeCli(argv = process.argv.slice(2), {
  startServer = startWebUiServer, stdout = process.stdout, stderr = process.stderr,
  signals = process,
} = {}) {
  let options;
  let server;
  let spinner;
  try {
    const parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        port: { type: 'string' }, host: { type: 'string' },
        'data-dir': { type: 'string' }, 'ui-dir': { type: 'string' },
        'ui-password': { type: 'string' }, 'omo-binary': { type: 'string' },
        'bun-binary': { type: 'string' }, 'agent-dir': { type: 'string' },
        quiet: { type: 'boolean' }, json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    options = parsed.values;
    if (parsed.positionals.length > 1 || (parsed.positionals[0] && parsed.positionals[0] !== 'serve')) throw new Error('Only the serve command is supported');
    if (options.help) {
      stdout.write(options.json ? `${JSON.stringify({ status: 'ok', help })}\n` : help);
      return { exitCode: 0, server: null };
    }
    const port = options.port === undefined ? 3000 : Number(options.port);
    if (options.port !== undefined && !/^\d+$/.test(options.port)) throw new Error('Port must be an integer from 0 to 65535');
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Port must be an integer from 0 to 65535');
    const runtimeOptions = {};
    for (const [flag, key] of [['omo-binary', 'omoBinary'], ['bun-binary', 'bunBinary'], ['agent-dir', 'agentDir']]) {
      if (options[flag] !== undefined) runtimeOptions[key] = path.resolve(options[flag]);
    }
    const interactive = stdout === process.stdout && canPrompt(options);
    if (interactive) intro('OmoChamber');
    spinner = interactive ? createSpinner(options) : null;
    spinner?.start('Starting local server');
    let stopping;
    const stop = () => {
      if (!stopping) stopping = server.stop().finally(() => {
        signals.off('SIGINT', onSignal);
        signals.off('SIGTERM', onSignal);
      });
      return stopping;
    };
    const onSignal = () => {
      void stop().catch((error) => {
        stderr.write(`OmoChamber cleanup failed: ${error.message}\n`);
        process.exitCode = 1;
      });
    };
    const serverOptions = { port, host: options.host ?? '127.0.0.1', runtimeOptions };
    if (options['data-dir']) serverOptions.dataDir = path.resolve(options['data-dir']);
    if (options['ui-dir']) serverOptions.uiDirectory = path.resolve(options['ui-dir']);
    if (options['ui-password'] !== undefined) serverOptions.uiPassword = options['ui-password'];
    server = await startServer(serverOptions);
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    const host = options.host ?? '127.0.0.1';
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${server.getPort()}`;
    spinner?.stop('Local server ready');
    if (options.json) stdout.write(`${JSON.stringify({ status: 'ok', runtime: 'omo', url, port: server.getPort() })}\n`);
    else if (options.quiet || !interactive) stdout.write(`${url}\n`);
    else outro(`OmoChamber is listening at ${url}`);
    return { exitCode: 0, server, stop };
  } catch (error) {
    spinner?.stop('Server startup failed');
    if (server) await server.stop();
    if (options?.json || argv.includes('--json')) stdout.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    else stderr.write(`OmoChamber: ${error.message}\n`);
    return { exitCode: 1, server: null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runNativeCli();
  process.exitCode = result.exitCode;
}
