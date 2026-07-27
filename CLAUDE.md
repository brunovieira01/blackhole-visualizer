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

### Testing the media controls

You need a live SMTC session, and you don't want to make noise on someone's machine.
Play a **silent WAV** in a throwaway Electron window with `navigator.mediaSession`
metadata and `setActionHandler` callbacks that log: Chromium registers a media session
for any playing unmuted audio track without inspecting the samples, so you get a real
session that is completely silent. Fire a command, then check the callback log — that
proves the whole chain, not just that the call returned.

To test the on-screen buttons, launch with `--remote-debugging-port=9222` and drive
`Input.dispatchMouseEvent` over the DevTools protocol (Node has a global `WebSocket`).
Use real coordinates from `getBoundingClientRect` so the click goes through CSS
hit-testing — `element.click()` would pass even if `pointer-events` were wrong.
`SendKeys` is unreliable here: Windows blocks a background process from stealing
foreground, so the keystrokes land in whatever app is actually in front.

## Architecture

| File | Role |
|---|---|
| `main.js` | Modes, tray menu, config persistence, loopback plumbing, autostart |
| `preload.js` | contextBridge IPC surface (`window.bhv`) |
| `native/wallpaper.js` | `SetParent` into Explorer's WorkerW via koffi |
| `src/shaders.js` | All GLSL (scene, brightpass, blur, composite) |
| `src/renderer.js` | WebGL2 pipeline, render targets, uniforms |
| `src/audio.js` | Capture chain, per-bin normalisation, onset detection |
| `src/app.js` | Bootstrap, adaptive quality, now-playing panel, keyboard/pointer |
| `src/themes.js` | Colour presets (also mirrored as labels in `main.js`) |
| `tools/nowplaying.ps1` | SMTC + WASAPI watcher, spawned as a child of main |
| `tools/make-icon.js` | Generates `assets/icon.png` + `icon.ico` (pure Node) |
| `tools/test-analysis.mjs` | `npm test` — spectrum balance, run headless |

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
- **The disk warp amplitude is small on purpose.** Nearly edge-on, a ray skims the disk
  and crosses the corrugated sheet many times; raising the displacement smears it into a
  fluffy blob and swallows the lensed arc. `diskHeight`'s `env` also holds the inner disk
  rigid — that's where the photon ring and arc live. The wave is meant to read from the
  slope shading in `diskSample`, not from the silhouette.
- **`nowplaying.ps1` needs Windows PowerShell 5.1**, not PowerShell 7 — it's the shell
  that projects the WinRT `Windows.Media.Control` types without extra tooling. `main.js`
  spawns `powershell.exe` explicitly for that reason; do not "modernise" it to `pwsh`.
- **Never use `[Console]::In` for the command channel.** That reader is a
  `SyncTextReader`, whose `ReadLineAsync()` is not asynchronous at all — it calls the
  blocking `ReadLine()` and returns an already-completed task. Polling `.IsCompleted` on
  it either blocks the whole loop forever (stdin open but idle) or reports instant EOF
  (no stdin), and in both cases the watcher goes silent with no error. Use
  `[Console]::OpenStandardInput()` wrapped in a plain `StreamReader`.
- Orphan detection is the `-ParentPid` check, *not* stdin EOF — EOF just means nobody is
  sending commands (e.g. when run by hand for debugging), which must stay supported.
- **Motion policy — the important one.** Two categories, kept strictly apart:
  *ambient* motion (camera orbit, tilt breath, star parallax, nebula churn) is slow,
  continuous and **never** derived from audio; *reactive* motion lives only in the disk.
  Nothing in the composite pass reacts at all. Camera dolly, beat shake, bloom pumping,
  beat-driven chromatic aberration, a pulsing photon ring and treble-driven star twinkle
  were all removed — audio-synced whole-frame movement is what made this nauseating.
  Before adding anything that displaces or flashes the full image in time with the music,
  don't.
- **`diskHeight` uses vibration modes, not the waveform.** Wrapping the raw waveform
  around the disk was the original approach and it's a trap: audio waveforms are high
  spatial frequency, so it corrugates rather than undulating, which caps the usable
  amplitude at something too small to read. Low-order azimuthal modes (2/3 bass, 5/7 mid,
  11/15 treble, each with its own radial window) give coherent lobes that carry several
  times the displacement while staying legible. If asked for "more movement", raise the
  mode amplitudes — do not raise the waveform term.
- Raising the warp means more sheet crossings per ray, so disk *density* gains have to
  come down with it or loud passages saturate to flat white. `diskDist`'s `reach` guard
  must also bound the largest height `diskHeight` can return, or rays skip the crests.
- Config defaults are versioned (`CONFIG_VERSION` + `migrateConfig`). The file is only
  written on a tray interaction, so a user may have no config at all — but once written,
  it freezes every value, and changing a default later needs a migration to reach them.
- The audio-session COM interfaces in that script rely on **vtable slot order**. The
  unused leading methods are declared purely to occupy their slots — deleting one
  silently shifts every call after it. `GetProcessId` returning sane pids is the canary.
- Don't trust `IsSystemSoundsSession()`; it returned S_OK for a normal process here.
  Skip the system-sounds session by `pid == 0` instead.
- **Any `.ps1` here must stay pure ASCII** — see the setup.ps1 note above; the same
  CP1252 curly-quote trap applies.
- `npm test` runs headless and needs no audio device: it stubs `AnalyserNode` and feeds
  the real `AudioEngine` a synthetic spectrum. Run it after touching `src/audio.js` —
  frequency balance is not something you can eyeball from a screenshot.

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
