// Minimal, explicitly enumerated bridge. The renderer never touches Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhv', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getMode: () => ipcRenderer.invoke('get-mode'),
  set: (key, value) => ipcRenderer.invoke('set', key, value),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, s) => fn(s)),
  getNowPlaying: () => ipcRenderer.invoke('get-nowplaying'),
  onNowPlaying: (fn) => ipcRenderer.on('nowplaying', (_e, np) => fn(np)),
  reportSource: (src) => ipcRenderer.send('source', src),
  hide: () => ipcRenderer.send('hide'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
});
