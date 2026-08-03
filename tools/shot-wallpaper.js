// ---------------------------------------------------------------------------
//  Capture the live wallpaper without touching the screen.
//
//    node tools/shot-wallpaper.js [out.png]
//
//  PrintWindow with PW_RENDERFULLCONTENT asks a window to redraw itself into a
//  bitmap we own, so this works even when the wallpaper is completely covered
//  by other windows -- and it neither steals focus nor moves the cursor, which
//  matters when the person whose desktop this is happens to be using it.
//
//  Needs the visualizer to be running in wallpaper mode. Nothing is modified.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const desktop = require('../native/desktop');

const PW_RENDERFULLCONTENT = 2;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

// ---- minimal PNG encoder (same approach as tools/make-icon.js) -------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- capture ---------------------------------------------------------------
function main() {
  if (!desktop.available()) {
    console.error('koffi unavailable - this needs it for the Win32 calls.');
    process.exit(1);
  }

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');

  const RECT = koffi.struct('RECT', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
  });
  // BITMAPINFOHEADER followed by the colour table we don't use.
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32',
    biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
    biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });

  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool',
    ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
  const GetWindowDC = user32.func('__stdcall', 'GetWindowDC', 'uintptr_t', ['uintptr_t']);
  const ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', ['uintptr_t', 'uintptr_t']);
  const PrintWindow = user32.func('__stdcall', 'PrintWindow', 'bool',
    ['uintptr_t', 'uintptr_t', 'uint32']);

  const CreateCompatibleDC = gdi32.func('__stdcall', 'CreateCompatibleDC', 'uintptr_t', ['uintptr_t']);
  const CreateCompatibleBitmap = gdi32.func('__stdcall', 'CreateCompatibleBitmap', 'uintptr_t',
    ['uintptr_t', 'int', 'int']);
  const SelectObject = gdi32.func('__stdcall', 'SelectObject', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'bool', ['uintptr_t']);
  const DeleteDC = gdi32.func('__stdcall', 'DeleteDC', 'bool', ['uintptr_t']);
  const GetDIBits = gdi32.func('__stdcall', 'GetDIBits', 'int',
    ['uintptr_t', 'uintptr_t', 'uint32', 'uint32', 'void *',
      koffi.inout(koffi.pointer(BITMAPINFOHEADER)), 'uint32']);

  // The visualizer's window is a child of one of the WorkerWs. Try each of the
  // desktop's windows and keep whichever actually paints something.
  const d = desktop.findDesktop();
  const candidates = [...d.workers, d.progman].filter(Boolean);

  let best = null;
  for (const hwnd of candidates) {
    const rect = {};
    if (!GetWindowRect(hwnd, rect)) continue;
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    if (w < 64 || h < 64) continue;

    const srcDc = GetWindowDC(hwnd);
    if (!srcDc) continue;
    const memDc = CreateCompatibleDC(srcDc);
    const bmp = CreateCompatibleBitmap(srcDc, w, h);
    const old = SelectObject(memDc, bmp);

    const ok = PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT);

    // Pull the pixels back out. Negative height asks for a top-down buffer, so
    // the rows come in the order PNG wants them.
    const info = {
      biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
      biCompression: BI_RGB, biSizeImage: 0,
      biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    };
    const bits = Buffer.alloc(w * h * 4);
    SelectObject(memDc, old);
    const got = GetDIBits(srcDc, bmp, 0, h, bits, info, DIB_RGB_COLORS);

    DeleteObject(bmp);
    DeleteDC(memDc);
    ReleaseDC(hwnd, srcDc);

    if (!ok || !got) continue;

    // How much of it isn't black? An empty WorkerW prints as a black rectangle.
    let lit = 0;
    for (let i = 0; i < bits.length; i += 4 * 97) {
      if (bits[i] > 8 || bits[i + 1] > 8 || bits[i + 2] > 8) lit++;
    }
    const score = lit / (bits.length / (4 * 97));
    console.log(`  0x${hwnd.toString(16)}  ${w}x${h}  ${(score * 100).toFixed(1)}% lit`);
    if (!best || score > best.score) best = { hwnd, w, h, bits, score };
  }

  if (!best || best.score < 0.005) {
    console.error('\nNothing painted. Is the visualizer running in wallpaper mode?');
    process.exit(1);
  }

  // BGRA (Windows) -> RGBA (PNG), and force alpha opaque: PrintWindow leaves
  // it at zero, which would make the whole image transparent.
  const rgba = Buffer.alloc(best.bits.length);
  for (let i = 0; i < best.bits.length; i += 4) {
    rgba[i] = best.bits[i + 2];
    rgba[i + 1] = best.bits[i + 1];
    rgba[i + 2] = best.bits[i];
    rgba[i + 3] = 255;
  }

  const out = path.resolve(process.argv[2] || 'wallpaper.png');
  fs.writeFileSync(out, encodePng(best.w, best.h, rgba));
  console.log(`\nwrote ${out}  (${best.w}x${best.h}, from 0x${best.hwnd.toString(16)})`);
}

main();
