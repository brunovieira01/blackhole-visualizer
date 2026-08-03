// ---------------------------------------------------------------------------
//  Reads the user's Desktop and turns it into the list of bodies to put in
//  orbit. Icons come from Electron's app.getFileIcon(), which asks the shell
//  for the real associated icon — so a .lnk resolves to its target's icon and
//  file types get whatever they're registered with, no Win32 needed.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, shell } = require('electron');

const SKIP = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function desktopDirs() {
  const dirs = [];
  try { dirs.push(app.getPath('desktop')); } catch { /* no desktop path */ }
  // Shortcuts installed "for all users" live here and show on the desktop too.
  const pub = process.env.PUBLIC && path.join(process.env.PUBLIC, 'Desktop');
  if (pub && fs.existsSync(pub)) dirs.push(pub);
  return dirs;
}

function displayName(file) {
  return file.replace(/\.(lnk|url)$/i, '');
}

// getFileIcon() on a .lnk hands back the generic shortcut glyph far more often
// than the target's real icon, which is what makes a desktop full of shortcuts
// look like a wall of blank pages. Resolving the link ourselves and asking for
// the *target's* icon is what actually gets Chrome's chrome and Discord's blob.
function iconSourceFor(p) {
  if (/\.lnk$/i.test(p)) {
    try {
      const link = shell.readShortcutLink(p);
      // An explicit custom icon wins — that's what the shell would show.
      if (link.icon && fs.existsSync(link.icon)) return link.icon;
      if (link.target && fs.existsSync(link.target)) return link.target;
    } catch { /* unreadable or non-filesystem shortcut */ }
  } else if (/\.url$/i.test(p)) {
    // Internet shortcuts are plain INI; the icon is a path in IconFile=.
    try {
      const m = fs.readFileSync(p, 'latin1').match(/^IconFile=(.+)$/mi);
      const icon = m && m[1].trim();
      if (icon && fs.existsSync(icon)) return icon;
    } catch { /* ignore */ }
  }
  return p;
}

async function resolveIcon(p) {
  const source = iconSourceFor(p);
  for (const candidate of source === p ? [p] : [source, p]) {
    try {
      const img = await app.getFileIcon(candidate, { size: 'large' });
      if (img && !img.isEmpty()) return img.toDataURL();
    } catch { /* try the next candidate */ }
  }
  return null;
}

// A shortcut pointing at a disconnected network share makes both existsSync
// and the shell's icon lookup block for seconds. One of those must not be able
// to hold up the whole launcher, so every icon gets a deadline and anything
// slower simply falls back to its initial.
function iconFor(p) {
  return Promise.race([
    resolveIcon(p).catch(() => null),
    new Promise((res) => setTimeout(() => res(null), 2500).unref?.()),
  ]);
}

/**
 * @param {object} opts
 * @param {number} opts.max  cap on how many bodies to return
 * @returns {Promise<Array<{name:string,path:string,isDir:boolean,icon:string|null}>>}
 */
async function list({ max = 28 } = {}) {
  const seen = new Set();
  const items = [];

  for (const dir of desktopDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn('[orbit] cannot read', dir, '-', err.message);
      continue;
    }

    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (SKIP.has(lower) || e.name.startsWith('.')) continue;

      const name = displayName(e.name);
      const key = name.toLowerCase();
      if (seen.has(key)) continue;   // user desktop wins over the public one
      seen.add(key);

      items.push({ name, path: path.join(dir, e.name), isDir: e.isDirectory() });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const picked = items.slice(0, max);

  // getFileIcon hits the shell, so do them together rather than serially.
  await Promise.all(picked.map(async (it) => { it.icon = await iconFor(it.path); }));

  return picked;
}

/**
 * Watch the desktop folders and call back (debounced) when their contents
 * change, so adding a shortcut puts a new body in orbit without a restart.
 */
function watch(onChange) {
  const watchers = [];
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 700);
  };

  for (const dir of desktopDirs()) {
    try {
      watchers.push(fs.watch(dir, { persistent: false }, fire));
    } catch (err) {
      console.warn('[orbit] cannot watch', dir, '-', err.message);
    }
  }

  return () => {
    clearTimeout(timer);
    for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
  };
}

module.exports = { list, watch };
