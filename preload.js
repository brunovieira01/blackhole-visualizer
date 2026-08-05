// Minimal, explicitly enumerated bridge. The renderer never touches Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhv', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getMode: () => ipcRenderer.invoke('get-mode'),
  set: (key, value) => ipcRenderer.invoke('set', key, value),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, s) => fn(s)),
  getNowPlaying: () => ipcRenderer.invoke('get-nowplaying'),
  onNowPlaying: (fn) => ipcRenderer.on('nowplaying', (_e, np) => fn(np)),
  media: (cmd) => ipcRenderer.send('media', cmd),

  getOrbitItems: () => ipcRenderer.invoke('get-orbit-items'),
  onOrbitItems: (fn) => ipcRenderer.on('orbit-items', (_e, items) => fn(items)),
  orbitLaunch: (path) => ipcRenderer.send('orbit-launch', path),
  orbitContext: (path) => ipcRenderer.send('orbit-context', path),
  // Wallpaper mode can't receive mouse input, so main forwards the global
  // cursor: a position (or null when it isn't over the desktop) and clicks.
  onDesktopPointer: (fn) => ipcRenderer.on('desktop-pointer', (_e, p) => fn(p)),
  onDesktopClick: (fn) => ipcRenderer.on('desktop-click', (_e, p) => fn(p)),

  getLyrics: () => ipcRenderer.invoke('get-lyrics'),
  onLyrics: (fn) => ipcRenderer.on('lyrics', (_e, l) => fn(l)),

  // True while this window's monitor is fully covered by another window, so
  // the renderer can stop drawing frames nobody can see.
  onCovered: (fn) => ipcRenderer.on('covered', (_e, v) => fn(v)),

  setInteractive: (on) => ipcRenderer.send('interactive', on),
  reportSource: (src) => ipcRenderer.send('source', src),
  hide: () => ipcRenderer.send('hide'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  // Only the first-run guide uses this; it shares this bridge rather than
  // carrying a second preload for one call.
  closeWelcome: () => ipcRenderer.send('welcome-close'),
});
