import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDirectory = fileURLToPath(new URL('..', import.meta.url));
const uiDirectory = path.resolve(electronDirectory, '../web/dist');
const output = path.join(electronDirectory, 'dist-bundle/omo');

// Consume the existing web build. This command never prepares an engine.
await fs.access(path.join(uiDirectory, 'index.html'));
const result = await Bun.build({
  entrypoints: ['entry.mjs', 'main.mjs'].map((name) => path.join(electronDirectory, 'omo', name)),
  outdir: output, target: 'node', format: 'esm', naming: '[name].mjs',
  external: ['electron', '@openchamber/web', '@openchamber/web/*', 'bun-pty', 'node-pty', './main.mjs'],
  minify: false, sourcemap: 'none',
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exitCode = 1;
} else {
  await fs.copyFile(path.join(electronDirectory, 'omo/preload.mjs'), path.join(output, 'preload.mjs'));
  await fs.rm(path.join(output, 'web-dist'), { recursive: true, force: true });
  await fs.cp(uiDirectory, path.join(output, 'web-dist'), { recursive: true });
  console.log('[omochamber] native shell bundled with existing web/dist -> dist-bundle/omo');
}
