// ---------------------------------------------------------------------------
//  A silent, fully real Windows media session — for testing the now-playing
//  panel, the transport commands and the lyrics without playing anything
//  audible on someone's machine.
//
//    npx electron tools/fake-track.js
//    npx electron tools/fake-track.js --artist="Daft Punk" --title="Instant Crush" \
//        --album="Random Access Memories" --duration=337 --position=30
//
//  Leave it running and start the visualizer in another terminal. Ctrl+C ends
//  the session. Transport commands sent to it are logged to stdout, which is
//  what proves the whole chain rather than just that a call returned.
// ---------------------------------------------------------------------------

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// Chromium suspends media in a fully hidden window, so the window is real but
// tiny and parked out of the way.
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 420, height: 200, title: 'fake track',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    backgroundThrottling: false,
  });
  win.removeMenu();

  const q = new URLSearchParams({
    title: arg('title', 'Instant Crush'),
    artist: arg('artist', 'Daft Punk'),
    album: arg('album', 'Random Access Memories'),
    duration: arg('duration', '337'),
    position: arg('position', '30'),
  });

  win.loadFile(path.join(__dirname, 'fake-track.html'), { search: q.toString() });
  // Electron 36+ passes a single event object; older builds passed
  // (event, level, message). Accept either so this keeps working.
  win.webContents.on('console-message', (e, ...rest) =>
    console.log(e && typeof e.message === 'string' ? e.message : rest[1]));
  win.on('closed', () => app.quit());
});
