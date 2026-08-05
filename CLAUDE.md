# CLAUDE.md — Black Hole Visualizer

Electron app: a ray-marched black hole that reacts to system audio, running as a live
Windows desktop wallpaper. Windows-only. No build step, no bundler.

## Run it

```powershell
cd <repo root>                                 # wherever you cloned it
npm run window                                 # windowed + HUD (best for dev)
npm run wallpaper                              # desktop wallpaper mode
npx electron . --demo-audio                    # synthetic beat, skips audio capture
npx electron . --mode=window --shot=out.png    # render one frame to PNG, then exit
```

`--shot` is the fastest way to check a visual change without a human looking at the
screen: it waits 4s for the audio and shaders to settle, calls `capturePage()`, writes
the PNG, and quits. Pair it with `--demo-audio` to exercise the reactive elements
(spectrum ring, waveform, beat kick) deterministically instead of waiting for silence.

To verify **wallpaper** mode without disturbing the desktop, run
`node tools/shot-wallpaper.js out.png`. It walks the desktop's windows, renders each with
`PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)` and keeps whichever actually painted, so it
captures the live wallpaper even when it is completely covered — and it neither steals
focus nor moves the cursor, which matters when the person whose desktop it is happens to
be using it. Prefer it to a screen grab.

### Testing the media controls

`npx electron tools/fake-track.js` gives you a live SMTC session that makes no noise:
Chromium registers a media session for any playing unmuted audio track without inspecting
the samples, so a looping silent WAV plus `navigator.mediaSession` metadata is a real
session. It defaults to Daft Punk / *Instant Crush* / 337 s, which LRCLIB has 83 synced
lines for, so it exercises the lyrics path too. It logs every transport command it
receives — fire one, then check the log; that proves the whole chain, not just that the
call returned.

To test the on-screen buttons **in wallpaper mode**, drive the real cursor: `SetCursorPos`
to the button and `mouse_event` a left click. That is the only honest test there, because
the whole point is that no DOM event is involved — main polls the global cursor and
`app.js` hit-tests the buttons itself against `getBoundingClientRect()`. A click on empty
desktop is harmless, so this is safe to run on a live session.

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
| `native/desktop.js` | Desktop icon show/hide + global pointer sampling (koffi) |
| `lib/desktop-items.js` | Reads the Desktop, resolves shortcut target icons |
| `lib/lyrics.js` | LRCLIB client + LRC parser (no Electron deps except none) |
| `src/shaders.js` | All GLSL (scene, brightpass, blur, composite) |
| `src/renderer.js` | WebGL2 pipeline, render targets, uniforms |
| `src/audio.js` | Capture chain, per-bin normalisation, onset detection |
| `src/orbit.js` | Orbit launcher: arc-length layout, hit-testing, both input paths |
| `src/app.js` | Bootstrap, adaptive quality, now-playing panel, lyrics, keyboard/pointer |
| `src/themes.js` | Colour presets (also mirrored as labels in `main.js`) |
| `tools/nowplaying.ps1` | SMTC + WASAPI watcher, spawned as a child of main |
| `tools/fake-track.js` | A silent but real SMTC session; logs the commands it receives |
| `tools/probe-desktop.js` | Read-only diagnostics for the shell's desktop layer |
| `tools/make-icon.js` | Generates `assets/icon.png` + `icon.ico` (pure Node) |
| `tools/test-analysis.mjs` | `npm test` — spectrum balance, run headless |
| `tools/test-capture.mjs` | `npm test` — the capture chain's microphone contract |
| `tools/test-lyrics.mjs` | `npm run test:lyrics` — LRC parsing + one live lookup |

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
- **Never open an input device unless `allowMicInput` is on.** WASAPI loopback is a
  render-endpoint capture and costs nothing privacy-wise; anything reached through
  `getUserMedia` is microphone use as far as Windows is concerned, Stereo Mix included.
  This regressed once: `_stereoMix()` called `getUserMedia({audio: true})` — the default
  mic — purely to unlock device labels, and `_scheduleRestart` re-ran it on every
  `devicechange`, so joining a meeting or plugging in a headset silently grabbed the mic
  and put the app in contention with the meeting client. `main.js` used to blanket-grant
  `'media'`, which hid it completely. `tools/test-capture.mjs` locks the contract down;
  if you touch the capture chain, run it.
- **`getDisplayMedia` needs `video: true`** even though we only want audio; the video
  track is stopped and removed immediately in `AudioEngine._attach`.
- **A wallpaper window can never receive mouse input.** Explorer's `SHELLDLL_DefView`
  sits above it and eats every desktop click; no window style fixes this. Input is
  *forwarded* instead — `native/desktop.js` samples `GetCursorPos` /`GetAsyncKeyState` /
  `WindowFromPoint` on a 16 ms timer and main sends `desktop-pointer` / `desktop-click`.
  Nothing is hooked and nothing is injected; keep it that way. Consequences that look
  like bugs but aren't: the orbit **pauses** whenever the cursor is on the desktop (you
  can't click a moving target), and synthetic **right-click is ignored** (Explorer still
  shows its own menu, and two menus is worse than none).
