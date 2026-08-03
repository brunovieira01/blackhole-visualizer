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
