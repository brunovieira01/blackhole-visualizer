// ---------------------------------------------------------------------------
//  Windows "live wallpaper" embedding.
//
//  Explorer paints the desktop wallpaper into a window of class WorkerW that
//  sits *behind* the icon layer (SHELLDLL_DefView). Sending the undocumented
//  message 0x052C to Progman makes Explorer spawn that WorkerW; reparenting
//  our window into it means we literally become the wallpaper:
//
//    - desktop icons stay on top and keep working
//    - Win+D / "show desktop" reveals us instead of hiding us
//    - we never appear in Alt+Tab or the taskbar
//    - clicks pass straight through to the desktop
//
//  Everything here is best-effort. If koffi is missing or Explorer is in a
//  shape we don't recognise, we report failure and main.js falls back to a
//  plain always-on-bottom window.
// ---------------------------------------------------------------------------

'use strict';

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TRANSPARENT = 0x00000020;

const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      koffi,
      FindWindowW: user32.func('__stdcall', 'FindWindowW', 'uintptr_t', ['str16', 'str16']),
      FindWindowExW: user32.func('__stdcall', 'FindWindowExW', 'uintptr_t',
        ['uintptr_t', 'uintptr_t', 'str16', 'str16']),
      SendMessageTimeoutW: user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t',
        ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', 'uintptr_t']),
      SetParent: user32.func('__stdcall', 'SetParent', 'uintptr_t', ['uintptr_t', 'uintptr_t']),
      GetWindowLongPtrW: user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t',
        ['uintptr_t', 'int32']),
      SetWindowLongPtrW: user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t',
        ['uintptr_t', 'int32', 'intptr_t']),
      SetWindowPos: user32.func('__stdcall', 'SetWindowPos', 'bool',
        ['uintptr_t', 'uintptr_t', 'int32', 'int32', 'int32', 'int32', 'uint32']),
      ShowWindow: user32.func('__stdcall', 'ShowWindow', 'bool', ['uintptr_t', 'int32']),
    };
  } catch (err) {
    loadError = err;
    api = null;
  }
  return api;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  // 8 bytes on x64, 4 on x86
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

// Ask Explorer to split the desktop into Progman + WorkerW layers, then find
// the WorkerW that sits behind the icon view.
function findWallpaperHost(a) {
  const progman = a.FindWindowW('Progman', null);
  if (!progman) return { host: 0, progman: 0 };

  // 0x052C is undocumented. The (0,0) form works on Win7-10; Win11 22000+
  // wants (0xD, 0x1). Sending both is harmless.
  a.SendMessageTimeoutW(progman, 0x052c, 0, 0, 0x0002 /* SMTO_ABORTIFHUNG */, 1200, 0);
  a.SendMessageTimeoutW(progman, 0x052c, 0x0000000d, 0x00000001, 0x0002, 1200, 0);

  // Walk the top-level WorkerW windows. The one we want is the sibling that
  // comes immediately after the WorkerW hosting SHELLDLL_DefView.
  let w = 0;
  for (let i = 0; i < 64; i++) {
    w = a.FindWindowExW(0, w, 'WorkerW', null);
    if (!w) break;
    const defView = a.FindWindowExW(w, 0, 'SHELLDLL_DefView', null);
    if (defView) {
      const host = a.FindWindowExW(0, w, 'WorkerW', null);
      if (host) return { host, progman };
      // Some setups keep a single WorkerW; drawing into it still works.
      return { host: w, progman };
    }
  }

  // Fallback: on a few configurations SHELLDLL_DefView lives directly under
  // Progman and no WorkerW is created at all. Progman itself will do.
  if (a.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) {
    return { host: progman, progman };
  }
  return { host: 0, progman };
}

/**
 * Reparent an Electron BrowserWindow into the desktop wallpaper layer.
 * @returns {{ok: boolean, reason?: string, host?: number}}
 */
function attach(win, rect) {
  const a = load();
  if (!a) return { ok: false, reason: 'koffi unavailable: ' + (loadError?.message || '?') };

  let found;
  try {
    found = findWallpaperHost(a);
  } catch (err) {
    return { ok: false, reason: 'window lookup failed: ' + err.message };
  }
  if (!found.host) return { ok: false, reason: 'no WorkerW/Progman wallpaper host found' };

  const hwnd = hwndOf(win);
  if (!hwnd) return { ok: false, reason: 'could not resolve our own HWND' };

  try {
    // Invisible to Alt+Tab, never takes focus, clicks fall through.
    const ex = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    const newEx = (ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT) & ~WS_EX_APPWINDOW;
    a.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, newEx);

    if (!a.SetParent(hwnd, found.host)) {
      return { ok: false, reason: 'SetParent rejected (try running without elevation)' };
    }

    a.SetWindowPos(hwnd, 0, rect.x, rect.y, rect.width, rect.height,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    a.ShowWindow(hwnd, 8 /* SW_SHOWNA */);
  } catch (err) {
    return { ok: false, reason: 'win32 call failed: ' + err.message };
  }

  return { ok: true, host: found.host };
}

/** Reposition an already-attached window (monitor layout changed). */
function reposition(win, rect) {
  const a = load();
  if (!a) return false;
  try {
    return !!a.SetWindowPos(hwndOf(win), 0, rect.x, rect.y, rect.width, rect.height,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } catch {
    return false;
  }
}

/** Pop the window back out of the wallpaper layer. */
function detach(win) {
  const a = load();
  if (!a) return false;
  try {
    a.SetParent(hwndOf(win), 0);
    return true;
  } catch {
    return false;
  }
}

function available() {
  return !!load();
}

module.exports = { attach, detach, reposition, available };