- **Hiding the desktop icons outlives the process.** `applyDesktopIcons` persists
  `orbitIconsHidden` to config precisely because a kill -9 leaves the desktop empty with
  nothing in memory that remembers why; `recoverDesktopIcons()` adopts that at boot so
  the normal path restores them. `restoreDesktopIcons()` runs from both `will-quit` and
  `uncaughtException`. If you add another exit path, add it there too.
- **`orbitLauncher` defaults to `false`.** A fresh clone must never empty someone's
  desktop unannounced.
- **`app.getFileIcon()` on a `.lnk`** usually returns the generic shortcut glyph, not the
  target's icon. `lib/desktop-items.js` resolves the link with `shell.readShortcutLink`
  and asks for the *target's* icon, falling back to the `.lnk`. Every icon lookup has a
  2.5 s deadline: a shortcut pointing at a dead network share blocks both `existsSync`
  and the shell lookup for seconds, and one of those must not stall the whole launcher.
- **`get-orbit-items` awaits the in-flight load.** Icon resolution is slow enough that a
  starting renderer reliably beats it; without the await the orbit comes up empty and
  stays that way until the desktop next changes. Broadcasting alone doesn't fix it — the
  broadcast can land before the renderer has registered its listener.
- **Tint the launcher icons with filters, not a mask.** Masking uses the alpha channel
  and plenty of shell icons are opaque squares, which would become featureless blocks.
  `grayscale + sepia` lays down a known hue for `hue-rotate` to aim at `--accent-hue`
  while the luminance detail that makes an icon recognisable survives.
- **The audio COM interfaces are vtables.** `IAudioEndpointVolume` declares every method
  up to `GetMute` even though most are unused — deleting one silently shifts every call
  after it, same trap as the session interfaces above.
- **Space the orbit by arc length, not by angle.** The ellipse is deliberately flat, so
  equal angles bunch bodies at the left and right extremes — exactly where the labels are
  widest. `phase` is a fraction of a lap, not an angle, so speed is constant too.
- **`_hit` must track `.body-disc`.** The hit radius (30 px) is the CSS disc radius; it is
  scaled by `s` only, never by `this.scale`, which grows the *ring* and not the bodies.
- **Most players publish the SMTC timeline once per track and never again.** Chrome sets
  `Position` at the start of a song and leaves `LastUpdatedTime` frozen there for its
  whole length, so the only way to know where playback actually is is
  `Position + (now - LastUpdatedTime)`. That age must be bounded by the *track duration*,
  never by a fixed few seconds: a 30-second cap here looked like sane defensiveness and
  in fact discarded the correction for every song past its first half-minute, reporting a
  frozen `0.01` forever. Symptom was the lyrics starting from the top of the track
  whenever the app was launched mid-song, because the renderer seeds its clock from that
  one reading and nothing ever corrects it. Pauses are subtracted from the age
  (`$script:pausedFor`) or resuming jumps forward by the length of the pause.
  `tools/probe-lyrics.js` shows the reported position advancing (or not) in real time.
- **Numbers on the wire to `nowplaying.ps1` are invariant, and it must parse them that
  way.** `[double]::TryParse` defaults to the *current* culture: on this machine (pt-BR)
  `"123.45"` parsed as **12345**, so clicking the progress bar seeked past the end of the
  track and the player answered by skipping to the next song. `Parse-Number` pins
  `InvariantCulture`; the `ipcMain.on('media')` guard only accepts `.`-decimals to match.
  Any new numeric command goes through both.
- **Lyrics timing is done in the renderer**, against the same locally-advanced clock the
  progress bar uses. Driving it from the watcher's once-a-second position would visibly
  lag. `refreshLyrics()` is keyed on track *identity*, not on the `changed` flag, so
  pausing doesn't throw the lyrics away and re-fetch on resume.
- **Don't hard-reset the playback clock on every message.** It looks like the obvious
  thing and it's wrong: the watcher reports about once a second and many players round
  the position to whole seconds, so adopting each reading whole makes the lyrics stutter
  and sit up to a second late. `syncClock()` eases out small disagreements and only
  resyncs hard on a real jump (>1.5 s, a play/pause flip, or a new duration).
- **Only synced lyrics are ever displayed.** `lib/lyrics.js` will not return a plain-text
  match at all. An unsynced upload is the whole song with no timings — on screen that's a
  static wall of words over the visuals. The duration tolerance is deliberately tight
  (5 s): a longer match is a different master, and lyrics drifting a few seconds off are
  worse than none. Both are what "the lyrics are wrong" turned out to mean.
- **`[offset:]` in an LRC is real and must be applied.** Positive shifts lines *earlier*.
  It was being silently dropped, which shifts a whole song.
- **LRCLIB intermittently answers a good query with nothing.** `lyrics.js` therefore only
  caches a negative when the search actually returned candidates and they were rejected;
  an empty or failed response is not cached, and `main.js` retries once after 4 s. Don't
  "simplify" that back into an unconditional negative cache — the symptom is a song
  silently having no lyrics for its whole duration.
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
- **Per-bin normalisation alone saturates.** A pure adaptive floor/ceiling stretch drives
  every bin to its own recent maximum, so any dense passage pins the whole spectrum at
  1.0 and all detail vanishes — it looked fine on sparse synthetic input and only showed
  up against real music. `update()` blends a tilted *absolute* level (58%) with the
  *relative* stretch (42%); `npm test` asserts both the balance and the saturation
  fraction, so don't drop either component.
