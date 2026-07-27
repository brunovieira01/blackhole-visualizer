// ---------------------------------------------------------------------------
//  WebGL2 render pipeline.
//
//  scene (HDR, scaled) -> brightpass (1/4) -> blur H/V (x2) -> composite (screen)
// ---------------------------------------------------------------------------

import { VERT, SCENE_FRAG, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG } from './shaders.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    // Print the offending lines with numbers so errors are actually findable
    console.error(`[${kind} shader]\n` + src.split('\n')
      .map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n'));
    throw new Error(`${kind} shader failed to compile:\n${log}`);
  }
  return sh;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  }
  // Cache uniform locations by name
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

class Target {
  constructor(gl, internal, format, type) {
    this.gl = gl;
    this.internal = internal;
    this.format = format;
    this.type = type;
    this.w = 0;
    this.h = 0;
    this.tex = gl.createTexture();
    this.fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.internal, w, h, 0, this.format, this.type, null);
  }
}

export class BlackHoleRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, // overlay mode needs a real alpha channel to punch through

      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for capturePage / screenshots
    });
    if (!gl) throw new Error('WebGL2 is not available on this machine.');

    this.canvas = canvas;
    this.gl = gl;

    // Half-float render targets give us real HDR headroom for the bloom.
    const hasFloatRT = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    const [internal, type] = hasFloatRT
      ? [gl.RGBA16F, gl.HALF_FLOAT]
      : [gl.RGBA8, gl.UNSIGNED_BYTE];
    this.hdr = hasFloatRT;

    this.progScene = program(gl, SCENE_FRAG);
    this.progBright = program(gl, BRIGHT_FRAG);
    this.progBlur = program(gl, BLUR_FRAG);
    this.progComp = program(gl, COMPOSITE_FRAG);

    this.rtScene = new Target(gl, internal, gl.RGBA, type);
    this.rtBloomA = new Target(gl, internal, gl.RGBA, type);
    this.rtBloomB = new Target(gl, internal, gl.RGBA, type);

    this.texFFT = this._dataTex(256);
    this.texWave = this._dataTex(256);

    this.vao = gl.createVertexArray(); // empty VAO; vertices come from gl_VertexID

    this.spin = 0;
    this.orbit = 0.0;
    this.renderScale = 1.0;
    this.steps = 220;
    this.bloom = 1.0;
    this.grain = 0.012;
    this.reactivity = 1.0;
    this.warp = 1.0;
    this.diskTilt = 0.155;
    this.autoOrbit = 0.02;
    this.alphaOut = 0;
    this.theme = {
      hot: [1.0, 0.62, 0.22],
      cool: [0.75, 0.16, 0.05],
      nebula: [0.30, 0.22, 0.55],
    };
  }

  _dataTex(width) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array(width));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: t, width };
  }

  _upload(target, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, target.width, 1, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  applySettings(s) {
    if (!s) return;
    if (s.theme) this.theme = s.theme;
    if (typeof s.quality === 'number') this.steps = s.quality;
    if (typeof s.renderScale === 'number') this.renderScale = s.renderScale;
    if (typeof s.bloom === 'number') this.bloom = s.bloom;
    if (typeof s.reactivity === 'number') this.reactivity = s.reactivity;
    if (typeof s.warp === 'number') this.warp = s.warp;
    if (typeof s.grain === 'number') this.grain = s.grain;
    if (typeof s.autoOrbit === 'number') this.autoOrbit = s.autoOrbit;
    if (typeof s.diskTilt === 'number') this.diskTilt = s.diskTilt;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _draw() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  _bindTex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (loc) gl.uniform1i(loc, unit);
  }

  // audio: { bass, mid, treble, level, beat, spectrum:Uint8Array(256), wave:Uint8Array(256) }
  render(dt, time, audio) {
    const gl = this.gl;
    this.resize();

    const W = this.canvas.width;
    const H = this.canvas.height;
    const sw = Math.max(2, Math.round(W * this.renderScale));
    const sh = Math.max(2, Math.round(H * this.renderScale));
    const bw = Math.max(2, sw >> 2);
    const bh = Math.max(2, sh >> 2);

    this.rtScene.resize(sw, sh);
    this.rtBloomA.resize(bw, bh);
    this.rtBloomB.resize(bw, bh);

    // Disk rotation accelerates with the music; camera drifts slowly.
    this.spin += dt * (0.30 + 0.85 * audio.level * this.reactivity + 0.5 * audio.beat);
    this.orbit += dt * this.autoOrbit;

    this._upload(this.texFFT, audio.spectrum);
    this._upload(this.texWave, audio.wave);

    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const t = this.theme;

    // ---- 1. scene -----------------------------------------------------
    {
      const { p, loc } = this.progScene;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtScene.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.uniform2f(loc.uRes, sw, sh);
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uSpin, this.spin);
      gl.uniform1f(loc.uOrbit, this.orbit);
      gl.uniform1i(loc.uSteps, this.steps);
      gl.uniform1f(loc.uBass, audio.bass);
      gl.uniform1f(loc.uMid, audio.mid);
      gl.uniform1f(loc.uTreble, audio.treble);
      gl.uniform1f(loc.uLevel, audio.level);
      gl.uniform1f(loc.uBeat, audio.beat);
      gl.uniform1f(loc.uReact, this.reactivity);
      gl.uniform1f(loc.uDiskTilt, this.diskTilt);
      gl.uniform1f(loc.uWarp, this.warp);
      gl.uniform3fv(loc.uHot, t.hot);
      gl.uniform3fv(loc.uCool, t.cool);
      gl.uniform3fv(loc.uNebula, t.nebula);
      this._bindTex(0, this.texFFT.tex, loc.uFFT);
      this._bindTex(1, this.texWave.tex, loc.uWave);
      this._draw();
    }

    // ---- 2. bright pass ------------------------------------------------
    {
      const { p, loc } = this.progBright;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBloomA.fbo);
      gl.viewport(0, 0, bw, bh);
      gl.uniform2f(loc.uTexel, 1 / sw, 1 / sh);
      gl.uniform1f(loc.uThreshold, this.hdr ? 1.05 : 0.62);
      this._bindTex(0, this.rtScene.tex, loc.uTex);
      this._draw();
    }

    // ---- 3. blur (two ping-pong passes, widening) ----------------------
    {
      const { p, loc } = this.progBlur;
      gl.useProgram(p);
      gl.viewport(0, 0, bw, bh);
      for (let i = 0; i < 2; i++) {
        const spread = 1 + i * 1.75;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBloomB.fbo);
        gl.uniform2f(loc.uDir, spread / bw, 0);
        this._bindTex(0, this.rtBloomA.tex, loc.uTex);
        this._draw();

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBloomA.fbo);
        gl.uniform2f(loc.uDir, 0, spread / bh);
        this._bindTex(0, this.rtBloomB.tex, loc.uTex);
        this._draw();
      }
    }

    // ---- 4. composite to screen ----------------------------------------
    {
      const { p, loc } = this.progComp;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.uniform2f(loc.uRes, W, H);
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uBloomAmt, this.bloom);
      gl.uniform1f(loc.uLevel, audio.level);
      gl.uniform1f(loc.uBeat, audio.beat);
      gl.uniform1f(loc.uReact, this.reactivity);
      gl.uniform1f(loc.uGrain, this.grain);
      gl.uniform1f(loc.uAlphaOut, this.alphaOut);
      this._bindTex(0, this.rtScene.tex, loc.uScene);
      this._bindTex(1, this.rtBloomA.tex, loc.uBloom);
      this._draw();
    }
  }
}
