// Draws the app icon procedurally and writes assets/icon.png + assets/icon.ico.
// Pure Node — no image libraries, no binary blobs checked into the repo.
//   node tools/make-icon.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---- minimal PNG encoder --------------------------------------------------
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
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the icon itself ------------------------------------------------------
// A black shadow, a searing photon ring, and a warm halo — the same palette
// the Gargantua theme uses. Supersampled 3x3 for clean edges at 16px.
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const SS = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS - 0.5 - c) / c;
          const dy = (y + (sy + 0.5) / SS - 0.5 - c) / c;
          const d = Math.hypot(dx, dy);

          const halo = Math.exp(-(((d - 0.72) / 0.19) ** 2));
          const photon = Math.exp(-(((d - 0.50) / 0.050) ** 2));
          const shadow = 1 / (1 + Math.exp((d - 0.455) * 46));

          let i = Math.max(halo * 0.75, photon) * (1 - shadow);
          i *= Math.max(0, Math.min(1, (1.0 - d) * 6)); // fade at the edge

          const w = Math.min(1, i * i * 1.7); // white-hot core of the ring
          r += Math.min(1, i * (1.00 + w));
          g += Math.min(1, i * (0.58 + w * 0.9));
          b += Math.min(1, i * (0.20 + w));
          a += Math.min(1, i * 1.6 + shadow * 0.97);
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      buf[o] = Math.round((r / n) * 255);
      buf[o + 1] = Math.round((g / n) * 255);
      buf[o + 2] = Math.round((b / n) * 255);
      buf[o + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

// ---- ICO container (PNG-compressed entries, Vista+) ------------------------
function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  const blobs = [];
  images.forEach(({ size, png }, idx) => {
    const e = 6 + idx * 16;
    header[e] = size >= 256 ? 0 : size;     // 0 means 256
    header[e + 1] = size >= 256 ? 0 : size;
    header[e + 2] = 0;                      // palette size
    header[e + 3] = 0;                      // reserved
    header.writeUInt16LE(1, e + 4);         // colour planes
    header.writeUInt16LE(32, e + 6);        // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, ...blobs]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: encodePng(size, size, draw(size)) }));

fs.writeFileSync(path.join(outDir, 'icon.png'), images[images.length - 1].png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(images));
console.log('wrote assets/icon.png and assets/icon.ico (' + sizes.join(', ') + ')');