- The audio ring is **one contour** (`ringRadius`) carrying spectrum and waveform
  together; the four styles are just different renderings of that curve. Don't reintroduce
  a second independent ring — that's what made it look cluttered.
- The ring is drawn in the *scene* pass, not the composite, so bloom treats it as light
  and the disk occludes it. That occlusion term is what stops it looking like a sticker.
- **Output device changes don't error.** A WASAPI loopback stream orphaned by an output
  switch keeps returning perfect digital silence forever — indistinguishable from a quiet
  room, and the track usually doesn't end or mute. `AudioEngine` handles it with a
  `devicechange` listener, track `ended`/`mute` handlers, and a 20 s all-zero watchdog as
  backstop. Don't "optimise away" the watchdog: the event alone doesn't cover every case.
- Autostart is a Startup-folder `.lnk`, and the file on disk is the source of truth.
  `syncAutoStart()` reconciles config against it at boot and re-points a stale target, so
  the tray checkbox can't drift out of sync with reality.
- Ring swing (`ringRadius`) is bounded so a full-scale peak plus the bloom skirt stays
  inside the frame; `sp.y` runs -1..1, so anything past ~0.90 starts clipping vertically.
- Background is built from **contrast, not brightness**. If asked to make the sky richer,
  raise the lumpiness (noise gamma, dust-lane depth, nebula cores) and leave the average
  level alone, or the whole frame greys out behind the disk. The violet nebula complex is
  a worked example: its filament term has a *low* floor (0.14) precisely so the gaps go
  near-black — raising the floor turns it straight back into a flat wash.
- **`src/shaders.js` is a JS template literal.** A backtick in a GLSL comment ends the
  string and you get `Uncaught SyntaxError` from *JavaScript*, with a black window and no
  shader error to go on. Don't quote identifiers with backticks in there. This has bitten
  twice, so `tools/test-shaders.mjs` now imports the module in `npm test` — the failure
  surfaces there with a line number instead of as a black screen.
- **The disk's structure is sampled in (angle, radius), not in the plane**, and is far
  finer radially than azimuthally. That anisotropy is what makes it read as an accretion
  disk rather than a cloud: orbiting gas shears into concentric striations. The angular
  axis is the unit vector, never `atan()` — `atan` wraps at ±π and any noise sampled on
  it leaves a seam down one side of the disk.
- **The white-hot term in `diskSample` is broad on purpose.** In the real thing the inner
  disk is glaring white and only the outer third carries visible colour; leaving it
  orange all the way in is what made this read as illustration rather than photograph.
- **Deep-sky objects are hand-placed, not scattered by noise.** The Helix, the Butterfly,
  the jet galaxy and the Endurance sit at fixed directions so each is always in the same
  part of the sky. They cost almost nothing because `skyFrame()` rejects on a dot product
  before any noise is evaluated. Keep them dim: same as stars, an overdriven one tonemaps
  to white through ACES and the hue you just wrote is thrown away.
- **Aiming at one by hand is guesswork** — pointing straight at it puts it behind the
  hole, and an azimuth offset moves it diagonally once the pitch is steep. Use
  `node tools/aim.js <x> <y> <z> [screenX] [screenY]` to get the `--look=` angles, then
  `npx electron . --mode=window --look=<orbit>,<tilt> --shot=out.png`. Expect the object
  to land slightly further from the centre than asked: the solver is a straight line and
  the real ray is lensed outward.
- **Nothing in the sky is a fixed colour.** The galactic arm and the big nebula take their
  hue from `nebulaHue()`, which pulls a vivid version of the theme's `uNebula` (the preset
  values are dim and desaturated because they're used as a wash elsewhere). Hardcoding a
  colour there looks right on one theme and clashes on the other five.
- **Star colour is a blackbody ramp, and the distribution is pushed away from its middle
  on purpose.** A uniform sample lands most stars in the white classes where they all look
  identical; the point of colouring them is to see reds and blues. Keep them moderately
  bright too — ACES desaturates highlights, so an overdriven star tonemaps to white and
  the colour you just added is thrown away. Let the bloom carry the hue.
- **`starLayer`'s `sharp` must rise as `scale` falls.** The gaussian falloff is in *cell*
  units, so a sparse layer with big cells paints fuzzy blobs at the same value that gives
  crisp points in a dense one.
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

Only relevant if your clone happens to live inside an rclone-synced folder; skip this
otherwise. Never sync the Drive root — it's far larger than this repo. Push just this
folder, and exclude the two directories that dwarf everything else:

```powershell
rclone copy "<repo root>" "gdrive:<remote path>" `
  --exclude "node_modules/**" --exclude ".git/**" --transfers 8
```

## GitHub

`https://github.com/brunovieira01/blackhole-visualizer` — branch `master`.
