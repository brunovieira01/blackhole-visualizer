// ---------------------------------------------------------------------------
//  The orbiting launcher.
//
//  Desktop shortcuts become bodies on an ellipse around the black hole. Drawn
//  as DOM rather than into the WebGL scene: labels need real text rendering and
//  hit-testing, and the icons are already bitmaps handed to us by the shell.
//
//  Two input paths, because the wallpaper layer can't receive mouse events:
//    * window / overlay  -> ordinary pointer events on the elements
//    * wallpaper         -> synthetic hover/click forwarded from the main
//                           process, which polls the global cursor
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

// Mirrors .body / .body-disc in style.css: 108px wide, a 60px disc plus two
// lines of label. Used to keep the outermost ring clear of the screen edges.
const HALF_LABEL = 54;
const BODY_HALF_H = 52;

// Perimeter samples for arc-length spacing. 256 puts the worst-case error well
// under a pixel on a 4K ring, and the table is only rebuilt on resize.
const ARC_STEPS = 256;

export class OrbitLauncher {
  constructor(root, { onLaunch, onContext } = {}) {
    this.root = root;
    this.onLaunch = onLaunch || (() => {});
    this.onContext = onContext || (() => {});

    this.items = [];
    this.bodies = [];
    this.enabled = false;
    this.speed = 1;
    this.scale = 1;

    this.phase = 0;           // fraction of a lap, not an angle
    this.reserveBottom = 0;
    this._arcs = [null, null];
    this.paused = false;      // held still while the pointer is on the desktop
    this.hover = -1;
    this.pressed = -1;
    this._synthetic = false;  // wallpaper mode: ignore real pointer events
    this._lastLaunch = 0;
  }

  setSynthetic(on) {
    this._synthetic = on;
    this.root.classList.toggle('synthetic', on);
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this._build();
  }

  setOptions({ enabled, speed, scale, tint }) {
    if (typeof enabled === 'boolean') {
      this.enabled = enabled;
      this.root.classList.toggle('on', enabled);
    }
    if (typeof speed === 'number') this.speed = speed;
    if (typeof scale === 'number') this.scale = scale;
    if (typeof tint === 'boolean') this.root.classList.toggle('tint', tint);
  }

  // Pixels along the bottom of the screen the ring must keep clear, so the
  // lyrics aren't sitting underneath a row of icons. The ellipse is squashed
  // symmetrically rather than clipped at the bottom, which keeps it an ellipse
  // — and a flatter one reads *more* like the disk's orbital plane, not less.
  setReserveBottom(px) {
    this.reserveBottom = Math.max(0, px || 0);
  }

  _build() {
    this.root.replaceChildren();
    this.bodies = this.items.map((item, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'body';
      el.title = item.name;

      const disc = document.createElement('span');
      disc.className = 'body-disc';
      if (item.icon) {
        const img = document.createElement('img');
        img.src = item.icon;
        img.alt = '';
        img.draggable = false;
        disc.appendChild(img);
      } else {
        // No shell icon (rare). Fall back to the first letter.
        disc.textContent = (item.name[0] || '?').toUpperCase();
        disc.classList.add('body-letter');
      }

      const label = document.createElement('span');
      label.className = 'body-label';
      label.textContent = item.name;

      el.append(disc, label);

      // Real pointer events only matter in window/overlay mode.
      // Freezing the ring on hover matters as much here as it does in
      // wallpaper mode: a body that keeps drifting slides out from under the
      // cursor between mousedown and mouseup.
      el.addEventListener('pointerenter', () => {
        if (this._synthetic) return;
        this.hover = i;
        this.paused = true;
      });
      el.addEventListener('pointerleave', () => {
        if (this._synthetic) return;
        if (this.hover === i) this.hover = -1;
        this.paused = false;
      });
      el.addEventListener('click', (e) => {
        if (this._synthetic) return;
        e.preventDefault();
        this.launch(i);
      });
      el.addEventListener('contextmenu', (e) => {
        if (this._synthetic) return;
        e.preventDefault();
        this.onContext(this.items[i]);
      });

      this.root.appendChild(el);
      return el;
    });
  }

