// ---------------------------------------------------------------------------
//  Desktop icon control + mouse-input forwarding for the wallpaper layer.
//
//  A window living inside Explorer's WorkerW cannot receive mouse input: the
//  desktop's own SHELLDLL_DefView listview sits above it and swallows every
//  click on the desktop. This is not something you can fix with window styles —
//  it's how the shell is layered, and it's why Lively and Wallpaper Engine both
//  *forward* input to their wallpapers rather than letting the window get it.
//
//  So we do the same: poll the global cursor and button state, work out whether
//  the pointer is over the desktop (as opposed to over some app window), and
//  hand that to the renderer as synthetic hover/click events. Nothing is
//  intercepted and nothing is injected, so no other app is affected.
// ---------------------------------------------------------------------------

'use strict';

const WM_COMMAND = 0x0111;
const TOGGLE_DESKTOP_ICONS = 0x7402;  // undocumented DefView command id
const GA_ROOT = 2;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
    const RECT = koffi.struct('RECT', {
      left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
    });

    api = {
      koffi,
      POINT,
      FindWindowW: user32.func('__stdcall', 'FindWindowW', 'uintptr_t', ['str16', 'str16']),
      FindWindowExW: user32.func('__stdcall', 'FindWindowExW', 'uintptr_t',
        ['uintptr_t', 'uintptr_t', 'str16', 'str16']),
      SendMessageW: user32.func('__stdcall', 'SendMessageW', 'intptr_t',
        ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']),
      IsWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'bool', ['uintptr_t']),
      GetCursorPos: user32.func('__stdcall', 'GetCursorPos', 'bool',
        [koffi.out(koffi.pointer(POINT))]),
      WindowFromPoint: user32.func('__stdcall', 'WindowFromPoint', 'uintptr_t', [POINT]),
      GetAncestor: user32.func('__stdcall', 'GetAncestor', 'uintptr_t', ['uintptr_t', 'uint32']),
      GetAsyncKeyState: user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int32']),
      GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []),
      GetWindowRect: user32.func('__stdcall', 'GetWindowRect', 'bool',
        ['uintptr_t', koffi.out(koffi.pointer(RECT))]),
      IsIconic: user32.func('__stdcall', 'IsIconic', 'bool', ['uintptr_t']),
    };
  } catch (err) {
    loadError = err;
    api = null;
  }
  return api;
}

function available() {
  return !!load();
}

// ---------------------------------------------------------------------------
//  Locating the desktop's windows
//
//  Layout, once the wallpaper WorkerW exists:
//    Progman
//      └ (sometimes) SHELLDLL_DefView → SysListView32
//    WorkerW  ← icon host
//      └ SHELLDLL_DefView → SysListView32   (the icons)
//    WorkerW  ← wallpaper host (where our window lives)
// ---------------------------------------------------------------------------
function findDesktop() {
  const a = load();
  if (!a) return null;

  const progman = a.FindWindowW('Progman', null);
  let defView = progman ? a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null) : 0;
  const workers = [];

  let w = 0;
  for (let i = 0; i < 64; i++) {
    w = a.FindWindowExW(0, w, 'WorkerW', null);
    if (!w) break;
    workers.push(w);
    if (!defView) {
      const dv = a.FindWindowExW(w, 0, 'SHELLDLL_DefView', null);
      if (dv) defView = dv;
    }
  }

  const listView = defView ? a.FindWindowExW(defView, 0, 'SysListView32', null) : 0;
  return { progman, defView, listView, workers };
}

/** Are the real desktop icons currently visible? null if it can't be determined. */
function iconsVisible() {
  const a = load();
  const d = findDesktop();
  if (!a || !d) return null;
  const target = d.listView || d.defView;
  if (!target) return null;
  return !!a.IsWindowVisible(target);
}

/**
 * Show or hide the real desktop icons. This is the same toggle as
 * right-click → View → Show desktop icons, so the user can always undo it by
 * hand if we die before restoring.
 * @returns {boolean} whether the desktop is now in the requested state
 */
function setIconsVisible(visible) {
  const a = load();
  const d = findDesktop();
  if (!a || !d || !d.defView) return false;

  const now = iconsVisible();
  if (now === null) return false;
  if (now === visible) return true;

  a.SendMessageW(d.defView, WM_COMMAND, TOGGLE_DESKTOP_ICONS, 0);

  // The shell applies it asynchronously; report what we can see right now and
  // let the caller re-check if it cares.
  return iconsVisible() === visible;
}

// ---------------------------------------------------------------------------
//  Pointer tracking
// ---------------------------------------------------------------------------

// Cached because FindWindowEx on every poll tick is wasteful, and the desktop
// window set only changes when Explorer restarts or a display is added.
let cachedRoots = null;
let cachedAt = 0;

function desktopRoots() {
  const now = Date.now();
  if (cachedRoots && now - cachedAt < 4000) return cachedRoots;
  const d = findDesktop();
  cachedRoots = d ? new Set([d.progman, ...d.workers].filter(Boolean)) : new Set();
  cachedAt = now;
  return cachedRoots;
}

function invalidate() {
  cachedRoots = null;
}

/**
 * One sample of global pointer state.
 * @returns {{x:number,y:number,onDesktop:boolean,left:boolean,right:boolean}|null}
 *          x/y are physical screen pixels.
 */
function pointerState() {
  const a = load();
  if (!a) return null;

  const pt = {};
  if (!a.GetCursorPos(pt)) return null;

  const under = a.WindowFromPoint(pt);
  const root = under ? a.GetAncestor(under, GA_ROOT) : 0;

  return {
    x: pt.x,
    y: pt.y,
    // The desktop layer is Progman plus every WorkerW — which includes the
    // WorkerW our own wallpaper window is parented to.
    onDesktop: !!root && desktopRoots().has(root),
    left: (a.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0,
    right: (a.GetAsyncKeyState(VK_RBUTTON) & 0x8000) !== 0,
  };
}

/**
 * Is the wallpaper on this monitor completely hidden behind a window?
 *
 * Chromium will not tell us: it throttles occluded windows, but a window
 * reparented into WorkerW is never "occluded" as far as the compositor is
 * concerned, so the scene keeps rendering at full rate underneath a maximized
 * browser for hours. This catches the case that actually matters — one window
 * covering the whole screen — rather than trying to solve general occlusion,
 * which would mean walking the whole z-order every tick.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds monitor rect,
 *        in physical pixels
 */
function displayCovered(bounds) {
  const a = load();
  if (!a || !bounds) return false;

  const fg = a.GetForegroundWindow();
  if (!fg || a.IsIconic(fg)) return false;
  // The desktop itself being in front means nothing is covering us.
  const root = a.GetAncestor(fg, GA_ROOT) || fg;
  if (desktopRoots().has(root)) return false;

  const r = {};
  if (!a.GetWindowRect(fg, r)) return false;

  // A pixel of slack each way: maximized windows sit a hair outside the
  // monitor, and a window one pixel short is not meaningfully less covering.
  return r.left <= bounds.x + 1 &&
    r.top <= bounds.y + 1 &&
    r.right >= bounds.x + bounds.width - 1 &&
    r.bottom >= bounds.y + bounds.height - 1;
}

module.exports = {
  available,
  displayCovered,
  findDesktop,
  iconsVisible,
  setIconsVisible,
  pointerState,
  invalidate,
};
