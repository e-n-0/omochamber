// QA-only foreign-window probe; excluded from native bundle and packaging.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__OMO_QA_PROBE__', {
  notify: () => ipcRenderer.invoke('omochamber:invoke', 'notify', { title: 'Foreign IPC must fail' }),
});