  launch(i) {
    const item = this.items[i];
    if (!item) return;
    // Guard against a double-click arriving as two launches.
    const now = performance.now();
    if (now - this._lastLaunch < 600) return;
    this._lastLaunch = now;

    const el = this.bodies[i];
    if (el) {
      el.classList.remove('launching');
      void el.offsetWidth;      // restart the animation
      el.classList.add('launching');
    }
    this.onLaunch(item);
  }

  // --- synthetic input (wallpaper mode) ---------------------------------
  // p is { x, y } in CSS pixels relative to this window, or null when the
  // pointer isn't over the desktop.
  pointer(p) {
    if (!this._synthetic || !this.enabled) return;
    if (!p) {
      this.hover = -1;
      this.paused = false;
      return;
    }
    // Holding the orbit still while the cursor is on the desktop is what makes
    // this clickable at all — you can't reliably hit a moving target.
    this.paused = true;
    this.hover = this._hitTest(p.x, p.y);
  }

  click(p, button = 'left') {
    if (!this._synthetic || !this.enabled) return false;
    // Right-click is deliberately ignored here. We only observe the cursor —
    // nothing is hooked or swallowed — so Explorer still opens its own desktop
    // menu, and a second menu appearing next to it is worse than none. Left
    // click is safe: on empty desktop it does nothing Explorer cares about.
    if (button !== 'left') return false;
    const i = this._hitTest(p.x, p.y);
    if (i < 0) return false;
    this.launch(i);
    return true;
  }

  // Is a body under this point? Overlay mode uses it to ask main for mouse
  // events back only while the cursor is actually over something clickable.
  hitAt(x, y) {
    return this.enabled && this._hitTest(x, y) >= 0;
  }

