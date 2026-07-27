# Black Hole Visualizer

A relativistically ray-traced black hole that reacts, in real time, to whatever your
computer is playing — Spotify, YouTube, a game, anything that comes out of the speakers.

It can run as your **actual desktop wallpaper**: reparented into Explorer's wallpaper
layer, so your icons stay on top and keep working, clicks fall through to the desktop,
and it never shows up in Alt+Tab or the taskbar.

![The visualizer running as the desktop wallpaper](assets/preview.jpg)

---

## Quick start

```powershell
git clone https://github.com/brunovieira01/blackhole-visualizer.git
cd blackhole-visualizer
powershell -ExecutionPolicy Bypass -File setup.ps1
```

That installs the dependencies, builds the icons, and drops a **Black Hole Visualizer**
shortcut on your Desktop. Double-click it and the black hole becomes your wallpaper.
Add `-Startup` to the setup command if you want it to come back on every login.

Everything else lives in the **tray icon** next to the clock. No window to keep open,
nothing to babysit.

Prefer not to use the setup script? `npm install`, then double-click
`Start Black Hole.vbs` — it launches with no console window at all.

---

## The three modes

| Mode | What it does |
|---|---|
| **Desktop wallpaper** *(default)* | Becomes the literal wallpaper. Desktop icons stay on top and stay clickable, Win+D reveals it instead of hiding it, no taskbar entry. |
| **Overlay** | Fullscreen, always on top, click-through. Alpha follows luminance, so only the glow is drawn and the rest of your screen shows through. |
| **Window** | An ordinary window. Drag to orbit the camera, and you get a HUD with the current state. |

Switch between them from the tray menu. `Ctrl` + `Alt` + `B` toggles it on and off from
anywhere.

![Window mode with the HUD](assets/preview-window.jpg)

---

## Now playing

The panel in the top-left names whatever is making sound, in the visualiser's own type.
It reads the same media session that backs the Windows volume flyout
(`Windows.Media.Control`), so it gets **title, artist and app** from Spotify, YouTube in
a browser, VLC, Groove and most media apps — no accounts, no API keys, nothing to log
into.

When something is playing that has no media metadata at all — a game, a call, a random
video player — it falls back to enumerating the **WASAPI render sessions** and naming the
process actually pushing audio, so you still get "Valorant" or "Discord" instead of a
blank.

Five small bars beside the title ride the live spectrum, and there's a progress bar with
elapsed / total time. Turn the whole thing off with `N` or from the tray.

### Controls

Play/pause, previous and next are wired straight through to the same media session, so
they drive Spotify, YouTube, VLC — whatever currently holds it. Clicking the progress bar
seeks, where the app supports it.

**How you reach them depends on the mode**, and this is a hard constraint rather than a
choice: as the wallpaper the visualiser lives *below* Explorer's desktop icon layer,
which swallows every click on the desktop. Nothing drawn there can ever be clicked.

