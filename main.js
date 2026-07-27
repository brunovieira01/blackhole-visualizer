// ---------------------------------------------------------------------------
//  Black Hole Visualizer — Electron main process.
//
//  Three ways to run it:
//    wallpaper  reparented into Explorer's wallpaper layer — it *is* the
//               desktop background; icons stay on top, clicks pass through
//    overlay    fullscreen click-through layer floating above everything,
//               composited so only the bright parts are visible
//    window     an ordinary resizable window you can drag and orbit
//
//  It lives in the tray. Audio comes from WASAPI loopback, so it hears
//  whatever the speakers are playing without any virtual cable setup.
// ---------------------------------------------------------------------------

'use strict';

const {
  app, BrowserWindow, Tray, Menu, screen, session, desktopCapturer,
  ipcMain, nativeImage, globalShortcut, shell, dialog,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const wallpaper = require('./native/wallpaper');

// GPU-friendly defaults for something that runs all day in the background.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.disableDomainBlockingFor3DAPIs?.();

const MODES = ['wallpaper', 'overlay', 'window'];
const THEMES = {
  gargantua: 'Gargantua',
  cygnus: 'Cygnus X-1',
  nova: 'Nova',
  emerald: 'Emerald',
  ember: 'Ember',
  monochrome: 'Monochrome',
};

const DEFAULTS = {
  mode: 'wallpaper',
  theme: 'gargantua',
  quality: 'auto',
  reactivity: 1.0,
  bloom: 0.75,
  grain: 0.012,
  autoOrbit: 0.02,
  ring: true,
  wave: true,
  allMonitors: false,
  idleThrottle: true,
  launchAtLogin: false,
};

// --demo-audio: ignore capture and drive the visuals from a synthetic beat.
// Handy for testing, and for anyone whose machine has no loopback at all.
let forceDemo = false;

let config = { ...DEFAULTS };
let configPath;
let win = null;
let tray = null;
let currentMode = 'window';
let attachedToDesktop = false;
let audioSource = 'starting…';
let quitting = false;
let shotPath = null;

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------
function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    // Strip a UTF-8 BOM — PowerShell's Out-File writes one and JSON.parse
    // rejects it, which would silently throw the user's settings away.
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
    Object.assign(config, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[config] ignoring unreadable config:', err.message);
  }
  if (!MODES.includes(config.mode)) config.mode = DEFAULTS.mode;
  if (!THEMES[config.theme]) config.theme = DEFAULTS.theme;
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
}

function setConfig(patch, { recreate = false } = {}) {
  Object.assign(config, patch);
  saveConfig();
  if (recreate) createWindow(config.mode);
  else win?.webContents.send('settings', config);
  buildTray();
}

// ---------------------------------------------------------------------------
//  Geometry
// ---------------------------------------------------------------------------
function virtualBoundsDip() {
  const all = screen.getAllDisplays();
  const minX = Math.min(...all.map((d) => d.bounds.x));
  const minY = Math.min(...all.map((d) => d.bounds.y));
  const maxX = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function targetBoundsDip() {
  return config.allMonitors ? virtualBoundsDip() : screen.getPrimaryDisplay().bounds;
}

// The wallpaper host window spans the whole virtual desktop and its client
// origin is the virtual top-left, so our child coordinates are relative to it.
function wallpaperChildRect() {
  const virt = screen.dipToScreenRect(null, virtualBoundsDip());
  const tgt = screen.dipToScreenRect(null, targetBoundsDip());
  return { x: tgt.x - virt.x, y: tgt.y - virt.y, width: tgt.width, height: tgt.height };
}

// ---------------------------------------------------------------------------
//  Window
// ---------------------------------------------------------------------------
function windowOptions(mode) {
  const base = {
    show: false,
    backgroundColor: mode === 'overlay' ? '#00000000' : '#000000',
    icon: iconImage(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  };

  if (mode === 'window') {
    return { ...base, width: 1280, height: 800, minWidth: 480, minHeight: 360, title: 'Black Hole Visualizer' };
  }

  const b = targetBoundsDip();
  const passive = {
    ...base,
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    type: 'toolbar',
  };

  if (mode === 'overlay') {
    return { ...passive, transparent: true, alwaysOnTop: true };
  }
  return passive; // wallpaper
}

function createWindow(mode) {
  if (!MODES.includes(mode)) mode = 'window';

  const old = win;
  attachedToDesktop = false;
  win = new BrowserWindow(windowOptions(mode));
  currentMode = mode;

  if (old && !old.isDestroyed()) {
    try { wallpaper.detach(old); } catch { /* ignore */ }
    old.destroy();
  }

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('closed', () => { win = null; });

  // A frameless passive window should never steal focus or show in Alt+Tab.
  if (mode !== 'window') {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setSkipTaskbar(true);
  }

  win.once('ready-to-show', () => {
    if (mode === 'wallpaper') {
      const res = wallpaper.attach(win, wallpaperChildRect());
      attachedToDesktop = res.ok;
      if (res.ok) {
        applyWallpaperGeometry();
        console.log('[wallpaper] embedded into desktop layer (host 0x' +
          res.host.toString(16) + '), size ' +
          JSON.stringify(win.getContentBounds()));
      } else {
        console.warn('[wallpaper] embedding failed:', res.reason);
        // Graceful fallback: sit at the bottom of the z-order. Not a true
        // wallpaper (it covers desktop icons) but it still looks right.
        win.setAlwaysOnTop(false);
        win.on('focus', () => win.blur());
      }
      win.showInactive();
    } else if (mode === 'overlay') {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
    } else {
      win.show();
    }
    buildTray();
  });

  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, img.toPNG());
          console.log('[shot] wrote ' + shotPath);
        } catch (err) {
          console.error('[shot] failed:', err.message);
        }
        quitting = true;
        app.quit();
      }, 4000);
    });
  }
}