  _hitTest(x, y) {
    // Walk backwards so the near-side (later-drawn, larger) bodies win.
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      const r = b._hit;
      if (!r) continue;
      const dx = x - r.cx;
      const dy = y - r.cy;
      if (dx * dx + dy * dy <= r.rr) return i;
    }
    return -1;
  }

  // --- arc-length spacing --------------------------------------------------
  //  On an ellipse this flat, equal angles are nowhere near equal distances:
  //  the bodies bunch tightly at the left and right extremes — exactly where
  //  the labels are widest — and spread thin across the top and bottom.
  //  Walking the perimeter instead keeps the gaps even the whole way round,
  //  and it makes the orbital speed constant rather than sprinting through
  //  the ends.
  //
  //  Cached per ring; the table only has to be rebuilt when the window
  //  resizes or the orbit is scaled.
  _arcTable(rx, ry, slot) {
    const cached = this._arcs[slot];
    if (cached && cached.rx === rx && cached.ry === ry) return cached;

    const cum = new Float64Array(ARC_STEPS + 1);
    let total = 0;
    let px = rx;
    let py = 0;
    for (let i = 1; i <= ARC_STEPS; i++) {
      const a = (i / ARC_STEPS) * TAU;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      total += Math.hypot(x - px, y - py);
      cum[i] = total;
      px = x;
      py = y;
    }

    const table = { rx, ry, cum, total };
    this._arcs[slot] = table;
    return table;
  }

  // fraction of the perimeter (0..1) -> the angle that lands there
  _angleAt(f, rx, ry, slot) {
    const t = this._arcTable(rx, ry, slot);
    if (!(t.total > 0)) return f * TAU;

    const target = f * t.total;
    let lo = 1;
    let hi = ARC_STEPS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const seg = t.cum[lo] - t.cum[lo - 1];
    const frac = seg > 0 ? (target - t.cum[lo - 1]) / seg : 0;
    return ((lo - 1 + frac) / ARC_STEPS) * TAU;
  }

  // --- layout ------------------------------------------------------------
  // dt in seconds. `phase` is a fraction of a lap rather than an angle, so
  // that spacing and speed are both measured along the curve: 0.0095 is a
  // full revolution in ~1m45s at speed 1 — slow enough to sit behind, fast
  // enough to read as orbiting.
  layout(dt, audio) {
    if (!this.enabled || !this.bodies.length) return;

    if (!this.paused) this.phase = (this.phase + dt * this.speed * 0.0095) % 1;

    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const cx = W / 2;
    const cy = H / 2;

    const n = this.bodies.length;
    // Two rings once a single one would get crowded, so labels stay readable.
    const rings = n > 14 ? 2 : 1;
    const beat = audio ? audio.beat : 0;
    const level = audio ? audio.level : 0;

    // The outermost ring is what has to fit, so it's sized first and the inner
    // one is derived from it. Sizing each ring independently and then clamping
    // pushes them both against the same limit, which collapses the depth
    // difference — and without a clamp the outer ring's labels fall off the
    // edges of the screen entirely.
    // The bodies are laid out in CSS pixels, so on a 1440p wallpaper a fixed
    // 60px disc reads as half the size it does in a dev window. Scale with the
    // viewport the same way the now-playing panel does — clamped at 1 below so
    // the windowed layout stays exactly as tuned.
    const vp = Math.min(1.45, Math.max(0.9, W / 1600));

    // The vertical gap between the rings has to exceed a body's height or the
    // two collide near the top and bottom of the ellipse, which is the whole
    // reason for the second ring. Shrinking the bodies a little when there are
    // two of them buys the rest of the clearance.
    const INNER = 0.63;
    const dens = (rings === 2 ? 0.86 : 1) * 0.88;

    const halfH = BODY_HALF_H * vp * dens;
    const rxOuter = Math.min(
      Math.min(W, H * 1.7) * 0.40 * this.scale,
      W / 2 - HALF_LABEL * vp * dens - 16);
    const ryOuter = Math.min(
      H * 0.36 * this.scale,
      H / 2 - halfH,
      // Keep the lowest body clear of whatever is parked along the bottom
      // (the lyrics). 0.92 mirrors the squash applied to y below.
      Math.max(60, (H / 2 - this.reserveBottom - halfH) / 0.92));

    for (let i = 0; i < n; i++) {
      const el = this.bodies[i];
      const ring = rings === 1 ? 0 : i % rings;
      const inRing = rings === 1 ? n : Math.ceil((n - ring) / rings);
      const idx = rings === 1 ? i : Math.floor(i / rings);

      // The inner ring is quicker, like a real orbit.
      const ringR = rings === 1 || ring === 1 ? 1.0 : INNER;
      const dir = ring === 0 ? 1 : 0.72;

      // An ellipse flatter than the viewport reads as an orbital plane seen
      // near edge-on, matching the disk.
      const rx = rxOuter * ringR;
      const ry = ryOuter * ringR;

      const f = idx / inRing + this.phase * dir + (ring ? 0.06 : 0);
      const a = this._angleAt(f - Math.floor(f), rx, ry, ring);

      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a) * ry * 0.92;

      // sin(a) < 0 is the far side (above centre): shrink and dim it so the
      // ring reads as depth rather than a flat circle.
      const depth = (Math.sin(a) + 1) / 2;          // 0 far .. 1 near
      const hovered = this.hover === i;
      const s = (0.78 + depth * 0.34) * dens * vp * (hovered ? 1.22 : 1) * (1 + beat * 0.05);
      // The far side is dimmed for depth, but not so far that it stops being
      // readable — those bodies pass over the disk, which is the brightest
      // thing on screen, and 0.42 against that was just muddy.
      const opacity = (0.56 + depth * 0.44) * (hovered ? 1 : 0.94);

      el.style.transform =
        `translate3d(${(x).toFixed(1)}px, ${(y).toFixed(1)}px, 0) translate(-50%, -50%) scale(${s.toFixed(3)})`;
      el.style.opacity = opacity.toFixed(3);
      el.style.zIndex = String(100 + Math.round(depth * 100));
      el.classList.toggle('hover', hovered);
      el.style.setProperty('--glow', (0.25 + level * 0.5 + (hovered ? 0.5 : 0)).toFixed(3));

      // Cache the hit circle for synthetic hit-testing. 30 is the unscaled
      // disc radius in CSS px; keep it in step with .body-disc in style.css.
      // `this.scale` is deliberately absent — it grows the ring, not the
      // bodies, and `s` is the only thing the transform actually applies.
      const rr = 30 * s;
      el._hit = { cx: x, cy: y, rr: rr * rr };
    }
  }
}
