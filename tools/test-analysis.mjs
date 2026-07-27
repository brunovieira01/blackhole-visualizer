// Checks that the analyser actually balances the spectrum.
//
// Raw music spectra fall off steeply with frequency: a kick sits ~7x higher in
// byte terms than a hi-hat. A naive reading makes the visuals all bass. This
// drives the real AudioEngine with a synthetic but realistic spectrum and
// asserts that bass, mid and treble all end up in a comparable range, and that
// band-limited signals light up only their own band.
//
//   node tools/test-analysis.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// src/audio.js is an ES module but the package is CommonJS, so hand it to the
// loader as a data: URL rather than restructuring the app for a test.
const src = readFileSync(join(here, '..', 'src', 'audio.js'), 'utf8');
const { AudioEngine } = await import(
  'data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const FFT = 4096;
const BINS = FFT / 2;
const SAMPLE_RATE = 48000;
const NYQUIST = SAMPLE_RATE / 2;
const MIN_DB = -95;
const MAX_DB = -10;

// Typical pop/rock spectral tilt: about -8 dB per octave above 60 Hz.
function musicDb(f) {
  return -22 - 8 * Math.log2(Math.max(f, 60) / 60);
}

function makeEngine(shape) {
  const eng = new AudioEngine();
  const freq = new Uint8Array(BINS);
  const time = new Uint8Array(FFT);
  let t = 0;

  eng.ctx = { sampleRate: SAMPLE_RATE };
  eng.analyser = {
    fftSize: FFT,
    frequencyBinCount: BINS,
    getByteFrequencyData: (a) => a.set(freq),
    getByteTimeDomainData: (a) => a.set(time),
  };
  eng.freq = freq;
  eng.time = time;
  eng._buildBinMap();

  return {
    eng,
    step(dt) {
      t += dt;
      for (let j = 0; j < BINS; j++) {
        const f = (j * NYQUIST) / BINS;
        const db = shape(f, t);
        freq[j] = Math.max(0, Math.min(255, ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 255));
      }
      for (let i = 0; i < FFT; i++) time[i] = 128 + Math.sin(i * 0.05 + t * 8) * 40;
      return eng.update(dt);
    },
  };
}

// Run for a few seconds so the adaptive floor/ceiling settles, then report the
// average of the last second.
function run(name, shape) {
  const h = makeEngine(shape);
  const dt = 1 / 60;
  const acc = { bass: 0, mid: 0, treble: 0, level: 0 };
  let beats = 0;
  let n = 0;

  for (let i = 0; i < 60 * 6; i++) {
    const o = h.step(dt);
    if (o.beat > 0.95) beats++;
    if (i >= 60 * 5) {
      acc.bass += o.bass; acc.mid += o.mid; acc.treble += o.treble; acc.level += o.level;
      n++;
    }
  }
  // How much of the spectrum is pinned at the top? A visualiser whose bars are
  // all at maximum shows no detail at all.
  const spec = h.eng.out.spectrum;
  let hot = 0;
  for (let i = 0; i < spec.length; i++) if (spec[i] > 242) hot++;

  const r = {
    name,
    bass: acc.bass / n,
    mid: acc.mid / n,
    treble: acc.treble / n,
    level: acc.level / n,
    beats,
    saturated: hot / spec.length,
  };
  console.log(
    `${name.padEnd(22)} bass=${r.bass.toFixed(3)}  mid=${r.mid.toFixed(3)}` +
    `  treble=${r.treble.toFixed(3)}  level=${r.level.toFixed(3)}` +
    `  onsets=${String(beats).padStart(2)}  saturated=${(r.saturated * 100).toFixed(0)}%`);
  return r;
}

// A kick every 500 ms, hats every 250 ms, pads wandering underneath.
const fullMix = (f, t) => {
  let db = musicDb(f);
  if (f < 160) db += 14 * Math.pow(1 - ((t * 2) % 1), 5);              // kick
  if (f > 2500) db += 12 * Math.pow(1 - ((t * 4) % 1), 9);             // hats
  if (f >= 160 && f <= 2500) db += 6 * Math.sin(t * 3 + f * 0.002);    // pads
  return Math.max(MIN_DB, Math.min(MAX_DB, db));
};

// A loud, dense, broadband master - the kind of thing that pinned every bin at
// maximum when the level was taken purely from a per-bin contrast stretch.
const loudMix = (f, t) => {
  let db = -14 - 5 * Math.log2(Math.max(f, 60) / 60);
  db += 3 * Math.sin(t * 5 + f * 0.004);
  if (f < 160) db += 5 * Math.pow(1 - ((t * 2) % 1), 5);
  if (f > 2500) db += 5 * Math.pow(1 - ((t * 4) % 1), 9);
  return Math.max(MIN_DB, Math.min(MAX_DB, db));
};

const bassOnly = (f, t) =>
  Math.max(MIN_DB, Math.min(MAX_DB,
    f < 150 ? -24 + 12 * Math.pow(1 - ((t * 2) % 1), 5) : MIN_DB));

const trebleOnly = (f, t) =>
  Math.max(MIN_DB, Math.min(MAX_DB,
    f > 3000 ? -58 + 10 * Math.pow(1 - ((t * 4) % 1), 9) : MIN_DB));

const silence = () => MIN_DB;

console.log('\nanalyser balance check\n');
const mix = run('full mix', fullMix);
const loud = run('loud dense mix', loudMix);
const bass = run('bass only', bassOnly);
const treble = run('treble only (quiet)', trebleOnly);
const quiet = run('silence', silence);

console.log('');
let failed = 0;
function check(ok, msg) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!ok) failed++;
}

// The point of the whole exercise: no band may dominate the others on a
// normal mix, even though the raw bass is ~7x the raw treble.
const spread = Math.max(mix.bass, mix.mid, mix.treble) /
               Math.max(Math.min(mix.bass, mix.mid, mix.treble), 1e-6);
check(spread < 2.5, `full mix bands within 2.5x of each other (got ${spread.toFixed(2)}x)`);
check(mix.treble > 0.25, `treble responds on a normal mix (${mix.treble.toFixed(3)})`);
check(mix.beats > 8, `onsets detected across the mix (${mix.beats})`);

// The failure this guards against: a purely relative (per-bin) normaliser
// drives every bin to its own recent maximum, so a dense passage pins the
// whole spectrum flat and the visualiser shows no detail at all.
check(mix.saturated < 0.25,
  `normal mix keeps headroom (${(mix.saturated * 100).toFixed(0)}% of bins maxed)`);
check(loud.saturated < 0.40,
  `loud dense mix still has detail (${(loud.saturated * 100).toFixed(0)}% of bins maxed)`);
check(loud.treble > 0.25 && loud.bass > 0.25,
  `loud mix still reads across bands (bass ${loud.bass.toFixed(2)}, treble ${loud.treble.toFixed(2)})`);

// Band-limited signals must stay in their own lane.
check(bass.bass > 0.35 && bass.treble < 0.10,
  `bass-only lights bass, not treble (${bass.bass.toFixed(3)} / ${bass.treble.toFixed(3)})`);
check(treble.treble > 0.30 && treble.bass < 0.10,
  `quiet treble-only still registers (${treble.treble.toFixed(3)} / ${treble.bass.toFixed(3)})`);

// And the noise floor must not be stretched into a signal.
check(quiet.level < 0.02, `silence stays silent (${quiet.level.toFixed(4)})`);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
