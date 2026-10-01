import { app, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

app.setName('OmoChamber');
app.setAppUserModelId('dev.omochamber.desktop');
if (process.platform === 'linux') app.setDesktopName('omochamber.desktop');
app.setPath('userData', process.env.OMOCHAMBER_DESKTOP_USER_DATA_DIR
  || path.join(app.getPath('appData'), app.isPackaged ? 'OmoChamber' : 'OmoChamber Dev'));
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
protocol.registerSchemesAsPrivileged([{
  scheme: 'openchamber-ui',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
}]);

export let desktop;
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', () => {
    const window = desktop?.getWindow();
    if (window && !window.isDestroyed()) { window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    const electron = await import('electron');
    const { createNativeDesktop } = await import('./main.mjs');
    const { startWebUiServer } = await import('@openchamber/web/server/index.js');
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const bundled = app.isPackaged || process.env.OMOCHAMBER_DESKTOP_BUNDLED === '1';
    const port = Number(process.env.OMOCHAMBER_DESKTOP_PORT || 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid desktop backend port');
    if (!bundled && !process.env.OMOCHAMBER_UI_URL) throw new Error('Use native:dev or native:dev:bundled');
    desktop = createNativeDesktop({
      electron, startServer: startWebUiServer,
      options: {
        port, dataDir: process.env.OMOCHAMBER_DATA_DIR,
        uiUrl: bundled ? undefined : process.env.OMOCHAMBER_UI_URL,
        uiDirectory: app.isPackaged ? path.join(process.resourcesPath, 'web-dist') : path.join(directory, 'web-dist'),
        preloadPath: path.join(directory, 'preload.mjs'),
      },
    });
    await desktop.start();
    console.log('[omochamber] desktop ready');
  }).catch(async (error) => {
    console.error('[omochamber] startup failed:', error);
    try { await desktop?.stop(); }
    catch (cleanupError) { console.error('[omochamber] cleanup failed:', cleanupError); }
    app.exit(1);
  });
}
