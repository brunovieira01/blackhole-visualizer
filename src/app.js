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
  warp: document.getElementById('hud-warp'),
  fps: document.getElementById('hud-fps'),
};

const np = {
  root: document.getElementById('np'),
  kicker: document.getElementById('np-kicker'),
  title: document.getElementById('np-title'),
  artist: document.getElementById('np-artist'),
  app: document.getElementById('np-app'),
  bars: [...document.querySelectorAll('.np-meter i')],
  progress: document.getElementById('np-progress'),
  elapsed: document.getElementById('np-elapsed'),
  total: document.getElementById('np-total'),
  track: document.getElementById('np-track'),
  fill: document.getElementById('np-fill'),
  transport: document.getElementById('np-transport'),
  ppIcon: document.getElementById('np-pp-icon'),
};

const ICON_PLAY = 'M8 5l11 7-11 7z';
const ICON_PAUSE = 'M8 5v14M16 5v14';

// Position is only refreshed about once a second, so we advance it locally
// between updates and re-sync on every message.
const clock = { base: 0, at: 0, duration: 0, playing: false };

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

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

const WARP_STEPS = [0, 0.55, 1.0, 1.7, 2.6];
const WARP_LABELS = ['off', 'subtle', 'normal', 'strong', 'turbulent'];

let renderer;
let audio;
let settings = {};
let mode = 'window';
let toastTimer = null;
let hudTimer = null;
let nowPlaying = { kind: 'none' };

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
//  Now playing
// ---------------------------------------------------------------------------
function renderNowPlaying() {
  const info = nowPlaying || { kind: 'none' };
  const show = (settings.showNowPlaying ?? true) && info.kind !== 'none';

  document.body.classList.toggle('np-active', show);
  np.root.classList.toggle('show', show);
  if (!show) return;

  const isMedia = info.kind !== 'app';

  if (!isMedia) {
    // Something audible with no media metadata: name the app instead.
    np.kicker.textContent = 'audio from';
    np.title.textContent = info.app || 'unknown app';
    np.artist.textContent = '';
    np.app.textContent = '';
  } else {
    const paused = info.status && info.status !== 'Playing';
    np.kicker.textContent = paused ? 'paused' : 'now playing';
    np.title.textContent = info.title || '';
    np.artist.textContent = info.artist || '';
    np.app.textContent = info.app || '';
  }
  np.artist.style.display = np.artist.textContent ? '' : 'none';
  np.app.style.display = np.app.textContent ? '' : 'none';

  // ---- timeline ----
  const dur = isMedia ? (info.duration || 0) : 0;
  clock.duration = dur;
  clock.base = isMedia ? (info.position || 0) : 0;
  clock.at = performance.now();
  clock.playing = info.status === 'Playing';
  np.progress.style.display = dur > 0 ? '' : 'none';
  if (dur > 0) {
    np.total.textContent = fmtTime(dur);
    tickProgress();
  }

  // ---- transport ----
  np.transport.style.display = isMedia ? '' : 'none';
  np.ppIcon.setAttribute('d', clock.playing ? ICON_PAUSE : ICON_PLAY);
  const setEnabled = (cmd, on) => {
    const b = np.transport.querySelector(`[data-cmd="${cmd}"]`);
    if (b) b.disabled = !on;
  };
  setEnabled('prev', info.canPrev);
  setEnabled('next', info.canNext);
  setEnabled('playpause', info.canPlay || info.canPause);
}

function tickProgress() {
  if (!(clock.duration > 0)) return;
  const t = Math.min(
    clock.duration,
    clock.base + (clock.playing ? (performance.now() - clock.at) / 1000 : 0));
  np.fill.style.width = ((t / clock.duration) * 100).toFixed(2) + '%';
  np.elapsed.textContent = fmtTime(t);
}

