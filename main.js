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
const { spawn } = require('node:child_process');

const wallpaper = require('./native/wallpaper');
const desktop = require('./native/desktop');
const desktopItems = require('./lib/desktop-items');
const { fetchLyrics } = require('./lib/lyrics');

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

// Bump when a *default* changes in a way existing users should pick up, and
// add a migration below. Without this, the first tray interaction freezes
// every current value to disk and later default changes never reach anyone.
const CONFIG_VERSION = 2;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  mode: 'wallpaper',
  theme: 'gargantua',
  quality: 'auto',
  reactivity: 1.0,
  warp: 1.0,
  rings: 1.0,
  ringStyle: 1,          // 1 contour, 2 ribbon, 3 comb, 4 halo
  bloom: 0.75,
  grain: 0.012,
  // Slow ambient drift: camera orbit, a gentle tilt breath, and the starfield
  // creeping. Never synced to audio, so it doesn't cause the lurching that
  // beat-driven camera motion did. ~6 minutes for a full revolution.
  autoOrbit: 0.018,
  showNowPlaying: true,
  // Off by default, and it should stay that way: WASAPI loopback already hears
  // everything the speakers play without touching an input device. Turning this
  // on lets the visualiser fall back to Stereo Mix or the microphone, which
  // Windows counts as microphone use and which meeting apps compete for.
  allowMicInput: false,
  allMonitors: false,
  idleThrottle: true,
  launchAtLogin: false,

  // Desktop shortcuts drawn as bodies orbiting the hole. Off by default
  // because turning it on hides the real desktop icons, and a fresh clone
  // should never do that to someone unannounced.
  orbitLauncher: false,
  orbitHideIcons: true,
  orbitSpeed: 1.0,
  orbitScale: 1.0,

  showLyrics: true,
};

// --demo-audio: ignore capture and drive the visuals from a synthetic beat.
// Handy for testing, and for anyone whose machine has no loopback at all.
let forceDemo = false;

let config = { ...DEFAULTS };
let configPath;
let win = null;           // primary display's window — owns the tray, hotkeys, HUD
let winDisplay = null;    // the display `win` covers, needed to map screen->window
let wins = [];            // { win, display } for every other monitor when spanning
let tray = null;
let currentMode = 'window';
let attachedToDesktop = false;
let audioSource = 'starting…';
let quitting = false;
let shotPath = null;

function allWindows() {
  return [win, ...wins.map((e) => e.win)].filter((w) => w && !w.isDestroyed());
}

// One GPU process backs every window, so a crash reports once per window.
// Coalesce them into a single rebuild, on a short delay so a window that
// dies again immediately can't spin into a rebuild loop.
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (!quitting) createWindow(currentMode);
  }, 1200);
}

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
  migrateConfig();
}

