import { contextBridge, ipcRenderer } from 'electron';

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const uiUrl = argument('--omochamber-ui-url');
const apiOrigin = argument('--omochamber-api-origin');
const trusted = (() => {
  if (!process.isMainFrame || !uiUrl) return false;
  const expected = new URL(uiUrl);
  return location.protocol === expected.protocol && location.host === expected.host
    && ['/', '/index.html'].includes(location.pathname);
})();

if (trusted) {
  const ui = new URL(uiUrl);
  // Custom-scheme URL.origin is "null" in Node, so derive the standard origin.
  const origin = `${ui.protocol}//${ui.host}`;
  contextBridge.exposeInMainWorld('__OPENCHAMBER_API_BASE_URL__', origin);
  contextBridge.exposeInMainWorld('__OPENCHAMBER_LOCAL_ORIGIN__', apiOrigin);
  contextBridge.exposeInMainWorld('__OMOCHAMBER_DESKTOP__', Object.freeze({
    selectFolder: (options = {}) => ipcRenderer.invoke('omochamber:invoke', 'selectFolder', options),
    selectFile: (options = {}) => ipcRenderer.invoke('omochamber:invoke', 'selectFile', options),
    openPath: (selected) => ipcRenderer.invoke('omochamber:invoke', 'openPath', selected),
    revealPath: (selected) => ipcRenderer.invoke('omochamber:invoke', 'revealPath', selected),
    notify: (input) => ipcRenderer.invoke('omochamber:invoke', 'notify', input),
  }));
}
