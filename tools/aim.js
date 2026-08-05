// ---------------------------------------------------------------------------
//  Work out the --look angles that put a given sky direction on screen.
//
//    node tools/aim.js 0.16 0.60 0.78 [screenX] [screenY]
//
//  The deep-sky objects are fixed points spread around the whole sphere, and
//  aiming at one by hand is guesswork: pointing the camera straight at it puts
//  it behind the black hole, and offsetting the azimuth moves it diagonally
//  once the pitch is steep. This inverts the camera in src/shaders.js instead.
//
//  Screen coordinates match the shader's uv: x is +-aspect/2, y is +-0.5, and
//  (0,0) is the middle of the frame -- which is where the hole is, so ask for
//  something like 0.45,0.12 rather than the centre.
// ---------------------------------------------------------------------------

'use strict';

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Mirrors the camera block in shaders.js main().
function screenOf(target, orbit, pitch) {
  const ro = [
    Math.sin(orbit) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(orbit) * Math.cos(pitch),
  ];
  const fwd = norm([-ro[0], -ro[1], -ro[2]]);
  const right = norm(cross([0, 1, 0], fwd));
  const up = cross(fwd, right);

  // vel = normalize(fwd*1.05 + right*x + up*y); invert by projecting.
  const f = dot(target, fwd);
  if (f <= 0.05) return null;                 // behind the camera
  return { x: dot(target, right) / f * 1.05, y: dot(target, up) / f * 1.05 };
}

const argv = process.argv.slice(2).map(Number);
const target = norm([argv[0], argv[1], argv[2]]);
const wantX = isFinite(argv[3]) ? argv[3] : 0.45;
const wantY = isFinite(argv[4]) ? argv[4] : 0.12;

let best = null;
for (let i = 0; i < 1440; i++) {
  const orbit = (i / 1440) * Math.PI * 2 - Math.PI;
  for (let j = -60; j <= 60; j++) {
    const pitch = j / 60 * 1.2;
    const s = screenOf(target, orbit, pitch);
    if (!s) continue;
    const err = Math.hypot(s.x - wantX, s.y - wantY);
    if (!best || err < best.err) best = { err, orbit, pitch, s };
  }
}

if (!best) {
  console.error('no view found');
  process.exit(1);
}
console.log(`target      ${target.map((v) => v.toFixed(3)).join(', ')}`);
console.log(`lands at    x=${best.s.x.toFixed(3)} y=${best.s.y.toFixed(3)} (wanted ${wantX}, ${wantY})`);
console.log(`--look=${best.orbit.toFixed(4)},${best.pitch.toFixed(4)}`);