function migrateConfig() {
  const from = config.configVersion || 1;
  if (from >= CONFIG_VERSION) return;

  // v1 shipped with the camera completely locked while the audio-driven
  // motion was being torn out. Ambient drift is a separate, slow thing and is
  // on by default now, so adopt it for anyone still pinned at 0.
  if (from < 2 && config.autoOrbit === 0) config.autoOrbit = DEFAULTS.autoOrbit;

  config.configVersion = CONFIG_VERSION;
  saveConfig();
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
  else for (const w of allWindows()) w.webContents.send('settings', config);
  if ('orbitLauncher' in patch || 'orbitHideIcons' in patch) applyOrbitConfig();
  if ('showLyrics' in patch) refreshLyrics();
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

// One window per monitor, each sized to just that monitor — spanning a
// single combined canvas across displays of different size/position (the
// old approach) crops, stretches and rescales the scene at the seam, since
// the shader's composition assumes a single screen's aspect ratio.
function displaysForMode() {
  return config.allMonitors ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
}

// The wallpaper host window spans the whole virtual desktop and its client
// origin is the virtual top-left, so our child coordinates are relative to it.
function wallpaperChildRectForDisplay(display) {
  const virt = screen.dipToScreenRect(null, virtualBoundsDip());
  const tgt = screen.dipToScreenRect(null, display.bounds);
  return { x: tgt.x - virt.x, y: tgt.y - virt.y, width: tgt.width, height: tgt.height };
}

// ---------------------------------------------------------------------------
//  Window
// ---------------------------------------------------------------------------
function windowOptions(mode, display) {
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
    // Positioned on the right monitor from the start (offset so several
    // windows don't stack exactly on top of each other) — setupWindowInstance
    // maximizes it there when spanning more than one display.
    return {
      ...base,
      x: display.bounds.x + 60, y: display.bounds.y + 60,
      width: 1280, height: 800, minWidth: 480, minHeight: 360,
      title: 'Black Hole Visualizer',
    };
  }

  const b = display.bounds;
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

// Sets up show/attach behaviour for one already-constructed window. `isPrimary`
// gates the bits that must only happen once: owning `win`, the tray, and the
// --shot capture. Secondary monitors get a fully independent instance of the
// same scene, kept in sync via the settings/nowplaying broadcasts below.
function setupWindowInstance(w, mode, display, isPrimary) {
  w.removeMenu();
  w.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (isPrimary) w.on('closed', () => { win = null; });
  else w.on('closed', () => { wins = wins.filter((e) => e.win !== w); });

  // A GPU process crash takes the renderer down with it and leaves an empty
  // window behind — the app looks dead while its process (and single-instance
  // lock) is still very much alive. `reason` is 'crashed'/'abnormal-exit' for
  // real failures; a clean shutdown reports 'clean-exit' and needs no rescue.
  w.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    console.error('[renderer] process gone (' + details.reason + '), rebuilding');
    scheduleRebuild();
  });

  // A frameless passive window should never steal focus or show in Alt+Tab.
  if (mode !== 'window') {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setSkipTaskbar(true);
  }

  w.once('ready-to-show', () => {
    if (mode === 'wallpaper') {
      const res = wallpaper.attach(w, wallpaperChildRectForDisplay(display));
      if (isPrimary) attachedToDesktop = res.ok;
      if (res.ok) {
        applyWallpaperGeometryFor(w, display);
        console.log('[wallpaper] embedded into desktop layer (host 0x' +
          res.host.toString(16) + '), size ' + JSON.stringify(w.getContentBounds()) +
          (isPrimary ? '' : ' [secondary monitor]'));
      } else {
        console.warn('[wallpaper] embedding failed:', res.reason, isPrimary ? '' : '[secondary monitor]');
        // Graceful fallback: sit at the bottom of the z-order. Not a true
        // wallpaper (it covers desktop icons) but it still looks right.
        w.setAlwaysOnTop(false);
        w.on('focus', () => w.blur());
      }
      w.showInactive();
    } else if (mode === 'overlay') {
      w.setAlwaysOnTop(true, 'screen-saver');
      w.showInactive();
    } else {
      w.show();
      // Filling every screen only makes sense once there's more than one
      // window to fill them with — a single window mode instance keeps its
      // normal floating size. Maximizing (rather than computing bounds
      // ourselves) hands sizing to Windows' own per-window logic, which
      // handles the taskbar/work-area and any DPI quirks far more reliably
      // than the manual math the wallpaper path needed.
      if (wins.length > 0) w.maximize();
    }
    if (isPrimary) buildTray();
  });

  if (isPrimary && shotPath) {
    w.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await w.webContents.capturePage();
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

function createWindow(mode) {
  if (!MODES.includes(mode)) mode = 'window';

  const oldWin = win;
  const oldWins = wins;
  attachedToDesktop = false;
  currentMode = mode;

  const displays = displaysForMode();
  win = new BrowserWindow(windowOptions(mode, displays[0]));
  winDisplay = displays[0];
  setupWindowInstance(win, mode, displays[0], true);

  wins = displays.slice(1).map((display) => {
    const w = new BrowserWindow(windowOptions(mode, display));
    setupWindowInstance(w, mode, display, false);
    return { win: w, display };
  });

  if (oldWin && !oldWin.isDestroyed()) {
    try { wallpaper.detach(oldWin); } catch { /* ignore */ }
    oldWin.destroy();
  }
  for (const { win: ow } of oldWins) {
    if (!ow.isDestroyed()) {
      try { wallpaper.detach(ow); } catch { /* ignore */ }
      ow.destroy();
    }
  }

  desktop.invalidate();     // WorkerW set changes when we re-attach
  applyDesktopIcons();
  startPointerForwarding();
}

// ---------------------------------------------------------------------------
//  Orbit launcher
//
//  Bodies are DOM in the renderer; everything that needs the OS lives here:
//  reading the Desktop, hiding the real icons, and — because a window in the
//  wallpaper layer can never receive mouse input — forwarding the global
//  cursor so the bodies can be hovered and clicked.
// ---------------------------------------------------------------------------
let orbitItems = [];
let orbitLoading = null;    // in-flight loadOrbitItems(), so IPC can wait on it
let unwatchDesktop = null;
let iconsHiddenByUs = false;

function orbitActive() {
  return config.orbitLauncher && currentMode !== 'window';
}

function loadOrbitItems() {
  orbitLoading = (async () => {
    if (!config.orbitLauncher) { orbitItems = []; }
    else {
      try {
        orbitItems = await desktopItems.list({ max: 28 });
      } catch (err) {
        console.error('[orbit] could not read the desktop:', err.message);
        orbitItems = [];
      }
    }
    broadcast('orbit-items', orbitItems);
  })();
  return orbitLoading;
}

function watchDesktopFolder() {
  unwatchDesktop?.();
  unwatchDesktop = config.orbitLauncher ? desktopItems.watch(loadOrbitItems) : null;
}

// Everything that has to change when the launcher is turned on or off.
function applyOrbitConfig() {
  applyDesktopIcons();
  startPointerForwarding();
  watchDesktopFolder();
  loadOrbitItems();
}

// Only ever opens something that is actually sitting on the desktop — the
// renderer sends back a path, and an untrusted one would otherwise be a way to
// launch anything at all.
function orbitPathAllowed(p) {
  return typeof p === 'string' && orbitItems.some((it) => it.path === p);
}

function launchOrbitItem(p) {
  if (!orbitPathAllowed(p)) return;
  shell.openPath(p).then((err) => {
    if (err) console.error('[orbit] could not open', p, '-', err);
  });
}

// Right-click on a body. A full shell context menu would need IContextMenu;
// the two things actually wanted here are opening the containing folder and
// getting the real icons back.
function orbitContextMenu(p, owner) {
  if (!orbitPathAllowed(p)) return;
  const item = orbitItems.find((it) => it.path === p);
  Menu.buildFromTemplate([
    { label: item.name, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => launchOrbitItem(p) },
    { label: 'Show in folder', click: () => shell.showItemInFolder(p) },
    { type: 'separator' },
    {
      label: 'Turn off orbit launcher',
      click: () => setConfig({ orbitLauncher: false }),
    },
  ]).popup(owner && !owner.isDestroyed() ? { window: owner } : {});
}

// The real icons are hidden only while the launcher is actually on screen.
// Anything that can end the process restores them (see restoreDesktopIcons).
function applyDesktopIcons() {
  if (!desktop.available()) return;
  const shouldHide = orbitActive() && config.orbitHideIcons && currentMode === 'wallpaper';
  if (shouldHide && !iconsHiddenByUs) {
    if (desktop.iconsVisible() === true && desktop.setIconsVisible(false)) {
      markIconsHidden(true);
    }
  } else if (!shouldHide && iconsHiddenByUs) {
    desktop.setIconsVisible(true);
    markIconsHidden(false);
  }
}

// Persisted, because the state lives in Explorer and outlives us: if this
// process is killed while the icons are hidden, nothing in the running system
// remembers that we were the ones who hid them.
function markIconsHidden(hidden) {
  iconsHiddenByUs = hidden;
  if (config.orbitIconsHidden !== hidden) {
    config.orbitIconsHidden = hidden;
    saveConfig();
  }
}

// Adopt a hidden state left behind by a previous run so the normal path can
// put the icons back. (If they should stay hidden, applyDesktopIcons leaves
// them alone.) Worst case the user can always restore them by hand:
// right-click the desktop -> View -> Show desktop icons.
function recoverDesktopIcons() {
  if (config.orbitIconsHidden) iconsHiddenByUs = true;
}

function restoreDesktopIcons() {
  if (!iconsHiddenByUs) return;
  try { desktop.setIconsVisible(true); } catch { /* best effort */ }
  markIconsHidden(false);
}

// --- pointer forwarding ----------------------------------------------------
let pointerTimer = null;
let prevLeft = false;
let prevRight = false;
let pressOrigin = null;

function stopPointerForwarding() {
  clearInterval(pointerTimer);
  pointerTimer = null;
  prevLeft = prevRight = false;
  pressOrigin = null;
}

function startPointerForwarding() {
  stopPointerForwarding();
  if (currentMode !== 'wallpaper' || !config.orbitLauncher || !desktop.available()) return;
  // Read-only sampling: GetCursorPos / GetAsyncKeyState / WindowFromPoint.
  // Nothing is hooked and nothing is injected, so no other app is affected.
  pointerTimer = setInterval(pollPointer, 16);
}

// Screen pixels -> { window, x, y } in that window's CSS pixels.
function windowPointFor(screenPt) {
  const dip = screen.screenToDipPoint(screenPt);
  const all = [{ win, display: winDisplay }, ...wins];
  for (const { win: w, display } of all) {
    if (!w || w.isDestroyed() || !display) continue;
    const b = display.bounds;
    if (dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height) {
      return { win: w, x: dip.x - b.x, y: dip.y - b.y };
    }
  }
  return null;
}

function pollPointer() {
  const p = desktop.pointerState();
  if (!p) return;

  const hit = p.onDesktop ? windowPointFor({ x: p.x, y: p.y }) : null;

  for (const w of allWindows()) {
    w.webContents.send('desktop-pointer',
      hit && hit.win === w ? { x: hit.x, y: hit.y } : null);
  }

  const edge = (down, prev, button) => {
    if (down && !prev) {
      pressOrigin = { x: p.x, y: p.y, at: Date.now(), onDesktop: p.onDesktop, button };
    } else if (!down && prev && pressOrigin && pressOrigin.button === button) {
      const o = pressOrigin;
      pressOrigin = null;
      // A click, not a drag or a long press: both ends on the desktop, close
      // together in space and time.
      const moved = Math.hypot(p.x - o.x, p.y - o.y);
      if (o.onDesktop && p.onDesktop && moved < 8 && Date.now() - o.at < 800 && hit) {
        hit.win.webContents.send('desktop-click', { x: hit.x, y: hit.y, button });
      }
    }
  };

  edge(p.left, prevLeft, 'left');
  edge(p.right, prevRight, 'right');
  prevLeft = p.left;
  prevRight = p.right;
}

function broadcast(channel, payload) {
  for (const w of allWindows()) w.webContents.send(channel, payload);
}

// Windows clamps a new top-level window to the monitor *work area*, so a
// 1440px-tall screen with a 48px taskbar yields a 1392px window. Resizing the
// native handle alone isn't enough — Chromium keeps painting at the size it
// thinks it has, leaving a strip of the old wallpaper showing. Once we're a
// child of WorkerW the clamp no longer applies, so re-apply the full size
// through Electron (which resizes the compositor) and then place the window
// natively at the exact pixel rect.
function applyWallpaperGeometryFor(w, display) {
  const child = wallpaperChildRectForDisplay(display);
  const scale = display.scaleFactor || 1;
  w.setBounds({
    x: 0,
    y: 0,
    width: Math.round(child.width / scale),
    height: Math.round(child.height / scale),
  });
  wallpaper.reposition(w, child);
}

// Monitors changed / resolution changed -> rebuild the window set to match
// the new topology (adding/removing/moving displays is rare enough that a
// full recreate is simpler and safer than patching per-window bounds).
//
// Debounced: some external/wireless displays fire several metrics-changed
// events in quick succession while renegotiating resolution/DPI, each with
// a different (sometimes transient/wrong) geometry. Recreating on every one
// of those can leave a window sized to an intermediate reading. Waiting for
// the event stream to go quiet for a moment means we build against whatever
// the display settles on, not whatever it happened to report mid-handshake.
let refreshGeometryTimer = null;
function refreshGeometry() {
  if (!win || win.isDestroyed() || currentMode === 'window') return;
  clearTimeout(refreshGeometryTimer);
  refreshGeometryTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || currentMode === 'window') return;
    createWindow(currentMode);
  }, 800);
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

