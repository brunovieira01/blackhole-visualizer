# CLAUDE.md — Black Hole Visualizer

Electron app: a ray-marched black hole that reacts to system audio, running as a live
Windows desktop wallpaper. Windows-only. No build step, no bundler.

## Run it

```powershell
cd "C:\Users\Bruno\Documents\Google Drive\07. Coding\BlackHoleVisualizer"
npm run window                                 # windowed + HUD (best for dev)
npm run wallpaper                              # desktop wallpaper mode
npx electron . --demo-audio                    # synthetic beat, skips audio capture
npx electron . --mode=window --shot=out.png    # render one frame to PNG, then exit
```

`--shot` is the fastest way to check a visual change without a human looking at the
screen: it waits 4s for the audio and shaders to settle, calls `capturePage()`, writes
the PNG, and quits. Pair it with `--demo-audio` to exercise the reactive elements
(spectrum ring, waveform, beat kick) deterministically instead of waiting for silence.

To verify **wallpaper** mode without disturbing the desktop, render the WorkerW host
window offscreen with `PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)` — the host HWND is
printed to stdout on attach.

## Architecture

| File | Role |
|---|---|
| `main.js` | Modes, tray menu, config persistence, loopback plumbing, autostart |
| `preload.js` | contextBridge IPC surface (`window.bhv`) |
| `native/wallpaper.js` | `SetParent` into Explorer's WorkerW via koffi |
| `src/shaders.js` | All GLSL (scene, brightpass, blur, composite) |
| `src/renderer.js` | WebGL2 pipeline, render targets, uniforms |
| `src/audio.js` | Capture chain, log spectrum, band split, beat detection |
| `src/app.js` | Bootstrap, adaptive quality, keyboard/pointer |
| `src/themes.js` | Colour presets (also mirrored as labels in `main.js`) |
| `tools/make-icon.js` | Generates `assets/icon.png` + `icon.ico` (pure Node) |

Mode changes **recreate** the BrowserWindow (`createWindow`) rather than mutating it —
window flags like `transparent` and `focusable` can't be changed after creation.

## Things that will bite you

- **Theme labels are duplicated.** `src/themes.js` holds the colours; `main.js` has a
  `THEMES` map of ids → labels for the tray. Adding a theme means editing both.
- **Work-area clamping.** Windows clamps a new top-level window to the monitor work
  area, so a 1440px screen yields a 1392px window. `SetWindowPos` alone doesn't fix it —
  Chromium keeps painting at its old size and you get a strip of the real wallpaper at
  the bottom. `applyWallpaperGeometry()` calls `win.setBounds()` *after* reparenting
  (the clamp no longer applies to a child window) and then repositions natively.
- **Never connect the analyser to `ctx.destination`** in `audio.js` — it echoes the
  desktop audio back out of the speakers.
- **`getDisplayMedia` needs `video: true`** even though we only want audio; the video
  track is stopped and removed immediately in `AudioEngine._attach`.
- **koffi is an optional dependency.** `native/wallpaper.js` must keep degrading
  gracefully when it's missing — `main.js` falls back to a bottom-of-z-order window.
- **HDR values are intentional.** Theme `hot` colours exceed 1.0 so the bright pass has
  something to bloom. If you change exposure, retune `uThreshold` in `renderer.js`
  alongside the disk's final scale in `diskSample`.
- Shader uniform locations are cached by name at link time in `program()`; a uniform the
  compiler optimises away is simply absent from `loc`, and `gl.uniform*` with `undefined`
  is a silent no-op. Check there for "my uniform does nothing" bugs.

## Sync to Google Drive

Repo lives under the Drive folder, so rclone already covers it. Never sync the Drive
root. If pushing explicitly:

```powershell
rclone copy "C:\Users\Bruno\Documents\Google Drive\07. Coding\BlackHoleVisualizer" `
  "gdrive:07. Coding/BlackHoleVisualizer" `
  --exclude "node_modules/**" --exclude ".git/**" --transfers 8
```

## GitHub

`https://github.com/brunovieira01/blackhole-visualizer` — branch `master`.
