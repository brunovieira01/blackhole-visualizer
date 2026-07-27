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

## Where the audio comes from

The renderer asks for `getDisplayMedia`, and the main process answers with
`audio: 'loopback'` — Electron's hook into **WASAPI loopback**. That's the system audio
mix, straight from Windows. No Stereo Mix, no VB-Cable, no virtual audio device, and
nothing is routed back out through your speakers.

If loopback is unavailable it falls back, in order, to a Stereo-Mix-style input device,
then any microphone, then a synthetic beat so the visuals never sit there dead. The tray
menu shows which one is live.

An auto-gain stage tracks a decaying loudness ceiling, so quiet tracks still fill the
screen and loud ones don't clip everything to white.

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

Then the audio goes in:

| Signal | Drives |
|---|---|
| Log-spaced spectrum | Ripples the disk **radially** — bass at the inner rim, highs at the outer edge |
| Bass | Disk brightness, camera dolly, ring radius |
| Mids | Turbulence in the disk filaments |
| Treble | Star twinkle, photon-ring sharpness |
| Beat onsets | Camera kick, chromatic aberration, a pulse through the disk |

Post: HDR half-float targets → bright pass → two ping-pong gaussian blurs → ACES
tonemap, circular spectrum bars, waveform ring, vignette, and grain.

It's a single fullscreen triangle and about 300 lines of GLSL. No three.js, no build
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
| `R` / `W` | Spectrum ring / waveform circle |
| `↑` `↓` | Reactivity |
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
src/audio.js            Loopback capture, log spectrum, bands, beat detection
src/app.js              Bootstrap, adaptive quality, input
tools/make-icon.js      Draws assets/icon.png + icon.ico from scratch
```

Settings are stored in `%APPDATA%\blackhole-visualizer\config.json`.

### Development

```powershell
npm start                    # last used mode
npm run window               # windowed, with the HUD
npm run wallpaper            # desktop wallpaper mode
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
