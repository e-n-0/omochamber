import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startWebUiServer as startNativeServer } from './native.js';

/** Native package entrypoint. Importing it does not start listeners or an engine. */
export function startWebUiServer(options = {}) {
  return startNativeServer({
    uiDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
    ...options,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { runNativeCli } = await import('../bin/omochamber.js');
  const result = await runNativeCli(process.argv.slice(2), { startServer: startWebUiServer });
  process.exitCode = result.exitCode;
}