// Windows clamps a new top-level window to the monitor *work area*, so a
// 1440px-tall screen with a 48px taskbar yields a 1392px window. Resizing the
// native handle alone isn't enough — Chromium keeps painting at the size it
// thinks it has, leaving a strip of the old wallpaper showing. Once we're a
// child of WorkerW the clamp no longer applies, so re-apply the full size
// through Electron (which resizes the compositor) and then place the window
// natively at the exact pixel rect.
function applyWallpaperGeometry() {
  const child = wallpaperChildRect();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  win.setBounds({
    x: 0,
    y: 0,
    width: Math.round(child.width / scale),
    height: Math.round(child.height / scale),
  });
  wallpaper.reposition(win, child);
}

// Monitors changed / resolution changed -> resize the passive window.
function refreshGeometry() {
  if (!win || win.isDestroyed() || currentMode === 'window') return;
  if (currentMode === 'wallpaper' && attachedToDesktop) applyWallpaperGeometry();
  else win.setBounds(targetBoundsDip());
}

// ---------------------------------------------------------------------------
//  Icon (regenerate with: node tools/make-icon.js)
// ---------------------------------------------------------------------------
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
const ICON_ICO = path.join(__dirname, 'assets', 'icon.ico');
const iconCache = new Map();

function iconImage(size) {
  if (iconCache.has(size)) return iconCache.get(size);
  let img = nativeImage.createFromPath(ICON_PNG);
  if (!img.isEmpty() && size) img = img.resize({ width: size, height: size, quality: 'best' });
  iconCache.set(size, img);
  return img;
}

// ---------------------------------------------------------------------------
//  Auto-start
//
//  app.setLoginItemSettings() registers process.execPath, which when running
//  unpackaged is electron.exe with no app path — it would launch a blank
//  Electron on boot. A Startup-folder shortcut carries the arguments, so it
//  works the same whether the app is packaged or run from source.
// ---------------------------------------------------------------------------
function startupLinkPath() {
  return path.join(app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'Black Hole Visualizer.lnk');
}