// The shortcut on disk is the source of truth - a user can delete it from the
// Startup folder or via Task Manager without us knowing. Reconcile at boot so
// the tray checkbox never lies, and re-point a stale shortcut at the current
// executable (Electron's path changes when the app is moved or upgraded).
function syncAutoStart() {
  const link = startupLinkPath();
  const present = fs.existsSync(link);

  if (config.launchAtLogin && !present) {
    config.launchAtLogin = setAutoStart(true);
    saveConfig();
  } else if (!config.launchAtLogin && present) {
    config.launchAtLogin = true;      // adopt it rather than silently removing
    saveConfig();
  } else if (config.launchAtLogin && present) {
    try {
      const cur = shell.readShortcutLink(link);
      if (cur.target !== process.execPath) setAutoStart(true);
    } catch {
      setAutoStart(true);             // unreadable / corrupt - rewrite it
    }
  }
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

  tray.setToolTip('Black Hole Visualizer\n' + nowPlayingLabel());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Black Hole Visualizer`, enabled: false },
    { label: `  ${nowPlayingLabel()}`, enabled: false },
    { label: `  audio: ${audioSource}`, enabled: false },
    { type: 'separator' },
    // Transport lives here because in wallpaper mode the visualiser is behind
    // the desktop icon layer and can never receive a click.
    {
      label: 'Previous track',
      accelerator: 'Ctrl+Alt+Left',
      enabled: !!nowPlaying.canPrev,
      click: () => mediaCommand('prev'),
    },
    {
      label: nowPlaying.status === 'Playing' ? 'Pause' : 'Play',
      accelerator: 'Ctrl+Alt+Space',
      enabled: !!(nowPlaying.canPlay || nowPlaying.canPause),
      click: () => mediaCommand('playpause'),
    },
    {
      label: 'Next track',
      accelerator: 'Ctrl+Alt+Right',
      enabled: !!nowPlaying.canNext,
      click: () => mediaCommand('next'),
    },
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
    {
      label: 'Audio ring',
      submenu: [
        ...radio([
          [1, 'Contour  (single line)'],
          [2, 'Ribbon  (filled)'],
          [3, 'Comb  (bars, capped)'],
          [4, 'Halo  (soft glow)'],
        ], config.ringStyle, (v) => setConfig({ ringStyle: v })),
        { type: 'separator' },
        ...radio([
          [0, 'Off'],
          [0.55, 'Subtle'],
          [1.0, 'Normal'],
          [1.7, 'Bold'],
        ], config.rings, (v) => setConfig({ rings: v })),
      ],
    },
    {
      label: 'Wave depth',
      submenu: radio([
        [0.0, 'Off  (flat disk)'],
        [0.55, 'Subtle'],
        [1.0, 'Normal'],
        [1.7, 'Strong'],
        [2.6, 'Turbulent'],
      ], config.warp, (v) => setConfig({ warp: v })),
    },
    {
      label: 'Ambient drift',
      submenu: radio([
        [0, 'Off  (locked camera)'],
        [0.010, 'Barely there'],
        [0.018, 'Slow'],
        [0.034, 'Wandering'],
      ], config.autoOrbit, (v) => setConfig({ autoOrbit: v })),
    },
    { type: 'separator' },
    {
      label: 'Show now playing',
      type: 'checkbox',
      checked: config.showNowPlaying,
      click: (i) => setConfig({ showNowPlaying: i.checked }),
    },
    {
      label: 'Show lyrics',
      type: 'checkbox',
      checked: config.showLyrics,
      click: (i) => setConfig({ showLyrics: i.checked }),
    },
    {
      label: 'Orbit launcher',
      submenu: [
        {
          label: 'Put desktop shortcuts in orbit',
          type: 'checkbox',
          checked: config.orbitLauncher,
          click: (i) => setConfig({ orbitLauncher: i.checked }),
        },
        {
          label: 'Hide the real desktop icons',
          type: 'checkbox',
          checked: config.orbitHideIcons,
          enabled: config.orbitLauncher,
          click: (i) => setConfig({ orbitHideIcons: i.checked }),
        },
        { type: 'separator' },
        {
          label: 'Orbit size',
          submenu: radio([
            [0.75, 'Tight'],
            [1.0, 'Normal'],
            [1.25, 'Wide'],
          ], config.orbitScale, (v) => setConfig({ orbitScale: v })),
        },
        {
          label: 'Orbit speed',
          submenu: radio([
            [0, 'Still'],
            [0.5, 'Slow'],
            [1.0, 'Normal'],
            [1.8, 'Brisk'],
          ], config.orbitSpeed, (v) => setConfig({ orbitSpeed: v })),
        },
      ],
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
    {
      // Only worth enabling if loopback genuinely doesn't work on this machine.
      label: 'Allow microphone input (off by default)',
      type: 'checkbox',
      checked: config.allowMicInput,
      click: (i) => setConfig({ allowMicInput: i.checked }, { recreate: true }),
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

  // Loopback arrives via display-capture, never via the microphone permission.
  // Blanket-granting 'media' meant any stray getUserMedia opened the mic
  // without a trace, so each class is decided on its own merits here.
  const allow = (permission, mediaTypes = []) => {
    if (permission === 'display-capture') return true;
    if (permission === 'media') {
      if (mediaTypes.includes('video')) return false;      // never the camera
      if (mediaTypes.includes('audio')) return config.allowMicInput === true;
      return true;                                          // loopback's own request
    }
    return false;
  };

  s.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok = allow(permission, details?.mediaTypes || []);
    if (!ok) console.warn('[capture] denied permission:', permission, details?.mediaTypes || '');
    cb(ok);
  });

  s.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const types = details?.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [];
    return allow(permission, types);
  });
}

// ---------------------------------------------------------------------------
//  Now playing
//
//  A long-lived Windows PowerShell child polls the media session (SMTC) and
//  the WASAPI render sessions, printing one JSON line whenever what's playing
//  changes. PowerShell 5.1 specifically: it's the shell that can project the
//  WinRT Windows.Media.Control types without extra tooling.
// ---------------------------------------------------------------------------
let npProc = null;
let npRestartTimer = null;
let nowPlaying = { kind: 'none' };

function startNowPlaying() {
  const script = path.join(__dirname, 'tools', 'nowplaying.ps1');
  if (!fs.existsSync(script)) return;

  try {
    npProc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-ExcludePid', String(process.pid),
      '-ParentPid', String(process.pid),
      '-IntervalMs', '1000',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[nowplaying] spawn failed:', err.message);
    return;
  }

  let buf = '';
  npProc.stdout.setEncoding('utf8');
  npProc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const next = JSON.parse(line);
        // The position field changes every second; only rebuild the tray when
        // the *identity* of what's playing changes, or we'd churn the menu.
        const key = (o) => `${o.kind}|${o.title}|${o.artist}|${o.app}|${o.status}` +
          `|${o.canNext}|${o.canPrev}|${o.canPlay}|${o.canPause}`;
        const changed = key(next) !== key(nowPlaying);
        nowPlaying = next;
        for (const w of allWindows()) w.webContents.send('nowplaying', nowPlaying);
        if (changed) buildTray();
        // Keyed on the track's identity, not on `changed` — pausing must not
        // throw the lyrics away and re-fetch them on resume.
        refreshLyrics();
      } catch {
        console.error('[nowplaying] unparseable line:', line.slice(0, 200));
      }
    }
  });

  npProc.stderr.setEncoding('utf8');
  npProc.stderr.on('data', (d) => console.error('[nowplaying]', d.trim().slice(0, 400)));

  npProc.on('exit', (code) => {
    npProc = null;
    if (quitting) return;
    console.error('[nowplaying] watcher exited (code ' + code + '), retrying in 10s');
    clearTimeout(npRestartTimer);
    npRestartTimer = setTimeout(startNowPlaying, 10000);
  });
}

function stopNowPlaying() {
  clearTimeout(npRestartTimer);
  if (npProc) {
    npProc.removeAllListeners('exit');
    npProc.kill();
    npProc = null;
  }
}

// Send a transport command to the watcher: play | pause | playpause | next |
// prev | seek <seconds>. Silently ignored if the watcher isn't up.
function mediaCommand(cmd) {
  if (!npProc || !npProc.stdin.writable) return false;
  try {
    npProc.stdin.write(cmd + '\n');
    return true;
  } catch (err) {
    console.error('[nowplaying] command failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Lyrics
//
//  Looked up once per track and pushed to the renderer whole; the renderer
//  owns the timing, since it already advances the playback clock locally
//  between the watcher's once-a-second updates.
// ---------------------------------------------------------------------------
let lyrics = null;        // { lines, plain, source, track } or null
let lyricsTrack = '';     // identity of whatever `lyrics` describes
let lyricsAbort = null;
let lyricsRetry = null;

function trackIdentity(np) {
  if (!np || np.kind !== 'media' || !np.title) return '';
  return `${np.artist || ''}|${np.title}|${np.album || ''}|${Math.round(np.duration || 0)}`;
}

// Called on every track change, and again when the lyrics toggle flips.
function refreshLyrics() {
  const id = config.showLyrics ? trackIdentity(nowPlaying) : '';

  if (id === lyricsTrack) return;
  lyricsTrack = id;

  lyricsAbort?.abort();
  lyricsAbort = null;
  clearTimeout(lyricsRetry);
  lyrics = null;
  broadcast('lyrics', null);
  if (id) lookupLyrics(id, {
    artist: nowPlaying.artist,
    title: nowPlaying.title,
    album: nowPlaying.album,
    duration: nowPlaying.duration,
  }, true);
}

function lookupLyrics(id, track, mayRetry) {
  const ctrl = new AbortController();
  lyricsAbort = ctrl;

  fetchLyrics(track, { signal: ctrl.signal }).then((res) => {
    // The song can change while the request is in flight.
    if (ctrl !== lyricsAbort) return;
    lyricsAbort = null;
    lyrics = res && (res.synced?.length || res.plain)
      ? { lines: res.synced, plain: res.plain, source: res.source, track: id }
      : null;

    // LRCLIB intermittently answers a perfectly good query with nothing at
    // all under repeated requests. One retry turns that from "this song has
    // no lyrics for the next four minutes" into a barely noticeable delay.
    if (!lyrics && mayRetry) {
      lyricsRetry = setTimeout(() => {
        if (lyricsTrack === id) lookupLyrics(id, track, false);
      }, 4000);
      return;
    }

    console.log('[lyrics]', track.title, '-',
      lyrics ? `${lyrics.lines ? lyrics.lines.length + ' synced lines' : 'unsynced'} from ${lyrics.source}`
        : 'no match');
    broadcast('lyrics', lyrics);
  }).catch((err) => {
    if (err.name !== 'AbortError') console.warn('[lyrics]', err.message);
  });
}

// One-line summary for the tray tooltip / menu header.
function nowPlayingLabel() {
  const np = nowPlaying;
  if (!np || np.kind === 'none') return 'nothing playing';
  if (np.kind === 'app') return np.app;
  const who = np.artist ? `${np.title} - ${np.artist}` : np.title;
  return np.status === 'Playing' ? who : `${who} (paused)`;
}

// ---------------------------------------------------------------------------
//  IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('get-settings', () => ({
    ...config,
    forceDemo,
    shotMode: !!shotPath,
    // Whether the renderer can expect forwarded pointer events. Without
    // koffi there is no cursor sampling, so the on-screen transport would be
    // shown dead in wallpaper mode rather than merely unclickable.
    pointerForwarding: currentMode === 'wallpaper' && desktop.available(),
  }));
  ipcMain.handle('get-mode', () => currentMode);
  ipcMain.handle('get-nowplaying', () => nowPlaying);
  // Pulled rather than only pushed: a mode change builds brand new windows,
  // which would otherwise have missed the broadcasts that came before them.
  // Awaits any load still running — the shell icon lookups take long enough
  // that a renderer starting up will otherwise reliably beat them and show an
  // empty orbit until the desktop next changes.
  ipcMain.handle('get-orbit-items', async () => {
    try { await orbitLoading; } catch { /* the load logs its own failures */ }
    return orbitItems;
  });
  ipcMain.handle('get-lyrics', () => lyrics);
  ipcMain.on('orbit-launch', (_e, p) => launchOrbitItem(p));
  ipcMain.on('orbit-context', (e, p) =>
    orbitContextMenu(p, BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('set', (_e, key, value) => {
    if (key in DEFAULTS) setConfig({ [key]: value });
  });
  ipcMain.on('media', (_e, cmd) => {
    if (/^(play|pause|playpause|next|prev|seek(\s+\d+(\.\d+)?)?)$/.test(String(cmd))) {
      mediaCommand(String(cmd));
    }
  });
  // Overlay mode is click-through; the renderer asks for clicks back while the
  // pointer is over the transport controls. Each monitor's window is its own
  // independent instance, so this must target whichever one sent the event.
  ipcMain.on('interactive', (_e, on) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (currentMode === 'overlay' && w && !w.isDestroyed()) {
      w.setIgnoreMouseEvents(!on, { forward: true });
    }
  });
  ipcMain.on('source', (_e, src) => { audioSource = src; buildTray(); });
  ipcMain.on('hide', (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (currentMode === 'window' && w && !w.isDestroyed()) w.hide();
  });
  ipcMain.on('toggle-fullscreen', (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (currentMode === 'window' && w && !w.isDestroyed()) w.setFullScreen(!w.isFullScreen());
  });
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Launching again with no live window means the window died but the
    // process (and its single-instance lock) outlived it — a GPU process
    // crash does exactly this. Without rebuilding here, every further
    // launch is swallowed by the lock and the app looks like it simply
    // won't start, with only a tray icon to show for it.
    if (!win || win.isDestroyed()) {
      createWindow(config.mode);
      return;
    }
    if (currentMode === 'window') { win.show(); win.focus(); }
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
    syncAutoStart();

    // Registered before the first createWindow() call, not after: a monitor
    // that's still settling (renegotiating resolution/DPI) right at launch
    // needs its eventual display-added/metrics-changed event to reach a
    // listener that already exists, or that event is the only chance to
    // self-correct and it's missed for the rest of the session.
    screen.on('display-metrics-changed', refreshGeometry);
    screen.on('display-added', refreshGeometry);
    screen.on('display-removed', refreshGeometry);

    recoverDesktopIcons();
    createWindow(config.mode);
    buildTray();
    startNowPlaying();
    watchDesktopFolder();
    loadOrbitItems();

    // Belt and braces: the listeners above only fire on a *change*. If a
    // monitor was already mid-renegotiation when getAllDisplays() was first
    // read, the window set can end up built for the wrong display count with
    // no further event ever arriving to say so (nothing changes again from
    // the OS's point of view). Compare what we built against what's actually
    // connected a couple of seconds in, once things have had time to settle.
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const expected = displaysForMode().length;
      const actual = 1 + wins.length;
      if (expected !== actual) createWindow(currentMode);
    }, 3000);

    globalShortcut.register('Control+Alt+B', () => {
      if (!win || win.isDestroyed()) return createWindow(config.mode);
      const show = !win.isVisible();
      for (const w of allWindows()) { if (show) w.showInactive(); else w.hide(); }
    });

    // Transport hotkeys — the only way to drive playback while the visualiser
    // is the wallpaper, since it sits below the desktop icon layer.
    for (const [accel, cmd] of [
      ['Control+Alt+Right', 'next'],
      ['Control+Alt+Left', 'prev'],
      ['Control+Alt+Space', 'playpause'],
    ]) {
      if (!globalShortcut.register(accel, () => mediaCommand(cmd))) {
        console.warn(`[hotkey] ${accel} is already taken by another app`);
      }
    }
  });

  // The tray keeps the app alive; closing the window shouldn't quit it.
  app.on('window-all-closed', (e) => { if (!quitting) e?.preventDefault?.(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopNowPlaying();
    stopPointerForwarding();
    unwatchDesktop?.();
    lyricsAbort?.abort();
    clearTimeout(lyricsRetry);
    clearTimeout(refreshGeometryTimer);
    clearTimeout(rebuildTimer);
    // Leaving someone's desktop icons hidden is the one failure here that
    // outlives the process, so it gets its own attempt before anything else
    // in teardown can throw.
    restoreDesktopIcons();
    if (currentMode === 'wallpaper') {
      for (const w of allWindows()) { try { wallpaper.detach(w); } catch { /* ignore */ } }
    }
  });

  // Same reason: an unhandled throw would otherwise take the process down with
  // the desktop still emptied out.
  process.on('uncaughtException', (err) => {
    console.error('[fatal]', err);
    restoreDesktopIcons();
    process.exit(1);
  });
}
