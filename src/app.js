// ---------------------------------------------------------------------------
//  Bootstrap: wire audio -> renderer, apply settings from the tray menu,
//  keep the frame rate honest, and handle the interactive bits.
// ---------------------------------------------------------------------------

import { BlackHoleRenderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { THEMES, THEME_IDS } from './themes.js';
import { OrbitLauncher } from './orbit.js';

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
  volume: document.getElementById('np-volume'),
  mute: document.getElementById('np-mute'),
  volTrack: document.getElementById('np-vol-track'),
  volFill: document.getElementById('np-vol-fill'),
};

const lyricEls = {
  root: document.getElementById('lyrics'),
  prev: document.getElementById('lyric-prev'),
  cur: document.getElementById('lyric-cur'),
  next: document.getElementById('lyric-next'),
};

const ICON_PLAY = 'M8 5l11 7-11 7z';
const ICON_PAUSE = 'M8 5v14M16 5v14';

// Position is only refreshed about once a second, so we advance it locally
// between updates and re-sync against each message.
const clock = { base: 0, at: 0, duration: 0, playing: false, reported: null };

function playbackTime() {
  const t = clock.base + (clock.playing ? (performance.now() - clock.at) / 1000 : 0);
  if (!(clock.duration > 0)) return Math.max(0, t);
  return Math.max(0, Math.min(clock.duration, t));
}

// A reading that disagrees with us by more than this is a real move — a seek,
// a track change, a stall — rather than measurement noise.
const RESYNC_HARD = 1.5;

// Hard-resetting the clock on every message looks obvious but is wrong: the
// watcher reports about once a second and many players quantise the position
// to whole seconds, so the lyrics end up stuttering and sitting up to a second
// late. Small disagreements are eased out instead, which keeps the long-term
// accuracy of the reported position without inheriting its granularity.
function syncClock(position, playing, duration) {
  const now = performance.now();
  const wasPlaying = clock.playing;
  const hadDuration = clock.duration > 0;

  clock.duration = duration;
  clock.playing = playing;
  clock.reported = position;

  if (!(duration > 0)) { clock.base = 0; clock.at = now; return; }

  const predicted = clock.base + (wasPlaying ? (now - clock.at) / 1000 : 0);
  const drift = position - predicted;

  clock.base = (!hadDuration || playing !== wasPlaying || Math.abs(drift) > RESYNC_HARD)
    ? position
    : predicted + drift * 0.15;
  clock.at = now;
}

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
let orbit;
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
  const pos = isMedia ? (info.position || 0) : 0;
  // Only resync on an actual new reading. This runs again whenever settings
  // change, and re-applying a stale position would drag the clock backwards.
  if (pos !== clock.reported || dur !== clock.duration ||
      (info.status === 'Playing') !== clock.playing) {
    syncClock(pos, info.status === 'Playing', dur);
  }
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

  renderVolume(info);
}

// ---------------------------------------------------------------------------
//  Volume — the system master level, the same one the taskbar speaker drives.
//
//  Held optimistically: the watcher only reports once a second, and a slider
//  that snaps back for that long after every click feels broken.
// ---------------------------------------------------------------------------
const vol = { level: -1, muted: false, until: 0 };

function renderVolume(info) {
  const known = info && typeof info.volume === 'number' && info.volume >= 0;
  np.volume.style.display = known || vol.level >= 0 ? '' : 'none';
  if (!known && vol.level < 0) return;

  // Ignore incoming readings for a moment after a local change, or the value
  // visibly bounces back to the old one before the new one is picked up.
  if (known && performance.now() >= vol.until) {
    vol.level = info.volume;
    vol.muted = !!info.muted;
  }

  const pct = Math.round(Math.max(0, Math.min(1, vol.level)) * 100);
  np.volFill.style.width = pct + '%';
  np.volume.classList.toggle('muted', vol.muted);
  np.volume.classList.toggle('vol-0', !vol.muted && pct === 0);
  np.volume.classList.toggle('vol-1', !vol.muted && pct > 0 && pct < 55);
  np.mute.setAttribute('aria-label', vol.muted ? 'Unmute' : 'Mute');
}

