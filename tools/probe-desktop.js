// Read-only diagnostics for the desktop layer. Changes nothing.
//   node tools/probe-desktop.js
//
// Prints the shell's window hierarchy, whether the real icons are visible, and
// a live sample of the pointer state so you can see the "over the desktop"
// detection flip as you move the mouse between the desktop and an app window.

'use strict';

const desktop = require('../native/desktop');

if (!desktop.available()) {
  console.error('koffi unavailable — the desktop layer needs it.');
  process.exit(1);
}

const hex = (n) => (n ? '0x' + n.toString(16) : '(none)');

const d = desktop.findDesktop();
console.log('\nshell windows');
console.log('  Progman          ' + hex(d.progman));
console.log('  SHELLDLL_DefView ' + hex(d.defView));
console.log('  SysListView32    ' + hex(d.listView));
console.log('  WorkerW          ' + d.workers.map(hex).join(', '));
console.log('\nreal desktop icons visible: ' + desktop.iconsVisible());

console.log('\npointer (3s) — move the mouse between the desktop and a window:');
let last = '';
const started = Date.now();
const timer = setInterval(() => {
  const p = desktop.pointerState();
  if (p) {
    const line = `  ${String(p.x).padStart(5)},${String(p.y).padStart(5)}  ` +
      `onDesktop=${p.onDesktop ? 'YES' : 'no '}  ` +
      `L=${p.left ? 'down' : '  . '} R=${p.right ? 'down' : '  . '}`;
    if (line !== last) { console.log(line); last = line; }
  }
  if (Date.now() - started > 3000) {
    clearInterval(timer);
    console.log('\ndone.\n');
  }
}, 60);