| | Wallpaper | Overlay | Window |
|---|---|---|---|
| On-screen buttons | hidden (can't be clicked) | yes | yes |
| Tray menu | yes | yes | yes |
| Global hotkeys | yes | yes | yes |

Global hotkeys, which work from anywhere regardless of mode:

| | |
|---|---|
| `Ctrl` `Alt` `Space` | Play / pause |
| `Ctrl` `Alt` `→` | Next track |
| `Ctrl` `Alt` `←` | Previous track |

In overlay mode the panel becomes clickable only while the pointer is actually over it —
the rest of the screen stays click-through.

---

## Motion

There are two kinds of movement here, and keeping them apart is the whole design.

**Ambient drift** is slow, continuous and completely independent of the audio: the camera
creeps around the hole (about six minutes for a lap), the tilt breathes, the two star
layers parallax against each other, and the nebula churns. None of it is synced to
anything, so it reads as drifting through space.

**Audio reactivity** is confined to the disk. Nothing in the composite pass reacts at all.

Every audio-driven term that moved the *whole frame* — a camera dolly on bass, a per-beat
shake, chromatic aberration and bloom gain pumped by the music, a throbbing photon ring,
a starfield that flickered on hi-hats — is gone. That combination is what made it
nauseating; a fixed frame with a moving disk is not. Ambient drift is a *Slow / Barely
there / Wandering / Off* dial in the tray.

---

## Where the audio comes from

The renderer asks for `getDisplayMedia`, and the main process answers with
`audio: 'loopback'` — Electron's hook into **WASAPI loopback**. That's the system audio
mix, straight from Windows. No Stereo Mix, no VB-Cable, no virtual audio device, and
nothing is routed back out through your speakers.

If loopback is unavailable it falls back, in order, to a Stereo-Mix-style input device,
then any microphone, then a synthetic beat so the visuals never sit there dead. The tray
menu shows which one is live.

### Hearing the quiet things too

Music spectra fall off steeply with frequency — in raw terms a kick sits about **7x**
higher than a hi-hat — so a naive FFT readout makes any visualiser all bass and no
detail. Instead, every one of the 256 log-spaced bins carries its own adaptive floor and
ceiling and is normalised between them, with a gate on the absolute level so a silent
bin's noise floor never gets stretched into a signal.

The result, from `npm test`:

```
full mix             bass=0.761  mid=0.716  treble=0.593   <- within 1.28x
bass only            bass=0.755  mid=0.000  treble=0.000
treble only (quiet)  bass=0.000  mid=0.000  treble=0.640   <- 36 dB down, still full swing
silence              bass=0.000  mid=0.000  treble=0.000
```

Onsets are detected by **spectral flux** — the summed positive change across the whole
spectrum — rather than bass energy, so snares, hats, plucks and vocal attacks trigger the
visuals just like kicks do.

---

## What's actually being rendered

Photons around a Schwarzschild black hole follow the Binet equation for null geodesics,

$$u'' + u = \tfrac{3}{2}\, r_s\, u^2$$

which in Cartesian form (with $r_s = 1$) integrates as

```glsl
vec3 acc = -1.5 * h2 * pos / pow(dot(pos, pos), 2.5);   // h = |p × v|, conserved
vel += acc * dt;
pos += vel * dt;
```

Every pixel marches its own ray through that field, which gives the real geometry for
free: the event horizon at $r = 1$, the photon sphere at $r = 1.5$, the Einstein ring,
and the disk's far side lensed up over the top and down under the bottom. Crossings of
the equatorial plane are detected by sign change and shaded as an optically-thin
accretion disk with Keplerian shear, relativistic beaming, Doppler tinting, and
gravitational redshift.

Then the audio goes in, in two layers.

### The disk

The accretion disk isn't a flat plane: its height is a function of the audio, so the
whole sheet moves. The marcher tracks the signed distance to that moving surface rather
than to `y = 0`.

The shape is a sum of **azimuthal vibration modes**, like a drum head, and that choice is
what makes it legible. Wrapping a raw audio waveform around the disk — the obvious first
idea — fails, because an audio waveform is high spatial frequency: you get fine
corrugation that reads as fuzz, and you're forced to keep the amplitude tiny to stop it
smearing the disk into a blob. A handful of low-order modes gives big coherent lobes you
can actually follow, so the amplitude can be several times larger.

Bands are separated by both mode number and radius, so instruments stay tellable apart:

| Band | Modes | Where | Reads as |
|---|---|---|---|
| Bass | 2, 3 lobes | inner disk | kick and bassline — slow heaving |
| Mid | 5, 7 lobes | mid radii | voice and melody — rolling undulation |
| Treble | 11, 15 lobes | outer edge | hats and transients — fine shimmer |

On top of that, the spectrum drives a swell travelling outward in radius (this carries the
punch of a kick), and a little raw waveform is layered in for texture. The modes drift at
different rates and phases so the pattern never freezes into a standing wave.

| Signal | Also drives |
|---|---|
| Surface slope | Sheen and crest/trough shading — what makes the wave readable edge-on |
| Bass | Brightness of the inner disk |
| Mids | Turbulence in the disk filaments |
| Level | How fast the disk turns |
| Onsets | A gentle swell through the disk |

The warp is held rigid across the inner rim, where the photon ring and the lensed arc are
drawn — rippling it costs far more in crispness than it buys in motion. Depth is a
*Wave depth* dial in the tray, from off to turbulent.

### The ring

One shape, not two. The spectrum and the waveform are a **single closed contour** whose
radius carries both — the spectrum gives the large lobes, the waveform rides on top as
fine wobble. Bass sits at 12 o'clock and sweeps round to treble at 6, mirrored across the
vertical axis so the curve closes seamlessly, and the colour runs cool at the bass end to
hot at the treble end: a literal temperature gradient around the ring.

Four ways of drawing that same curve, in the tray:

| | |
|---|---|
| **Contour** | a single glowing line with a soft bloom skirt |
| **Ribbon** | a thick band of light following the curve |
| **Comb** | short discrete bars, capped by the contour so it still reads as one object |
| **Halo** | a soft band centred on the curve, no edges anywhere |

![The four ring styles](assets/preview-styles.jpg)

It's drawn into the *scene* buffer rather than over the finished frame, which matters for
two reasons: the bloom pass picks it up, so it reads as emitted light sharing the disk's
glow instead of flat UI sitting on top; and the scene can occlude it, so the disk passes
in front and the ring genuinely sits around the black hole in space.

### The sky

A galactic arm crosses the frame at an angle to the disk, with dark dust lanes cut
through it — those lanes are what make a star cloud read as the Milky Way rather than a
bright smudge. Star density rises inside the arm, and two nebulae drift with emission-red
and reflection-blue cores. It's all built from contrast rather than brightness: the
average stays near black so the background never greys out behind the disk.

Post: HDR half-float targets → bright pass → two ping-pong gaussian blurs → ACES tonemap,
vignette, and grain.

It's a single fullscreen triangle and about 350 lines of GLSL. No three.js, no build
step, no bundler.

---

## Performance

Quality defaults to **Auto**, which measures the frame rate every second and trades
render scale and integration steps to hold ~60 fps. Fixed Low/Medium/High/Ultra presets
are in the tray menu if you'd rather pin it.

With **Idle down when silent** on (the default), the visualizer drops to ~12 fps after
six seconds of silence and snaps straight back on the next sound, so it isn't burning
your GPU on a still image all day.

---

## Keyboard (window mode)

| Key | |
|---|---|
| `1` – `6` | Theme |
| `H` | Toggle HUD |
| `N` | Toggle the now-playing panel |
| `space` | Play / pause |
| `,` `.` | Previous / next track |
| `↑` `↓` | Reactivity |
| `←` `→` | Wave depth (off → subtle → normal → strong → turbulent) |
| `F` | Fullscreen |
| drag | Orbit the camera |
| `Esc` | Hide to tray |

Themes: Gargantua, Cygnus X-1, Nova, Emerald, Ember, Monochrome.

---

## Layout

```
main.js                 Electron main: modes, tray, config, loopback plumbing
preload.js              The (small) IPC bridge
native/wallpaper.js     WorkerW reparenting via koffi — the live-wallpaper trick
src/shaders.js          GLSL: geodesic ray marcher, bloom, composite
src/renderer.js         WebGL2 pipeline and render targets
src/audio.js            Loopback capture, per-bin normalisation, onset detection
src/app.js              Bootstrap, adaptive quality, now-playing panel, input
tools/nowplaying.ps1    Media session (SMTC) + WASAPI session watcher
tools/make-icon.js      Draws assets/icon.png + icon.ico from scratch
tools/test-analysis.mjs Asserts the spectrum stays balanced (npm test)
```

Settings are stored in `%APPDATA%\blackhole-visualizer\config.json`.

### Development

```powershell
npm start                    # last used mode
npm run window               # windowed, with the HUD
npm run wallpaper            # desktop wallpaper mode
npm test                     # analyser balance checks (no audio device needed)
npx electron . --demo-audio  # synthetic beat, no capture — handy for tuning
npx electron . --mode=window --shot=out.png   # render a frame to a PNG and exit
```

---

## Notes and limitations

- **Windows only.** The wallpaper mode depends on Explorer's `Progman`/`WorkerW`
  windows, which is a Windows-specific (and undocumented) arrangement. Overlay and
  window modes are only tested on Windows too.
- Wallpaper embedding needs [`koffi`](https://koffi.dev) for the Win32 calls. It's an
  *optional* dependency — if it can't install, the app still runs and falls back to a
  bottom-of-the-z-order window, which looks the same but covers desktop icons.
- Third-party wallpaper tools (Wallpaper Engine, Lively) fight over the same WorkerW.
  Run one at a time.
- Verified on Windows 11 26200 with Electron 43.

## License

MIT
