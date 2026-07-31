// Guards the capture chain's privacy contract:
//
//   the visualiser must never open an input device unless the user opted in.
//
// This regressed once already. The Stereo Mix probe called
// getUserMedia({audio:true}) purely to unlock device labels, which opens the
// *default microphone* — and it ran on every re-acquire, including the
// devicechange that fires when you join a meeting or plug in a headset.
//
//   node tools/test-capture.mjs

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

// --- a fake navigator.mediaDevices that records everything it's asked for ---
function stubMediaDevices({ loopbackWorks = false, devices = [] } = {}) {
  const calls = { getUserMedia: [], getDisplayMedia: 0, enumerateDevices: 0 };

  const fakeStream = (label) => ({
    _label: label,
    getAudioTracks: () => [{ kind: 'audio', stop() {}, addEventListener() {} }],
    getVideoTracks: () => [],
    getTracks: () => [{ kind: 'audio', stop() {}, addEventListener() {} }],
    removeTrack() {},
    addEventListener() {},
  });

  // Node 24 defines `navigator` itself, as a getter-only property.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
    mediaDevices: {
      addEventListener() {},
      removeEventListener() {},
      async getDisplayMedia() {
        calls.getDisplayMedia++;
        if (!loopbackWorks) throw new Error('loopback unavailable (simulated)');
        return fakeStream('loopback');
      },
      async getUserMedia(constraints) {
        calls.getUserMedia.push(constraints);
        return fakeStream('input-device');
      },
      async enumerateDevices() {
        calls.enumerateDevices++;
        return devices;
      },
    },
    },
  });
  return calls;
}

// The engine only touches AudioContext once a stream is attached; a stub keeps
// _open() reachable without a browser.
class FakeAnalyser {
  constructor() { this.frequencyBinCount = 1024; this.fftSize = 2048; }
  getByteFrequencyData() {}
  getByteTimeDomainData() {}
}
globalThis.AudioContext = class {
  constructor() { this.sampleRate = 48000; this.state = 'running'; }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return new FakeAnalyser(); }
  close() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
};

const { AudioEngine } = await import('../src/audio.js');

const MIC_LABELS = [
  { kind: 'audioinput', deviceId: 'a', label: 'Microphone (Realtek Audio)' },
  { kind: 'audioinput', deviceId: 'b', label: 'Headset Stereo Microphone' },
];
const WITH_STEREO_MIX = [
  ...MIC_LABELS,
  { kind: 'audioinput', deviceId: 'c', label: 'Stereo Mix (Realtek Audio)' },
];

console.log('\ncapture chain — microphone safety\n');

// ---------------------------------------------------------------------------
{
  const calls = stubMediaDevices({ loopbackWorks: true });
  const e = new AudioEngine();
  const mode = await e.start({ allowMicInput: false });
  check('loopback is used when available', () => assert.equal(mode, 'loopback'));
  check('loopback path never calls getUserMedia', () =>
    assert.deepEqual(calls.getUserMedia, []));
}

// ---------------------------------------------------------------------------
{
  const calls = stubMediaDevices({ loopbackWorks: false, devices: WITH_STEREO_MIX });
  const e = new AudioEngine();
  const mode = await e.start({ allowMicInput: false });
  check('falls back to demo, not the mic, when loopback fails', () =>
    assert.equal(mode, 'demo'));
  check('no input device is opened without opt-in', () =>
    assert.deepEqual(calls.getUserMedia, []));
  check('devices are not even enumerated without opt-in', () =>
    assert.equal(calls.enumerateDevices, 0));
}

// ---------------------------------------------------------------------------
{
  const calls = stubMediaDevices({ loopbackWorks: false, devices: WITH_STEREO_MIX });
  const e = new AudioEngine();
  const mode = await e.start({ allowMicInput: true });
  check('opt-in reaches Stereo Mix', () => assert.equal(mode, 'stereo-mix'));
  check('Stereo Mix is requested by explicit deviceId', () => {
    assert.equal(calls.getUserMedia.length, 1);
    assert.equal(calls.getUserMedia[0].audio.deviceId.exact, 'c');
  });
  check('no bare getUserMedia({audio:true}) label probe', () =>
    assert.ok(!calls.getUserMedia.some((c) => c.audio === true),
      'a bare {audio:true} request opens the default microphone'));
}

// ---------------------------------------------------------------------------
{
  const calls = stubMediaDevices({ loopbackWorks: false, devices: MIC_LABELS });
  const e = new AudioEngine();
  const mode = await e.start({ allowMicInput: true });
  check('"Stereo Microphone" is not mistaken for a loopback device', () => {
    const byId = calls.getUserMedia.filter((c) => c.audio?.deviceId);
    assert.deepEqual(byId, [], 'matched a real microphone as a loopback mix');
  });
  check('opt-in still allows the plain microphone fallback last', () =>
    assert.equal(mode, 'microphone'));
}

// ---------------------------------------------------------------------------
{
  // Labels are blank until a capture permission has been granted. The old code
  // called getUserMedia({audio:true}) here to unlock them.
  const blank = [{ kind: 'audioinput', deviceId: 'a', label: '' }];
  const calls = stubMediaDevices({ loopbackWorks: false, devices: blank });
  const e = new AudioEngine();
  await e.start({ allowMicInput: true });
  check('blank device labels are not probed with a mic grab', () =>
    assert.ok(!calls.getUserMedia.some((c) => c.audio === true),
      'probed the default microphone to reveal device labels'));
}

// ---------------------------------------------------------------------------
{
  // The regression that started this: devicechange fired on every headset
  // plug and meeting join, and each one re-ran the chain.
  const calls = stubMediaDevices({ loopbackWorks: false, devices: WITH_STEREO_MIX });
  const e = new AudioEngine();
  await e.start({ allowMicInput: false });
  for (let i = 0; i < 5; i++) await e._open();
  check('repeated re-acquires never touch an input device', () =>
    assert.deepEqual(calls.getUserMedia, []));
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`} ` +
  `(${passed} passed)\n`);
process.exit(failed === 0 ? 0 : 1);