function setVolumeFraction(frac) {
  const v = Math.max(0, Math.min(1, frac));
  bridge?.media(`volume ${v.toFixed(3)}`);
  vol.level = v;
  // Setting the level on a muted device is meant as "make it this loud".
  if (vol.muted) { bridge?.media('unmute'); vol.muted = false; }
  vol.until = performance.now() + 900;
  renderVolume(null);
}

function toggleMute() {
  bridge?.media('togglemute');
  vol.muted = !vol.muted;
  vol.until = performance.now() + 900;
  renderVolume(null);
}

function tickProgress() {
  if (!(clock.duration > 0)) return;
  const t = playbackTime();
  np.fill.style.width = ((t / clock.duration) * 100).toFixed(2) + '%';
  np.elapsed.textContent = fmtTime(t);
}

// ---------------------------------------------------------------------------
//  Lyrics
//
//  Main hands over the whole LRC for the current track; the timing is done
//  here against the same locally-advanced playback clock the progress bar
//  uses, so the line changes on the beat rather than once a second.
// ---------------------------------------------------------------------------
const lyricState = { data: null, index: -2, lastT: 0, on: null };

// How much of the bottom of the screen the lyric block is occupying. Measured
// only when the text actually changes: renderLyrics runs every frame, and
// getBoundingClientRect() forces a layout each time it's called.
function measureLyricSpace() {
  if (!lyricState.on) { orbit?.setReserveBottom(0); return; }
  const top = lyricEls.root.getBoundingClientRect().top;
  orbit?.setReserveBottom(Math.max(0, window.innerHeight - top + 24));
}

function setLyrics(data) {
  lyricState.data = data && data.lines?.length ? data : null;
  lyricState.index = -2;
  lyricState.lastT = 0;
  lyricEls.prev.textContent = '';
  lyricEls.cur.textContent = '';
  lyricEls.next.textContent = '';
  renderLyrics();
}

function renderLyrics() {
  const d = lyricState.data;
  const on = (settings.showLyrics ?? true) && !!d &&
    nowPlaying && nowPlaying.kind === 'media';

  if (on !== lyricState.on) {
    lyricState.on = on;
    lyricEls.root.classList.toggle('on', on);
    measureLyricSpace();
  }
  if (!on) return;

  const lines = d.lines;
  const t = playbackTime() - (settings.lyricsOffset ?? 0);

  // A seek (or a new track) can move time backwards; the cached index is only
  // a valid starting point when time moved forward.
  let i = t < lyricState.lastT ? -1 : Math.max(-1, lyricState.index);
  lyricState.lastT = t;
  if (i < -1 || i >= lines.length) i = -1;
  while (i + 1 < lines.length && lines[i + 1].time <= t) i++;
  while (i >= 0 && lines[i].time > t) i--;

  if (i === lyricState.index) return;
  lyricState.index = i;

  lyricEls.prev.textContent = i > 0 ? lines[i - 1].text : '';
  lyricEls.cur.textContent = i >= 0 ? lines[i].text : '';
  lyricEls.next.textContent = i + 1 < lines.length ? lines[i + 1].text : '';

  // The block's height changes with the wrapping, so re-measure on the only
  // frames where it can have changed.
  measureLyricSpace();
}

// Theme colours are HDR (components above 1.0), so normalise against the
// brightest channel before handing an rgb triplet to CSS.
function applyAccent(hot) {
  const m = Math.max(hot[0], hot[1], hot[2], 1e-6);
  const rgb = hot.map((c) => Math.round(Math.min(255, 90 + (c / m) * 165)));
  document.documentElement.style.setProperty('--accent', rgb.join(', '));
  // The launcher's icon tint aims a hue-rotate at the accent, so it needs the
  // hue on its own rather than as a colour.
  document.documentElement.style.setProperty('--accent-hue', String(hueOf(rgb)));
}

function hueOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
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

  orbit?.setOptions({
    enabled: !!settings.orbitLauncher,
    speed: settings.orbitSpeed ?? 1.0,
    scale: settings.orbitScale ?? 1.0,
    tint: settings.orbitTintIcons !== false,
  });

  applyAccent(theme.hot);
  renderNowPlaying();
  renderLyrics();

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
function runCommand(cmd) {
  bridge?.media(cmd);
  // Flip the glyph immediately; the watcher confirms within a second.
  if (cmd === 'playpause') {
    // Bank the time accrued so far before flipping, or a pause/resume would
    // rewind to wherever the last message left the base.
    clock.base = playbackTime();
    clock.at = performance.now();
    clock.playing = !clock.playing;
    np.ppIcon.setAttribute('d', clock.playing ? ICON_PAUSE : ICON_PLAY);
  }
}

function seekToFraction(frac) {
  if (!(clock.duration > 0)) return;
  const secs = Math.max(0, Math.min(1, frac)) * clock.duration;
  // Always invariant: the watcher parses this with InvariantCulture, because
  // [double]::TryParse on a comma-decimal locale reads "123.45" as 12345 and
  // the player answers a seek past the end by skipping to the next track.
  bridge?.media(`seek ${secs.toFixed(2)}`);
  clock.base = secs;
  clock.at = performance.now();
  clock.reported = null;      // force a real resync on the next reading
  tickProgress();
}

function bindTransport() {
  document.body.classList.add('can-click');

  np.transport.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn || btn.disabled) return;
    runCommand(btn.dataset.cmd);
  });

  np.track.addEventListener('click', (e) => {
    if (!(clock.duration > 0) || !nowPlaying?.canSeek) return;
    const r = np.track.getBoundingClientRect();
    seekToFraction((e.clientX - r.left) / r.width);
  });

  np.mute.addEventListener('click', toggleMute);
  np.volTrack.addEventListener('click', (e) => {
    const r = np.volTrack.getBoundingClientRect();
    setVolumeFraction((e.clientX - r.left) / r.width);
  });
}

// ---------------------------------------------------------------------------
//  Transport via the forwarded pointer (wallpaper mode)
//
//  No real mouse event ever reaches this window, so the buttons are hit-tested
//  against their own layout rectangles instead. Same commands, same panel — it
//  just gets its coordinates from the main process rather than from the DOM.
// ---------------------------------------------------------------------------
let hotButton = null;

