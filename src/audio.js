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
// ---------------------------------------------------------------------------

const BINS = 256;          // log-spaced spectrum bins handed to the shader
const FMIN = 28;
const FMAX = 16000;

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

    this._smooth = { bass: 0, mid: 0, treble: 0, level: 0 };
    this._gain = 0.25;     // auto-gain: running estimate of "loud"
    this._bassHist = new Float32Array(43);
    this._bassIdx = 0;
    this._beatCooldown = 0;
    this._binMap = null;
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
    this.analyser.smoothingTimeConstant = 0.68;
    this.analyser.minDecibels = -92;
    this.analyser.maxDecibels = -12;
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
    this._bandRange = (lo, hi) => [
      Math.max(0, Math.floor((lo / nyquist) * n)),
      Math.min(n, Math.ceil((hi / nyquist) * n)),
    ];
    this._rBass = this._bandRange(25, 165);
    this._rMid = this._bandRange(165, 2200);
    this._rTreble = this._bandRange(2200, 13000);
  }

  _avg(arr, [a, b]) {
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i];
    return b > a ? s / (b - a) / 255 : 0;
  }

  update(dt) {
    const o = this.out;

    if (!this.analyser) { this._demo(dt); return o; }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    // --- log-spaced spectrum, with a gentle tilt so highs stay visible ---
    let peak = 0;
    for (let i = 0; i < BINS; i++) {
      const [a, b] = this._binMap[i];
      let m = 0;
      for (let j = a; j < b; j++) if (this.freq[j] > m) m = this.freq[j];
      let v = (m / 255) * (0.55 + 0.75 * (i / BINS)); // +tilt towards treble
      if (v > peak) peak = v;
      o.spectrum[i] = Math.min(255, v * 255 * this._gainScale());
    }

    // --- waveform (downsampled to BINS) ---
    const step = this.time.length / BINS;
    for (let i = 0; i < BINS; i++) o.wave[i] = this.time[(i * step) | 0];

    // --- bands ---
    const bass = this._avg(this.freq, this._rBass);
    const mid = this._avg(this.freq, this._rMid);
    const treble = this._avg(this.freq, this._rTreble);
    const level = bass * 0.5 + mid * 0.35 + treble * 0.15;

    // --- auto-gain: track a slowly-decaying loudness ceiling so quiet tracks
    //     still fill the screen and loud ones don't clip everything white ---
    const inst = Math.max(level, peak * 0.8);
    this._gain = inst > this._gain
      ? this._gain + (inst - this._gain) * Math.min(1, dt * 6)
      : this._gain + (inst - this._gain) * Math.min(1, dt * 0.35);
    this._gain = Math.max(this._gain, 0.035);

    const g = 1 / this._gain;
    const norm = (v) => Math.min(1.6, v * g);

    // Asymmetric smoothing: snap up fast, fall away slowly. Feels like music.
    const ease = (key, target, up, down) => {
      const cur = this._smooth[key];
      const k = target > cur ? up : down;
      this._smooth[key] = cur + (target - cur) * Math.min(1, dt * k);
      return this._smooth[key];
    };

    o.bass = ease('bass', norm(bass), 22, 5.5);
    o.mid = ease('mid', norm(mid), 18, 6.0);
    o.treble = ease('treble', norm(treble), 26, 9.0);
    o.level = ease('level', norm(level), 16, 4.0);

    this._detectBeat(bass * g, dt);
    return o;
  }

  _gainScale() {
    return Math.min(4.5, 1 / Math.max(this._gain, 0.05));
  }

  // Classic energy-based onset detection over a ~1s history of bass energy.
  _detectBeat(energy, dt) {
    const h = this._bassHist;
    let sum = 0;
    for (let i = 0; i < h.length; i++) sum += h[i];
    const avg = sum / h.length;

    let variance = 0;
    for (let i = 0; i < h.length; i++) variance += (h[i] - avg) ** 2;
    variance /= h.length;

    // Adaptive threshold: busier signals need a bigger jump to count
    const thresh = avg * (1.32 + Math.min(0.5, variance * 2.0));

    this._beatCooldown -= dt;
    if (energy > thresh && energy > 0.16 && this._beatCooldown <= 0) {
      this.out.beat = 1;
      this._beatCooldown = 0.16;
    } else {
      this.out.beat = Math.max(0, this.out.beat - dt * 3.6);
    }

    h[this._bassIdx] = energy;
    this._bassIdx = (this._bassIdx + 1) % h.length;
  }

  // Synthetic signal so the thing still looks alive with no audio source.
  _demo(dt) {
    const o = this.out;
    this._demoPhase += dt;
    const t = this._demoPhase;
    const beatT = (t * 2.0) % 1.0;                 // 120 BPM
    const kick = Math.pow(1 - beatT, 6);

    o.bass = 0.30 + kick * 0.75;
    o.mid = 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.7));
    o.treble = 0.20 + 0.25 * (0.5 + 0.5 * Math.sin(t * 4.3 + 1.0));
    o.level = 0.30 + kick * 0.35;
    o.beat = kick;

    for (let i = 0; i < BINS; i++) {
      const x = i / BINS;
      const env = Math.pow(1 - x, 1.6);
      const wob = 0.5 + 0.5 * Math.sin(t * (2 + x * 9) + x * 22);
      o.spectrum[i] = Math.min(255, (env * (0.35 + 0.65 * wob) * (0.5 + kick) * 320) | 0);
      o.wave[i] = 128 + Math.sin(x * Math.PI * 6 + t * 5) * 55 * (0.4 + kick * 0.6);
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
