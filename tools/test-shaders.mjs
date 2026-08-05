// Structural checks on the GLSL. Cheap, and they catch the one failure mode
// that costs the most time to diagnose by hand.
//
//   node tools/test-shaders.mjs
//
// The whole shader lives inside JS template literals, so a stray backtick in a
// comment ends the string early. What you get then is a JavaScript
// SyntaxError, a black window, and no shader compile error to go on -- the
// symptom points nowhere near the cause. Importing the module here turns that
// into a test failure with a line number instead.

import { VERT, SCENE_FRAG, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG }
  from '../src/shaders.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

const stages = { VERT, SCENE_FRAG, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG };

console.log('\nshader sources\n');
for (const [name, src] of Object.entries(stages)) {
  check(`${name} is a non-empty string`, typeof src === 'string' && src.length > 40);
  check(`${name} declares a version`, src.trimStart().startsWith('#version 300 es'));
  check(`${name} has a main()`, /\bvoid\s+main\s*\(/.test(src));
  // Unbalanced braces are what a truncated template literal looks like once it
  // still happens to parse as JavaScript.
  const open = (src.match(/\{/g) || []).length;
  const close = (src.match(/\}/g) || []).length;
  check(`${name} has balanced braces`, open === close, `${open} open / ${close} close`);
}

console.log('\nscene shader entry points\n');
for (const fn of ['background', 'diskSample', 'starColor', 'starLayer',
  'nebulaHelix', 'nebulaButterfly', 'galaxyJet', 'sdShip', 'shadeShip']) {
  check(`defines ${fn}()`, new RegExp(`\\b${fn}\\s*\\(`).test(SCENE_FRAG));
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
