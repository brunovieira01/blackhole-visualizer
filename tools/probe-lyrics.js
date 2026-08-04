// ---------------------------------------------------------------------------
//  What the lyrics pipeline is actually doing, for whatever is playing now.
//
//    node tools/probe-lyrics.js [seconds]
//
//  Prints the track as Windows reports it, the LRCLIB record we matched, and
//  the line that would be on screen right now with the neighbours around it.
//  Run it while the song plays and compare against what you can hear: that
//  separates the three things that all look like "the lyrics are wrong".
//
//    * words are right, timing is off by a constant  -> lyricsOffset
//    * words are right, timing drifts as it plays    -> wrong master matched
//    * words are for a different song entirely       -> bad LRCLIB match
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fetchLyrics } = require('../lib/lyrics');

const seconds = Number(process.argv[2] || 20);

// Read the real setting rather than assuming the default, or this reports a
// different line from the one actually on screen.
let offset = -0.25;
try {
  const cfg = path.join(process.env.APPDATA, 'blackhole-visualizer', 'config.json');
  const raw = JSON.parse(fs.readFileSync(cfg, 'utf8').replace(/^﻿/, ''));
  if (typeof raw.lyricsOffset === 'number') offset = raw.lyricsOffset;
} catch { /* not configured yet; the default stands */ }
console.log(`lyrics offset in use: ${offset}s (negative = lines appear early)`);

const ps = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(__dirname, 'nowplaying.ps1'),
  '-IntervalMs', '1000',
], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
let track = null;
let lyrics = null;
let pending = false;
const started = Date.now();

ps.stdout.setEncoding('utf8');
ps.stdout.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;

    let np;
    try { np = JSON.parse(line); } catch { continue; }
    if (np.kind !== 'media' || !np.title) {
      console.log('nothing with media metadata is playing');
      continue;
    }

    const id = `${np.artist}|${np.title}|${Math.round(np.duration)}`;
    if (id !== track) {
      track = id;
      lyrics = null;
      console.log('\n' + '-'.repeat(72));
      console.log(`track     ${np.artist} - ${np.title}`);
      console.log(`album     ${np.album || '(none)'}`);
      console.log(`length    ${np.duration.toFixed(2)}s      app: ${np.app}`);
      console.log(`seekable  ${np.canSeek}`);

      if (!pending) {
        pending = true;
        const res = await fetchLyrics({
          artist: np.artist, title: np.title, album: np.album, duration: np.duration,
        });
        pending = false;
        if (!res) {
          console.log('\nno timed lyrics matched — nothing would be shown');
        } else {
          lyrics = res.synced;
          const drift = (res.duration || 0) - np.duration;
          console.log(`\nmatched   ${res.source}, ${lyrics.length} lines, ` +
            `${(res.duration || 0).toFixed(0)}s (${drift >= 0 ? '+' : ''}${drift.toFixed(1)}s vs the track)`);
          if (Math.abs(drift) > 2) {
            console.log('          ^ a different length means a different master. Even a');
            console.log('            couple of seconds shows up as the lyrics running ahead');
            console.log('            or behind by the end of the song.');
          }
          console.log(`first     ${lyrics[0].time.toFixed(2)}s  "${lyrics[0].text}"`);
          console.log(`last      ${lyrics[lyrics.length - 1].time.toFixed(2)}s  ` +
            `"${lyrics[lyrics.length - 1].text}"`);
        }
        console.log('-'.repeat(72));
      }
    }

    if (!lyrics) continue;

    // Same selection the renderer does, including the offset from config.
    const t = np.position - offset;
    let i = -1;
    while (i + 1 < lyrics.length && lyrics[i + 1].time <= t) i++;

    const at = (k) => (k >= 0 && k < lyrics.length)
      ? `${lyrics[k].time.toFixed(2).padStart(7)}s  ${lyrics[k].text}` : '';
    console.log(`\n[${np.position.toFixed(2)}s ${np.status}]`);
    console.log('   prev  ' + at(i - 1));
    console.log('  >CUR<  ' + at(i));
    console.log('   next  ' + at(i + 1));
  }
});

setTimeout(() => {
  ps.kill();
  console.log('\ndone.\n');
  process.exit(0);
}, seconds * 1000).unref?.();

void started;