function inRect(p, r) {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

function transportButtonAt(p) {
  if (!p || !np.root.classList.contains('show')) return null;
  for (const b of np.transport.querySelectorAll('button[data-cmd]')) {
    if (!b.disabled && inRect(p, b.getBoundingClientRect())) return b;
  }
  if (np.volume.style.display !== 'none' && inRect(p, np.mute.getBoundingClientRect())) {
    return np.mute;
  }
  return null;
}

// A few-pixel-tall bar is not a real target for a mouse, so both sliders get a
// taller invisible grab band centred on them.
function onSlider(p, el, band = 16) {
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right &&
    Math.abs(p.y - (r.top + r.bottom) / 2) <= band;
}

function transportHover(p) {
  const hit = transportButtonAt(p);
  if (hit === hotButton) return;
  hotButton?.classList.remove('hot');
  hotButton = hit;
  hotButton?.classList.add('hot');
}

function transportClick(p) {
  const btn = transportButtonAt(p);
  if (btn === np.mute) { toggleMute(); return true; }
  if (btn) { runCommand(btn.dataset.cmd); return true; }

  if (np.volume.style.display !== 'none' && onSlider(p, np.volTrack, 13)) {
    const r = np.volTrack.getBoundingClientRect();
    setVolumeFraction((p.x - r.left) / r.width);
    return true;
  }

  if (clock.duration > 0 && nowPlaying?.canSeek && onSlider(p, np.track)) {
    const r = np.track.getBoundingClientRect();
    seekToFraction((p.x - r.left) / r.width);
    return true;
  }
  return false;
}

// Overlay mode is click-through so the desktop stays usable. Ask main for
// clicks back only while the pointer is actually over something clickable —
// the transport panel, or one of the orbiting shortcuts.
function bindOverlayHover() {
  let inside = false;
  window.addEventListener('mousemove', (e) => {
    const r = np.root.getBoundingClientRect();
    const over = (np.root.classList.contains('show') &&
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom) ||
      !!orbit?.hitAt(e.clientX, e.clientY);
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
      runCommand('playpause');
    } else if (k === 'o') {
      const on = !settings.orbitLauncher;
      bridge?.set('orbitLauncher', on);
      toast('orbit launcher ' + (on ? 'on' : 'off'));
    } else if (k === 'l') {
      const on = !(settings.showLyrics ?? true);
      bridge?.set('showLyrics', on);
      toast('lyrics ' + (on ? 'on' : 'off'));
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
  // Fetched before the renderer is built because the GL context options are
  // fixed at creation time and one of them (preserveDrawingBuffer) depends on
  // whether this is a --shot run.
  const initialSettings = (await bridge?.getSettings()) || {};

  renderer = new BlackHoleRenderer(canvas, { forShot: !!initialSettings.shotMode });
  audio = new AudioEngine();

  mode = (await bridge?.getMode()) || 'window';
  document.body.classList.toggle('passive', mode !== 'window');
  renderer.alphaOut = mode === 'overlay' ? 1 : 0;

  orbit = new OrbitLauncher(document.getElementById('orbit'), {
    onLaunch: (item) => bridge?.orbitLaunch(item.path),
    onContext: (item) => bridge?.orbitContext(item.path),
  });
  // As the wallpaper we are below Explorer's desktop, which eats every click.
  // Main forwards the global cursor instead; everywhere else the elements get
  // ordinary pointer events.
  orbit.setSynthetic(mode === 'wallpaper');
  // Only claim the transport is usable if main is actually forwarding the
  // cursor; without koffi it isn't, and the buttons would be dead on screen.
  if (initialSettings.pointerForwarding) document.body.classList.add('forwarded');
  bridge?.onDesktopPointer((p) => { orbit.pointer(p); transportHover(p); });
  bridge?.onDesktopClick((p) => {
    if (p.button !== 'left') return;
    // The panel wins over a body underneath it — it's the smaller target and
    // the one the pointer was deliberately aimed at.
    if (transportClick(p)) return;
    orbit.click(p, p.button);
  });
  orbit.setItems((await bridge?.getOrbitItems()) || []);
  bridge?.onOrbitItems((items) => orbit.setItems(items || []));

  applySettings(initialSettings);
  bridge?.onSettings((s) => applySettings(s));

  nowPlaying = (await bridge?.getNowPlaying()) || { kind: 'none' };
  renderNowPlaying();
  bridge?.onNowPlaying((info) => { nowPlaying = info; renderNowPlaying(); renderLyrics(); });

  setLyrics(await bridge?.getLyrics());
  bridge?.onLyrics((l) => setLyrics(l));

  if (mode === 'window') {
    bindInteraction();
    bindTransport();
    showHud(true);
  } else if (mode === 'overlay') {
    bindTransport();
    bindOverlayHover();
  }

  const showSource = (s) => {
    els.source.textContent = SOURCE_LABEL[s] || s;
    bridge?.reportSource(s);
  };

  const src = await audio.start({
    forceDemo: !!settings.forceDemo,
    allowMicInput: settings.allowMicInput === true,
    // Fires again whenever capture is re-acquired after an output device
    // change, so the HUD and tray don't keep claiming the old source.
    onSource: showSource,
  });
  showSource(src);
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

    // Both run above the idle throttle: the launcher has to stay hoverable
    // and the lyrics have to keep flowing through a quiet passage, neither of
    // which costs anything next to the shader.
    orbit.layout(dt, a);
    renderLyrics();

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