// Theme colours are HDR (components above 1.0), so normalise against the
// brightest channel before handing an rgb triplet to CSS.
function applyAccent(hot) {
  const m = Math.max(hot[0], hot[1], hot[2], 1e-6);
  const rgb = hot.map((c) => Math.round(Math.min(255, 90 + (c / m) * 165)));
  document.documentElement.style.setProperty('--accent', rgb.join(', '));
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
    warp: settings.warp ?? 1.0,
    rings: settings.rings ?? 1.0,
    ringStyle: settings.ringStyle ?? 1,
    grain: settings.grain ?? 0.012,
    autoOrbit: settings.autoOrbit ?? 0,
  });

  applyAccent(theme.hot);
  renderNowPlaying();

  // Auto quality starts from "high" and adapts from there
  autoQuality.enabled = settings.quality === 'auto';
  if (autoQuality.enabled) {
    renderer.steps = 260;
    renderer.renderScale = 1.0;
  }

  els.theme.textContent = theme.label;
  els.mode.textContent = mode;
  const wi = WARP_STEPS.indexOf(settings.warp ?? 1.0);
  els.warp.textContent = wi >= 0 ? WARP_LABELS[wi] : String(settings.warp);
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
//  Transport controls
//
//  Clicks only reach us in window and overlay mode. As the wallpaper we sit
//  below Explorer's icon layer, which swallows every click on the desktop, so
//  there the transport is hidden and the tray menu / global hotkeys drive
//  playback instead.
// ---------------------------------------------------------------------------
function bindTransport() {
  document.body.classList.add('can-click');

  np.transport.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn || btn.disabled) return;
    bridge?.media(btn.dataset.cmd);
    // Flip the glyph immediately; the watcher confirms within a second.
    if (btn.dataset.cmd === 'playpause') {
      clock.playing = !clock.playing;
      clock.base = clock.base + 0;
      clock.at = performance.now();
      np.ppIcon.setAttribute('d', clock.playing ? ICON_PAUSE : ICON_PLAY);
    }
  });

  np.track.addEventListener('click', (e) => {
    if (!(clock.duration > 0) || !nowPlaying?.canSeek) return;
    const r = np.track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const secs = frac * clock.duration;
    bridge?.media(`seek ${secs.toFixed(2)}`);
    clock.base = secs;
    clock.at = performance.now();
    tickProgress();
  });
}

// Overlay mode is click-through so the desktop stays usable. Ask main for
// clicks back only while the pointer is actually over the panel.
function bindOverlayHover() {
  let inside = false;
  window.addEventListener('mousemove', (e) => {
    const r = np.root.getBoundingClientRect();
    const over = np.root.classList.contains('show') &&
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;
    if (over !== inside) {
      inside = over;
      bridge?.setInteractive(over);
    }
  });
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
    } else if (k === 'n') {
      bridge?.set('showNowPlaying', !(settings.showNowPlaying ?? true));
      toast('now playing ' + (settings.showNowPlaying ? 'off' : 'on'));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const cur = WARP_STEPS.indexOf(settings.warp ?? 1.0);
      const at = cur < 0 ? 2 : cur;
      const next = Math.max(0, Math.min(WARP_STEPS.length - 1,
        at + (e.key === 'ArrowRight' ? 1 : -1)));
      bridge?.set('warp', WARP_STEPS[next]);
      toast('wave depth ' + WARP_LABELS[next]);
    } else if (k === ',') {
      bridge?.media('prev');
      toast('previous track');
    } else if (k === '.') {
      bridge?.media('next');
      toast('next track');
    } else if (e.key === ' ') {
      e.preventDefault();
      bridge?.media('playpause');
      clock.playing = !clock.playing;
      clock.at = performance.now();
      np.ppIcon.setAttribute('d', clock.playing ? ICON_PAUSE : ICON_PLAY);
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

  nowPlaying = (await bridge?.getNowPlaying()) || { kind: 'none' };
  renderNowPlaying();
  bridge?.onNowPlaying((info) => { nowPlaying = info; renderNowPlaying(); });

  if (mode === 'window') {
    bindInteraction();
    bindTransport();
    showHud(true);
  } else if (mode === 'overlay') {
    bindTransport();
    bindOverlayHover();
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
  let meterAcc = 0;

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

    // Five little equaliser bars beside the track name, riding the spectrum.
    meterAcc += dt;
    if (meterAcc >= 1 / 24 && np.bars.length) {
      meterAcc = 0;
      tickProgress();
      const n = np.bars.length;
      const per = (a.spectrum.length / n) | 0;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = i * per; j < (i + 1) * per; j++) if (a.spectrum[j] > m) m = a.spectrum[j];
        np.bars[i].style.height = (12 + (m / 255) * 88).toFixed(1) + '%';
      }
    }

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
