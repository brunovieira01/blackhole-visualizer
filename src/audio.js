// ---------------------------------------------------------------------------
//  System audio capture + analysis.
//
//  Capture strategy, in order:
//    1. WASAPI loopback via getDisplayMedia  (main.js answers the request with
//       audio: 'loopback', so we get exactly what the speakers are playing —
//       Spotify, YouTube, games, everything, with no cables or Stereo Mix)
//    2. A "Stereo Mix" style input device via getUserMedia
//    3. Any microphone
//    4. Synthetic demo signal, so the visualiser never sits there dead
//
//  The analysis is deliberately *not* a plain FFT readout. Raw music spectra
//  fall off steeply with frequency, so a naive reading is all kick drum and no
//  hi-hat. Every bin gets its own adaptive floor/ceiling instead, which gives
//  quiet high-frequency detail the same room to move as the bass.
// ---------------------------------------------------------------------------

const BINS = 256;          // log-spaced spectrum bins handed to the shader
const FMIN = 28;
const FMAX = 16000;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Index of a frequency within our log-spaced bins.
const idxOf = (f) => Math.round((BINS * Math.log(f / FMIN)) / Math.log(FMAX / FMIN));
const BASS_END = idxOf(165);
const MID_END = idxOf(2200);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.mode = 'none';

    this.freq = null;      // raw linear FFT magnitudes (byte)
    this.time = null;      // raw time-domain (byte)

    // Values consumed by the renderer
    this.out = {
      bass: 0, mid: 0, treble: 0, level: 0, beat: 0,
      spectrum: new Uint8Array(BINS),
      wave: new Uint8Array(BINS),
    };

    // Per-bin adaptive normalisation state
    this._ceil = new Float32Array(BINS);
    this._floor = new Float32Array(BINS);
    this._norm = new Float32Array(BINS);
    this._prevNorm = new Float32Array(BINS);
    this._smoothBin = new Float32Array(BINS);

    this._smooth = { bass: 0, mid: 0, treble: 0, level: 0 };
    this._fluxHist = new Float32Array(48);
    this._fluxIdx = 0;
    this._beatCooldown = 0;
    this._binMap = null;
    this._waveScale = 1;
    this._demoPhase = 0;
  }

  async start({ forceDemo = false } = {}) {
    if (forceDemo) {
      this.mode = 'demo';
      return 'demo';
    }

    const attempts = [
      ['loopback', () => navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
      })],
      ['stereo-mix', () => this._stereoMix()],
      ['microphone', () => navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
      })],
    ];

    for (const [mode, get] of attempts) {
      try {
        const stream = await get();
        if (!stream || stream.getAudioTracks().length === 0) {
          stream?.getTracks().forEach((t) => t.stop());
          continue;
        }
        // We only ever asked for video to satisfy getDisplayMedia; drop it
        // immediately so nothing is actually being screen-captured.
        stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
        this._attach(stream);
        this.mode = mode;
        return mode;
      } catch (err) {
        console.warn(`[audio] ${mode} unavailable:`, err.message);
      }
    }

    this.mode = 'demo';
    return 'demo';
  }

  async _stereoMix() {
    // Needs a one-off getUserMedia to unlock device labels.
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (s) => s.getTracks().forEach((t) => t.stop()), () => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const re = /stereo mix|what u hear|wave out|loopback|mixagem est|misturagem|st[ée]r[ée]o/i;
    const dev = devices.find((d) => d.kind === 'audioinput' && re.test(d.label));
    if (!dev) throw new Error('no loopback-style input device found');
    return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId } } });
  }

  _attach(stream) {
    this.stream = stream;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    // Light smoothing only — the per-bin normaliser below does the shaping,
    // and heavy smoothing here would swallow the transients we detect on.
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -95;
    this.analyser.maxDecibels = -10;
    // NOTE: deliberately not connected to ctx.destination — that would echo
    // the desktop audio back out through the speakers.
    this.source.connect(this.analyser);

    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Uint8Array(this.analyser.fftSize);
    this._buildBinMap();

    // Some tracks arrive suspended until the window has focus.
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // Precompute, for each of our BINS log-spaced output bins, the FFT bin range
  // it averages over. Log spacing is what makes a spectrum "look" musical.
  _buildBinMap() {
    const nyquist = this.ctx.sampleRate / 2;
    const n = this.analyser.frequencyBinCount;
    const map = new Array(BINS);
    for (let i = 0; i < BINS; i++) {
      const f0 = FMIN * Math.pow(FMAX / FMIN, i / BINS);
      const f1 = FMIN * Math.pow(FMAX / FMIN, (i + 1) / BINS);
      let a = Math.floor((f0 / nyquist) * n);
      let b = Math.ceil((f1 / nyquist) * n);
      a = Math.max(0, Math.min(n - 1, a));
      b = Math.max(a + 1, Math.min(n, b));
      map[i] = [a, b];
    }
    this._binMap = map;
  }

  _bandMean(from, to) {
    let s = 0;
    for (let i = from; i < to; i++) s += this._norm[i];
    return to > from ? s / (to - from) : 0;
  }

  update(dt) {
    const o = this.out;
    if (!this.analyser) { this._demo(dt); return o; }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    const norm = this._norm;
    const ceil = this._ceil;
    const flr = this._floor;

    // --- per-bin adaptive contrast stretch -------------------------------
    // Ceiling tracks peaks instantly and bleeds away slowly; the floor does
    // the mirror image. Normalising between them means a -75 dB hi-hat and a
    // -25 dB kick both swing across the full range.
    const ceilFall = Math.min(1, dt * 0.55);
    const floorRise = Math.min(1, dt * 0.22);
    const binAtk = Math.min(1, dt * 34);
    const binRel = Math.min(1, dt * 8);

    for (let i = 0; i < BINS; i++) {
      const [a, b] = this._binMap[i];
      let m = 0;
      for (let j = a; j < b; j++) if (this.freq[j] > m) m = this.freq[j];
      const raw = m / 255;

      if (raw > ceil[i]) ceil[i] = raw; else ceil[i] += (raw - ceil[i]) * ceilFall;
      if (raw < flr[i]) flr[i] = raw; else flr[i] += (raw - flr[i]) * floorRise;

      const span = Math.max(ceil[i] - flr[i], 0.045);
      let v = clamp01((raw - flr[i]) / span);

      // Gate on the *absolute* level so a silent bin's noise floor doesn't get
      // stretched into a full-scale signal.
      v *= clamp01((raw - 0.035) / 0.09);

      norm[i] = v;

      const s = this._smoothBin[i];
      this._smoothBin[i] = s + (v - s) * (v > s ? binAtk : binRel);
    }

    // --- spectrum handed to the shader (1-2-1 blur to keep it smooth) -----
    for (let i = 0; i < BINS; i++) {
      const l = this._smoothBin[i > 0 ? i - 1 : 0];
      const c = this._smoothBin[i];
      const r = this._smoothBin[i < BINS - 1 ? i + 1 : BINS - 1];
      o.spectrum[i] = Math.min(255, ((l + 2 * c + r) * 0.25) * 255);
    }

    // --- waveform, auto-scaled so soft passages still ripple the disk -----
    const step = this.time.length / BINS;
    let peak = 0;
    for (let i = 0; i < this.time.length; i += 4) {
      const d = Math.abs(this.time[i] - 128);
      if (d > peak) peak = d;
    }
    const target = 118 / Math.max(peak, 4);
    // Ease the scale so the wave doesn't visibly "breathe" at every transient
    this._waveScale += (Math.min(target, 7) - this._waveScale) * Math.min(1, dt * 2.2);
    // Gate on the *absolute* peak: without this, the auto-scaler happily
    // amplifies a silent stream's dither into a full-size phantom ripple.
    const gate = clamp01((peak - 2.5) / 6);
    for (let i = 0; i < BINS; i++) {
      const v = (this.time[(i * step) | 0] - 128) * this._waveScale * gate;
      o.wave[i] = Math.max(0, Math.min(255, 128 + v));
    }

    // --- bands, taken from the normalised spectrum so they're comparable --
    const bass = this._bandMean(0, BASS_END);
    const mid = this._bandMean(BASS_END, MID_END);
    const treble = this._bandMean(MID_END, BINS);
    const level = this._bandMean(0, BINS);

    // Asymmetric smoothing: snap up fast, fall away slowly. Feels like music.
    const ease = (key, target2, up, down) => {
      const cur = this._smooth[key];
      const k = target2 > cur ? up : down;
      this._smooth[key] = cur + (target2 - cur) * Math.min(1, dt * k);
      return this._smooth[key];
    };

    o.bass = ease('bass', bass, 24, 6.0);
    o.mid = ease('mid', mid, 20, 7.0);
    o.treble = ease('treble', treble, 30, 11.0);
    o.level = ease('level', level, 18, 5.0);

    this._detectOnset(dt);
    return o;
  }

  // Spectral flux onset detection: sum of positive frame-to-frame change
  // across the whole spectrum. Unlike a bass-energy trigger this fires on
  // snares, hats, plucks and vocal attacks too — not just the kick.
  _detectOnset(dt) {
    const norm = this._norm;
    const prev = this._prevNorm;
    let flux = 0;
    for (let i = 0; i < BINS; i++) {
      const d = norm[i] - prev[i];
      if (d > 0) flux += d;
      prev[i] = norm[i];
    }
    flux /= BINS;

    const h = this._fluxHist;
    let sum = 0;
    for (let i = 0; i < h.length; i++) sum += h[i];
    const avg = sum / h.length;

    let variance = 0;
    for (let i = 0; i < h.length; i++) variance += (h[i] - avg) ** 2;
    variance /= h.length;

    const thresh = avg * 1.45 + Math.sqrt(variance) * 1.1 + 0.004;

    this._beatCooldown -= dt;
    if (flux > thresh && this._beatCooldown <= 0) {
      this.out.beat = 1;
      this._beatCooldown = 0.11;
    } else {
      this.out.beat = Math.max(0, this.out.beat - dt * 4.2);
    }

    h[this._fluxIdx] = flux;
    this._fluxIdx = (this._fluxIdx + 1) % h.length;
  }

  // Synthetic signal so the thing still looks alive with no audio source.
  _demo(dt) {
    const o = this.out;
    this._demoPhase += dt;
    const t = this._demoPhase;
    const beatT = (t * 2.0) % 1.0;                 // 120 BPM
    const kick = Math.pow(1 - beatT, 6);
    const hat = Math.pow(1 - ((t * 4.0) % 1.0), 14);

    o.bass = 0.30 + kick * 0.70;
    o.mid = 0.34 + 0.26 * (0.5 + 0.5 * Math.sin(t * 1.7));
    o.treble = 0.30 + hat * 0.55;
    o.level = 0.34 + kick * 0.30;
    o.beat = Math.max(kick, hat * 0.7);

    for (let i = 0; i < BINS; i++) {
      const x = i / BINS;
      const env = 0.45 + 0.55 * Math.pow(1 - x, 0.8);
      const wob = 0.5 + 0.5 * Math.sin(t * (2 + x * 9) + x * 22);
      const spark = x > 0.6 ? hat * 0.8 : 0;
      o.spectrum[i] = Math.min(255, (env * (0.35 + 0.65 * wob) * (0.55 + kick) + spark) * 255);
      o.wave[i] = 128 + Math.sin(x * Math.PI * 6 + t * 5) * 62 * (0.45 + kick * 0.55);
    }
    return o;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
}