function setAutoStart(enabled) {
  const link = startupLinkPath();
  try {
    if (!enabled) {
      fs.rmSync(link, { force: true });
      return false;
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const ok = shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: path.dirname(app.getAppPath()),
      icon: ICON_ICO,
      iconIndex: 0,
      description: 'Black Hole audio visualizer',
    });
    if (!ok) console.error('[autostart] writeShortcutLink returned false');
    return ok;
  } catch (err) {
    console.error('[autostart] failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Tray
// ---------------------------------------------------------------------------
function radio(list, current, onPick) {
  return list.map(([value, label]) => ({
    label,
    type: 'radio',
    checked: current === value,
    click: () => onPick(value),
  }));
}

function buildTray() {
  if (!tray) {
    tray = new Tray(iconImage(20));
    tray.setToolTip('Black Hole Visualizer');
    tray.on('double-click', () => {
      if (currentMode === 'window') win?.show();
      else setConfig({ mode: 'window' }, { recreate: true });
    });
  }

  const modeNote = currentMode === 'wallpaper' && !attachedToDesktop
    ? 'Desktop  (fallback — not embedded)'
    : 'Desktop wallpaper';

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Black Hole Visualizer`, enabled: false },
    { label: `  audio: ${audioSource}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Display mode',
      submenu: radio([
        ['wallpaper', modeNote],
        ['overlay', 'Overlay  (always on top, click-through)'],
        ['window', 'Window'],
      ], config.mode, (v) => setConfig({ mode: v }, { recreate: true })),
    },
    {
      label: 'Theme',
      submenu: radio(Object.entries(THEMES), config.theme, (v) => setConfig({ theme: v })),
    },
    {
      label: 'Quality',
      submenu: radio([
        ['auto', 'Auto  (targets 60 fps)'],
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ], config.quality, (v) => setConfig({ quality: v })),
    },
    {
      label: 'Reactivity',
      submenu: radio([
        [0.5, 'Subtle'],
        [1.0, 'Normal'],
        [1.6, 'Strong'],
        [2.3, 'Ridiculous'],
      ], config.reactivity, (v) => setConfig({ reactivity: v })),
    },
    { type: 'separator' },
    {
      label: 'Spectrum ring',
      type: 'checkbox',
      checked: config.ring,
      click: (i) => setConfig({ ring: i.checked }),
    },
    {
      label: 'Waveform circle',
      type: 'checkbox',
      checked: config.wave,
      click: (i) => setConfig({ wave: i.checked }),
    },
    {
      label: 'Span all monitors',
      type: 'checkbox',
      checked: config.allMonitors,
      click: (i) => setConfig({ allMonitors: i.checked }, { recreate: currentMode !== 'window' }),
    },
    {
      label: 'Idle down when silent',
      type: 'checkbox',
      checked: config.idleThrottle,
      click: (i) => setConfig({ idleThrottle: i.checked }),
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: config.launchAtLogin,
      click: (i) => setConfig({ launchAtLogin: setAutoStart(i.checked) }),
    },
    { label: 'Restart visualizer', click: () => createWindow(config.mode) },
    { label: 'Open config folder', click: () => shell.showItemInFolder(configPath) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------------------
//  Audio loopback plumbing
// ---------------------------------------------------------------------------
function setupCapture() {
  const s = session.defaultSession;

  // getDisplayMedia() from the renderer lands here. We answer with
  // audio: 'loopback', which is what gives us the WASAPI system mix.
  s.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      console.error('[capture] loopback request failed:', err.message);
      callback({});
    }
  }, { useSystemPicker: false });

  s.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture'].includes(permission));
  });
  s.setPermissionCheckHandler(() => true);
}

// ---------------------------------------------------------------------------
//  IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('get-settings', () => ({ ...config, forceDemo }));
  ipcMain.handle('get-mode', () => currentMode);
  ipcMain.handle('set', (_e, key, value) => {
    if (key in DEFAULTS) setConfig({ [key]: value });
  });
  ipcMain.on('source', (_e, src) => { audioSource = src; buildTray(); });
  ipcMain.on('hide', () => { if (currentMode === 'window') win?.hide(); });
  ipcMain.on('toggle-fullscreen', () => {
    if (currentMode === 'window' && win) win.setFullScreen(!win.isFullScreen());
  });
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (currentMode === 'window') { win?.show(); win?.focus(); }
    else dialog.showMessageBox({
      type: 'info',
      title: 'Black Hole Visualizer',
      message: 'Already running — look for the black hole icon in your system tray.',
    });
  });

  app.whenReady().then(() => {
    loadConfig();

    // CLI overrides: --mode=wallpaper|overlay|window, --shot[=path]
    const argMode = process.argv.find((a) => a.startsWith('--mode='));
    if (argMode) {
      const m = argMode.slice(7);
      if (MODES.includes(m)) config.mode = m;
    }
    forceDemo = process.argv.includes('--demo-audio');

    const argShot = process.argv.find((a) => a === '--shot' || a.startsWith('--shot='));
    if (argShot) {
      shotPath = argShot.includes('=')
        ? argShot.split('=').slice(1).join('=')
        : path.join(app.getPath('desktop'), 'blackhole.png');
      config.mode = 'window';
    }

    setupCapture();
    setupIpc();
    createWindow(config.mode);
    buildTray();

    globalShortcut.register('Control+Alt+B', () => {
      if (!win || win.isDestroyed()) return createWindow(config.mode);
      if (win.isVisible()) win.hide();
      else win.showInactive();
    });

    screen.on('display-metrics-changed', refreshGeometry);
    screen.on('display-added', refreshGeometry);
    screen.on('display-removed', refreshGeometry);
  });

  // The tray keeps the app alive; closing the window shouldn't quit it.
  app.on('window-all-closed', (e) => { if (!quitting) e?.preventDefault?.(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (win && !win.isDestroyed() && attachedToDesktop) wallpaper.detach(win);
  });
}
