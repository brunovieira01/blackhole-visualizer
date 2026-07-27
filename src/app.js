// ---------------------------------------------------------------------------
//  Bootstrap: wire audio -> renderer, apply settings from the tray menu,
//  keep the frame rate honest, and handle the interactive bits.
// ---------------------------------------------------------------------------

import { BlackHoleRenderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { THEMES, THEME_IDS } from './themes.js';

const bridge = window.bhv;
const canvas = document.getElementById('gl');
const hud = document.getElementById('hud');
const toastEl = document.getElementById('toast');

const els = {
  source: document.getElementById('hud-source'),
  mode: document.getElementById('hud-mode'),
  theme: document.getElementById('hud-theme'),
  fps: document.getElementById('hud-fps'),
};

const SOURCE_LABEL = {
  loopback: 'system audio (loopback)',
  'stereo-mix': 'stereo mix input',
  microphone: 'microphone',
  demo: 'demo — no audio captured',
};

const QUALITY_PRESETS = {
  low: { steps: 130, scale: 0.62 },
  medium: { steps: 200, scale: 0.85 },
  high: { steps: 280, scale: 1.0 },
  ultra: { steps: 400, scale: 1.0 },
};

let renderer;
let audio;
let settings = {};
let mode = 'window';
let toastTimer = null;
let hudTimer = null;

function toast(msg) {
  if (document.body.classList.contains('passive')) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function showHud(temporarily) {
  hud.classList.remove('hidden');
  clearTimeout(hudTimer);
  if (temporarily) hudTimer = setTimeout(() => hud.classList.add('hidden'), 4200);
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
function applySettings(s) {
  settings = { ...settings, ...s };

  const theme = THEMES[settings.theme] || THEMES.gargantua;
  const q = QUALITY_PRESETS[settings.quality] || QUALITY_PRESETS.high;

  renderer.applySettings({
    theme: { hot: theme.hot, cool: theme.cool, nebula: theme.nebula },
    quality: q.steps,
    renderScale: q.scale,
    bloom: settings.bloom ?? 1.0,
    reactivity: settings.reactivity ?? 1.0,
    ring: settings.ring ?? true,
    wave: settings.wave ?? true,
    grain: settings.grain ?? 0.012,
    autoOrbit: settings.autoOrbit ?? 0.02,
  });

  // Auto quality starts from "high" and adapts from there
  autoQuality.enabled = settings.quality === 'auto';
  if (autoQuality.enabled) {
    renderer.steps = 260;
    renderer.renderScale = 1.0;
  }

  els.theme.textContent = theme.label;
  els.mode.textContent = mode;
}

// ---------------------------------------------------------------------------
//  Adaptive quality — nobody wants a stuttering wallpaper
// ---------------------------------------------------------------------------
const autoQuality = {
  enabled: false,
  acc: 0,
  frames: 0,
  cooldown: 2.0,
};

function tuneQuality(dt) {
  if (!autoQuality.enabled) return;
  autoQuality.acc += dt;
  autoQuality.frames++;
  autoQuality.cooldown -= dt;
  if (autoQuality.acc < 1.0) return;

  const fps = autoQuality.frames / autoQuality.acc;
  autoQuality.acc = 0;
  autoQuality.frames = 0;
  if (autoQuality.cooldown > 0) return;

  if (fps < 42) {
    if (renderer.renderScale > 0.6) renderer.renderScale = Math.max(0.6, renderer.renderScale - 0.1);
    else if (renderer.steps > 120) renderer.steps -= 40;
    else return;
    autoQuality.cooldown = 2.5;
  } else if (fps > 58) {
    if (renderer.steps < 300) renderer.steps += 25;
    else if (renderer.renderScale < 1.0) renderer.renderScale = Math.min(1.0, renderer.renderScale + 0.05);
    else return;
    autoQuality.cooldown = 4.0;
  }
}

// ---------------------------------------------------------------------------
//  Interaction (window mode only)
// ---------------------------------------------------------------------------
function bindInteraction() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    renderer.orbit -= (e.clientX - lastX) * 0.005;
    renderer.diskTilt = Math.max(-0.9, Math.min(0.9, renderer.diskTilt + (e.clientY - lastY) * 0.003));
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '6') {
      const id = THEME_IDS[+k - 1];
      if (id) { bridge?.set('theme', id); toast(THEMES[id].label); }
    } else if (k === 'h') {
      hud.classList.toggle('hidden');
    } else if (k === 'r') {
      bridge?.set('ring', !(settings.ring ?? true));
      toast('spectrum ring ' + (settings.ring ? 'off' : 'on'));
    } else if (k === 'w') {
      bridge?.set('wave', !(settings.wave ?? true));
      toast('waveform ' + (settings.wave ? 'off' : 'on'));
    } else if (k === 'f') {
      bridge?.toggleFullscreen();
    } else if (e.key === 'ArrowUp') {
      const v = Math.min(2.5, (settings.reactivity ?? 1) + 0.15);
      bridge?.set('reactivity', +v.toFixed(2));
      toast('reactivity ' + v.toFixed(2));
    } else if (e.key === 'ArrowDown') {
      const v = Math.max(0.2, (settings.reactivity ?? 1) - 0.15);
      bridge?.set('reactivity', +v.toFixed(2));
      toast('reactivity ' + v.toFixed(2));
    } else if (k === 'escape') {
      bridge?.hide();
    }
  });
}

// ---------------------------------------------------------------------------
//  Main loop
// ---------------------------------------------------------------------------
async function main() {
  renderer = new BlackHoleRenderer(canvas);
  audio = new AudioEngine();

  mode = (await bridge?.getMode()) || 'window';
  document.body.classList.toggle('passive', mode !== 'window');
  renderer.alphaOut = mode === 'overlay' ? 1 : 0;

  applySettings((await bridge?.getSettings()) || {});
  bridge?.onSettings((s) => applySettings(s));

  if (mode === 'window') {
    bindInteraction();
    showHud(true);
  }

  const src = await audio.start({ forceDemo: !!settings.forceDemo });
  els.source.textContent = SOURCE_LABEL[src] || src;
  bridge?.reportSource(src);
  if (src === 'demo') {
    console.warn('[audio] falling back to the demo signal — no capture device was available');
  }

  let last = performance.now();
  let time = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let silence = 0;      // seconds since anything was audible
  let skipAcc = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;

    const a = audio.update(dt);

    // Nothing playing? Idle down to ~12 fps instead of burning the GPU on a
    // still image. Any sound at all brings it straight back.
    silence = a.level < 0.035 ? silence + dt : 0;
    if ((settings.idleThrottle ?? true) && silence > 6) {
      skipAcc += dt;
      if (skipAcc < 1 / 12) { requestAnimationFrame(frame); return; }
      skipAcc = 0;
    }

    renderer.render(dt, time, a);
    tuneQuality(dt);

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      els.fps.textContent =
        `${Math.round(fpsFrames / fpsAcc)} · ${Math.round(renderer.renderScale * 100)}% · ${renderer.steps}`;
      fpsAcc = 0;
      fpsFrames = 0;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<pre style="color:#f96;font:13px/1.6 Consolas,monospace;padding:32px;white-space:pre-wrap">${err.stack || err}</pre>`;
});
