// Live check against LRCLIB. Needs network; skips cleanly without one.
//   node tools/test-lyrics.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// lyrics.js only needs fetch, but it lives under lib/ next to modules that
// require electron, so import it directly.
const { fetchLyrics, parseLrc } = require('../lib/lyrics.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

console.log('\nLRC parsing (offline)\n');
{
  const lines = parseLrc([
    '[ar:Someone]',
    '[00:12.50]first line',
    '[00:15.00][00:45.00]repeated hook',
    '[00:20.25]second line',
    'no timestamp at all',
  ].join('\n'));

  check('drops metadata and untimed lines', lines.length === 4, `got ${lines.length}`);
  check('parses mm:ss.xx', Math.abs(lines[0].time - 12.5) < 1e-6, `${lines[0].time}`);
  check('expands multi-stamp lines', lines.filter((l) => l.text === 'repeated hook').length === 2);
  check('sorts by time', lines.every((l, i, a) => i === 0 || a[i - 1].time <= l.time));
}

console.log('\n[offset:] handling — this is what "the lyrics are out of time" was\n');
{
  const body = '[00:30.00]line';
  const plain = parseLrc(body);
  const early = parseLrc('[offset:+2000]\n' + body);
  const late = parseLrc('[offset:-1500]\n' + body);

  check('no offset tag leaves timings alone', Math.abs(plain[0].time - 30) < 1e-6);
  check('positive offset shows the line earlier',
    Math.abs(early[0].time - 28) < 1e-6, `${early[0].time}s`);
  check('negative offset shows the line later',
    Math.abs(late[0].time - 31.5) < 1e-6, `${late[0].time}s`);
  check('an offset cannot push a line before the start',
    parseLrc('[offset:+99000]\n' + body)[0].time === 0);
  check('the offset tag is not itself a lyric', early.length === 1);
}

console.log('\nLRCLIB lookup (live)\n');
try {
  const res = await fetchLyrics({
    artist: 'Daft Punk',
    title: 'Instant Crush',
    album: 'Random Access Memories',
    duration: 337,
  });

  if (!res) {
    console.log('  SKIP  no result (offline, or the track moved) — not a failure');
  } else {
    check('returns something', !!res);
    check('has synced lyrics', Array.isArray(res.synced) && res.synced.length > 5,
      `${res.synced ? res.synced.length : 0} lines`);
    // The unsynced path used to dump the whole song on screen as one block.
    check('never returns an unsynced wall of text', res.plain === undefined);
    check('the match is the same length as the track',
      Math.abs((res.duration || 0) - 337) <= 5, `${res.duration}s vs 337s`);
    if (res.synced?.length) {
      check('timestamps look sane', res.synced[0].time >= 0 &&
        res.synced[res.synced.length - 1].time < 1200);
      console.log(`\n  first lines:`);
      for (const l of res.synced.slice(0, 3)) {
        console.log(`    ${l.time.toFixed(2).padStart(7)}s  ${l.text}`);
      }
    }
  }
} catch (err) {
  console.log('  SKIP  network unavailable:', err.message);
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}\n`);
// Set the code rather than calling process.exit(): undici keeps a keep-alive
// socket open briefly after a fetch, and tearing the loop down underneath it
// trips a libuv assertion.
process.exitCode = failed === 0 ? 0 : 1;
