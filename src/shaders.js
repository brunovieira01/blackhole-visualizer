// ---------------------------------------------------------------------------
//  GLSL sources for the black hole visualiser.
//
//  Everything is drawn with a single fullscreen triangle (no vertex buffers).
//  Pipeline:  scene -> brightpass -> blur H -> blur V -> composite
// ---------------------------------------------------------------------------

export const VERT = `#version 300 es
out vec2 vUV;
void main() {
  // Fullscreen triangle generated from gl_VertexID: (0,0) (2,0) (0,2)
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
//  Shared helpers: hashes, noise, colour
// ---------------------------------------------------------------------------
const COMMON = `
#define PI  3.14159265359
#define TAU 6.28318530718

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Value noise, 2D
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, 0.0));
  float b = hash13(vec3(i + vec2(1, 0), 0.0));
  float c = hash13(vec3(i + vec2(0, 1), 0.0));
  float d = hash13(vec3(i + vec2(1, 1), 0.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Value noise, 3D
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm2(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    v += a * noise2(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

float fbm3(vec3 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    v += a * noise3(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

mat2 rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
`;

// ---------------------------------------------------------------------------
//  Scene: relativistic ray marcher
//
//  Null geodesics around a Schwarzschild black hole obey the Binet equation
//      u'' + u = (3/2) r_s u^2
//  which, in Cartesian form with r_s = 1, integrates as
//      a = -1.5 * h^2 * p / |p|^5      (h = |p x v|, conserved)
//  So: event horizon at r = 1, photon sphere at r = 1.5, ISCO at r = 3.
// ---------------------------------------------------------------------------
export const SCENE_FRAG = `#version 300 es
precision highp float;
${COMMON}

in  vec2 vUV;
out vec4 fragColor;

uniform vec2      uRes;
uniform float     uTime;
uniform float     uSpin;      // accumulated disk rotation phase
uniform float     uOrbit;     // camera azimuth
uniform int       uSteps;     // integration steps (quality)
uniform sampler2D uFFT;       // 256x1 log-spaced spectrum, R8
uniform sampler2D uWave;      // 256x1 time-domain waveform, R8
uniform float     uWarp;      // how hard the audio deforms the disk surface

uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uLevel;
uniform float uBeat;
uniform float uReact;         // reactivity multiplier

uniform vec3  uHot;           // inner disk colour
uniform vec3  uCool;          // outer disk colour
uniform vec3  uNebula;        // background nebula tint
uniform float uDiskTilt;
uniform float uAmbient;       // 1 = slow drift enabled, 0 = locked off
uniform float uRings;         // strength of the audio ring
uniform int   uRingStyle;     // 0 off, 1 contour, 2 ribbon, 3 comb, 4 halo

const float R_S    = 1.0;     // Schwarzschild radius
const float R_IN   = 2.6;     // inner disk edge (just inside ISCO, looks better)
const float R_OUT  = 13.0;    // outer disk edge
const float R_FAR  = 60.0;    // escape radius

float spectrum(float t) {
  return texture(uFFT, vec2(clamp(t, 0.0, 1.0), 0.5)).r;
}

// Radius of the audio ring at angle t (0 at 12 o'clock, 1 at 6 o'clock,
// mirrored across the vertical axis so the curve closes seamlessly).
//
// This is where the spectrum and the waveform become one object: the spectrum
// supplies the large lobes and the waveform rides on top as fine wobble, so a
// single contour carries both readings instead of needing two rings.
// Resting radius of the ring. Sits a little tighter than the swing needs, so
// there's room for loud passages to throw the curve outward without it running
// off the top and bottom of the frame.
const float RING_R0 = 0.55;

float ringRadius(float t, out float mag) {
  // Skip the bottom of the spectrum - almost no music has content below
  // ~45 Hz, so mapping it leaves a permanently bald patch at 12 o'clock.
  // Gamma > 1 keeps a silhouette instead of flattening on busy material.
  mag = pow(texture(uFFT, vec2(0.075 + 0.925 * t, 0.5)).r, 1.35);
  float w = texture(uWave, vec2(t, 0.5)).r * 2.0 - 1.0;
  // Swing is bounded so a full-scale peak plus the bloom skirt still stays
  // inside the frame vertically (sp.y runs -1..1).
  return RING_R0 + mag * 0.325 + w * 0.028;
}

// ---- the disk as a deformable sheet ---------------------------------------
// The accretion disk isn't a flat plane: its height is driven by the audio, so
// the whole sheet moves with the music.
//
// It is shaped as a sum of azimuthal vibration modes, like a drum head, rather
// than by wrapping the raw waveform around the circle. That distinction is the
// whole trick: an audio waveform is high spatial frequency, so wrapping it
// produces fine corrugation that just reads as fuzz and forces the amplitude
// down to stay legible. A handful of low-order modes gives big coherent lobes
// you can actually follow, which means the amplitude can be much larger.
//
// Bands are separated by both mode number and radius, so different instruments
// land in different places and stay tellable apart:
//   bass   -> 2 and 3 lobes, inner disk   (kick, bassline: slow heaving)
//   mid    -> 5 and 7 lobes, mid radii    (voice, melody: rolling undulation)
//   treble -> 11 and 15 lobes, outer edge (hats, transients: fine shimmer)
float diskHeight(vec2 p) {
  float r = length(p);
  if (r > R_OUT * 1.25) return 0.0;

  float t = clamp((r - R_IN) / (R_OUT - R_IN), 0.0, 1.0);
  // Held rigid across the inner rim, where the photon ring and the lensed arc
  // are drawn, and faded out before the outer edge.
  float env = smoothstep(0.05, 0.40, t) * (1.0 - smoothstep(0.66, 1.0, t));

  float a = atan(p.y, p.x) + uSpin * 0.05;

  // Radial homes for each band. Overlapping, so the disk still reads as one
  // surface rather than three concentric zones.
  float wLow  = 1.0 - smoothstep(0.10, 0.70, t);
  float wMid  = exp(-pow((t - 0.45) / 0.32, 2.0));
  float wHigh = smoothstep(0.30, 0.90, t);

  // Modes drift at different rates so the pattern never looks like a frozen
  // standing wave, and the phases are offset so they don't all peak together.
  float h = 0.0;
  h += wLow  * uBass   * (0.62 * sin(2.0  * a - uTime * 0.61)
                        + 0.46 * sin(3.0  * a + uTime * 0.43 + 1.7));
  h += wMid  * uMid    * (0.44 * sin(5.0  * a - uTime * 0.87 + 3.1)
                        + 0.34 * sin(7.0  * a + uTime * 1.09 + 0.4));
  h += wHigh * uTreble * (0.26 * sin(11.0 * a - uTime * 1.55 + 2.2)
                        + 0.19 * sin(15.0 * a + uTime * 1.97 + 5.0));

  // A swell running outward through the disk, amplitude taken from the
  // spectrum at this radius. This is what carries the punch of a kick.
  float s = spectrum(pow(t, 0.65));
  h += 0.85 * s * sin(r * 1.7 - uTime * 2.6);

  // A little raw waveform on top for texture, kept small for the reason above.
  float u = abs(fract(a / TAU) * 2.0 - 1.0);
  h += 0.22 * (texture(uWave, vec2(u, 0.5)).r * 2.0 - 1.0);

  return h * env * uWarp * 0.62;
}

// Signed distance to that sheet. Cheap early-outs keep the marcher fast: the
// warp is bounded, so far above or below the plane the flat answer is exact.
float diskDist(vec3 p) {
  // Must bound the largest height diskHeight can return, or rays would skip
  // straight through the crests of a loud passage.
  float reach = 1.9 * uWarp + 0.30;
  if (abs(p.y) > reach) return p.y;
  return p.y - diskHeight(p.xz);
}

// ---- background: stars + nebula, sampled by the *bent* ray direction ------

// Stars are not white dots. Their colour follows a blackbody curve set by
// surface temperature, which is what the spectral classes name: M red dwarfs,
// K orange, G yellow (our Sun), A white, B/O blue. Sampling that ramp instead
// of tinting white is most of the difference between "space" and "static".
// t runs 0 (coolest, red) to 1 (hottest, blue).
vec3 starColor(float t) {
  const vec3 M = vec3(1.00, 0.26, 0.10);   // red
  const vec3 K = vec3(1.00, 0.56, 0.24);   // orange
  const vec3 G = vec3(1.00, 0.92, 0.56);   // yellow
  const vec3 A = vec3(0.96, 0.98, 1.00);   // white
  const vec3 B = vec3(0.44, 0.64, 1.00);   // blue
  // Overlapping smoothsteps rather than branches: continuous, and no class
  // sits at a hard edge where a hash lands on it more often than its neighbours.
  vec3 c = mix(M, K, smoothstep(0.00, 0.30, t));
  c = mix(c, G, smoothstep(0.24, 0.54, t));
  c = mix(c, A, smoothstep(0.50, 0.78, t));
  c = mix(c, B, smoothstep(0.74, 1.00, t));
  return c;
}

// sharp is the gaussian falloff of a star's core, in cell units. It has to
// rise with the cell size or a sparse layer (low scale, big cells) paints
// fuzzy blobs instead of points: the falloff is relative to the cell, so the
// same number covers far more of the screen when the cells are large.
// (No backticks in here -- this whole shader lives in a JS template literal.)
vec3 starLayer(vec3 d, float scale, float density, float bright, float hotShift, float sharp) {
  vec3 p = d * scale;
  vec3 id = floor(p);
  vec3 f  = fract(p);
  vec3 acc = vec3(0.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 o  = vec3(float(x), float(y), float(z));
        vec3 h  = hash33(id + o);
        if (h.z < density) continue;
        vec3 sp = o + h - f;
        float dist = length(sp);
        float core = exp(-dist * dist * sharp);
        // Lazy, purely time-based shimmer, each star on its own slow period.
        // Driving this from the treble made the whole sky flicker on hi-hats.
        float tw = 0.74 + 0.26 * sin(uTime * (0.22 + h.x * 0.55) + h.y * TAU);

        // Decorrelated from the size/gate components, or colour and brightness
        // would march together and the sky would band.
        float spec = fract(h.x * 5.137 + h.y * 2.713 + hotShift);
        // Pushed away from the middle of the ramp on purpose. A uniform sample
        // puts most stars in the white classes, where they all look the same;
        // the point of colouring them at all is to see reds and blues.
        spec = 0.5 + 0.5 * sign(spec - 0.5) * pow(abs(spec * 2.0 - 1.0), 0.62);
        vec3 col = starColor(spec);

        // Hot stars really are the brighter ones, and letting the blues carry
        // a little extra is what stops them being lost among the yellows.
        float lum = 0.80 + 0.55 * spec * spec;

        acc += col * core * bright * lum * max(tw, 0.0) * (0.35 + h.z);
      }
    }
  }
  return acc;
}

// Pull a vivid version of the theme's hue out of uNebula. The presets store a
// dim, desaturated tint (it is used as a wash elsewhere); the sky wants the
// same hue at full strength, or every theme's nebula comes out muddy grey.
vec3 nebulaHue(float sat) {
  vec3 n = uNebula / max(max(uNebula.r, max(uNebula.g, uNebula.b)), 1e-4);
  float l = dot(n, vec3(0.3333));
  return max(mix(vec3(l), n, sat), 0.0);
}

// Normal of the galactic plane. Deliberately tilted well away from the
// accretion disk's plane so the arm crosses the frame at an angle and the two
// structures read as separate things rather than one smear.
const vec3 GAL_N = normalize(vec3(0.36, 0.84, -0.41));

vec3 background(vec3 d) {
  vec3 col = vec3(0.0);

  // The two star layers creep at slightly different rates, which parallaxes
  // them against each other and gives the sky a sense of depth and drift even
  // when the camera is locked. Slow enough that you notice it only if you look.
  vec3 dNear = d;
  vec3 dFar  = d;
  if (uAmbient > 0.5) {
    dNear.xz = rot(uTime * 0.0045) * d.xz;
    dFar.xz  = rot(uTime * 0.0026) * d.xz;
  }

  // ---- the galactic arm ----------------------------------------------
  float gy   = dot(d, GAL_N);               // 0 on the galactic plane
  float band = exp(-gy * gy * 62.0);        // tight bright core of the arm

  // Angle *along* the arm, for structure that runs down its length
  vec3  al = normalize(d - GAL_N * gy);
  float u  = atan(al.z, al.x);

  // Contrast, not brightness. Making the arm brighter just greys out the sky;
  // making it *lumpier* gives it structure while the average stays near black.
  float cloud = fbm3(d * 3.1, 4);
  cloud = pow(clamp(cloud * 1.35, 0.0, 1.0), 1.7);
  // No constant floor. The 0.16 that used to be here lit the whole width of
  // the band even where there was no cloud at all, which is most of what made
  // the sky a wash instead of black with something in it.
  float arm = band * 1.35 * cloud;

  // Dust lanes. Dark filaments cutting along the arm are the single thing
  // that makes a star cloud read as the Milky Way instead of a bright smudge.
  float dust = fbm2(vec2(u * 2.7, gy * 11.0) + vec2(uTime * 0.004, 0.0), 4);
  dust = smoothstep(0.36, 0.70, dust);
  arm *= 1.0 - dust * 0.92;

  // The arm used to be a neutral grey, which is exactly what made the sky read
  // as a white smear: the brightest parts of it had no hue at all. Colour it by
  // density instead — thin outskirts hold the theme's hue, and the dense cores
  // brighten and warm, the way an ionised star cloud actually looks. Same
  // luminance as before, so the "contrast not brightness" rule still holds.
  vec3 armThin  = nebulaHue(1.5) * 0.62;
  vec3 armDense = armThin * 2.2 + vec3(0.30, 0.14, 0.10);
  vec3 armCol   = mix(armThin, armDense, cloud);
  col += armCol * arm * 0.085;
  // The broad glow either side of the plane is gone on purpose. exp(-gy*gy*3.6)
  // is above 0.1 across roughly four fifths of the sky, so however faint you
  // make it, it tints *everything* — it was the single biggest reason the
  // background never went properly black.

  // ---- nebulae --------------------------------------------------------
  // Two clouds with different hues and drifts, thresholded hard so they sit as
  // distinct shapes against black rather than lifting the whole sky. Each gets
  // a small, much brighter core: emission red on one, reflection blue on the
  // other, which is what gives them a sense of being real objects.
  // Thresholds are high on purpose: only the top of each noise field survives,
  // so these are occasional objects sitting in black rather than a tint spread
  // over the whole sky. Amplitudes go *up* to compensate — where a cloud does
  // appear it should be vivid, which is the opposite trade to lifting the
  // average everywhere.
  float n1 = fbm3(d * 1.8 + vec3(9.2, 0.0, uTime * 0.010), 5);
  n1 = pow(max(n1 - 0.56, 0.0) * 3.6, 2.0);
  float n2 = fbm3(d * 2.6 - vec3(0.0, 4.1, uTime * 0.015), 4);
  n2 = pow(max(n2 - 0.58, 0.0) * 3.6, 2.2);

  // A third, much larger violet complex filling the space the other two leave
  // empty. Thresholded hard and multiplied by its own finer noise: a broad
  // smooth falloff here reads as a flat haze over the whole sky, and the thing
  // that makes it look like a nebula instead is the filament structure, not
  // the amount of light.
  float n3 = fbm3(d * 0.9 + vec3(3.7, 2.4, uTime * 0.006), 4);
  n3 = pow(max(n3 - 0.655, 0.0) * 5.0, 2.4);
  float fil = fbm3(d * 5.5 - vec3(1.3, 0.0, uTime * 0.008), 4);
  // No floor at all: between the filaments this goes to zero, which is what
  // lets the space around the cloud be genuinely black instead of dim purple.
  n3 *= 2.4 * pow(clamp(fil, 0.0, 1.0), 2.4);

  col += nebulaHue(1.7) * n3 * 0.20;
  col += mix(nebulaHue(1.4), vec3(1.0), 0.35) * pow(n3, 2.0) * 0.11;
  col += uNebula * n1 * 0.16;
  // Emission red (ionised hydrogen) on one core, reflection blue on the other.
  col += vec3(1.00, 0.30, 0.26) * pow(n1, 2.3) * 0.095;
  col += uNebula.bgr * n2 * 0.085;
  col += vec3(0.36, 0.56, 1.00) * pow(n2, 2.5) * 0.070;

  // ---- stars ----------------------------------------------------------
  // Denser inside the arm, which is what sells it as a star cloud. The far
  // layer is shifted along the spectral ramp so the two don't draw from the
  // same colours in the same order and read as one field.
  col += starLayer(dNear,  90.0, 0.950 - band * 0.030, 1.00, 0.00, 34.0);
  col += starLayer(dFar,  210.0, 0.970 - band * 0.018, 0.55, 0.37, 34.0);

  // A handful of foreground giants. Every real sky has a few stars that are
  // obviously coloured — a red Betelgeuse, a blue Rigel — and they are what
  // you actually notice. Kept moderate rather than bright: ACES desaturates
  // highlights, so an overdriven star tonemaps to white and the colour is
  // lost. These stay in range and let the bloom carry the hue instead.
  // 250 keeps them only slightly larger on screen than an ordinary star:
  // 34 * (90/26)^2 would match exactly, so this is a deliberate ~1.3x.
  col += starLayer(dNear, 26.0, 0.9885, 1.35, 0.61, 250.0);

  return col;
}

// ---- accretion disk ------------------------------------------------------
vec3 diskSample(vec3 hit, vec3 vel, out float alpha) {
  float r = length(hit.xz);
  float t = (r - R_IN) / (R_OUT - R_IN);           // 0 inner .. 1 outer

  // Radial envelope: sharp inner rim, soft outer fade
  float env = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.40, 1.0, t));

  // Keplerian shear: inner material laps the outer material
  float w = uSpin * 5.5 * pow(max(r, 0.6), -1.5);
  vec2  q = rot(w) * hit.xz;

  // Two noise scales -> filaments + large-scale clumping
  float n1 = fbm2(q * 0.85 + vec2(0.0, uTime * 0.05), 5);
  float n2 = fbm2(q * 3.10 - vec2(uTime * 0.11, 0.0), 4);
  float turb = mix(n1, n1 * n2 * 2.0, 0.45 + 0.45 * uMid * uReact);

  // The spectrum is mapped radially: bass ripples the inner rim,
  // highs shimmer at the outer edge. This is what makes it "dance".
  float spec = spectrum(pow(t, 0.65));
  float dens = env * (0.30 + 0.70 * turb);
  // Eased back from the pre-warp values: with the larger displacement a ray
  // crosses the sheet more often, and at the old gains loud passages saturated
  // the disk to flat white and swallowed the filament detail.
  dens *= 1.0 + uReact * (1.15 * spec + 0.75 * uBass * exp(-t * 3.5));
  // A gentle swell on onsets, confined to the disk. Small on purpose: a
  // full-disk flash on every beat is its own kind of strobing.
  dens *= 1.0 + uBeat * uReact * 0.30 * exp(-t * 2.0);

  // Temperature: T ~ r^-3/4 -> white hot inside, ember red outside
  float temp = pow(clamp(1.0 - t, 0.0, 1.0), 1.35);
  vec3 col = mix(uCool, uHot, temp);
  col += vec3(1.0, 0.97, 0.92) * pow(temp, 5.0) * 0.55;

  // Relativistic beaming + Doppler tint: orbital beta ~ sqrt(r_s / 2r)
  vec3 orbit = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(hit.x, 0.0, hit.z)));
  float beta = 0.52 * inversesqrt(max(r, 1.2));
  float dop  = dot(orbit, -normalize(vel)) * beta;
  col *= pow(clamp(1.0 + dop, 0.10, 2.0), 2.2);
  vec3 blue = col * vec3(0.55, 0.85, 1.70);
  vec3 red  = col * vec3(1.70, 0.62, 0.34);
  col = mix(col, dop > 0.0 ? blue : red, clamp(abs(dop) * 1.5, 0.0, 0.72));

  // Gravitational redshift towards the horizon
  col *= clamp(sqrt(1.0 - R_S / max(r, 1.05)), 0.25, 1.0);

  // Sheen from the local slope of the warped sheet. Without this the ripples
  // only read as a silhouette; shading them makes the wave visible across the
  // whole face of the disk. Four extra height samples, but disk hits are rare
  // (one to three per ray) so it's cheap where it counts.
  if (uWarp > 0.01) {
    const float e = 0.4;
    float hx = diskHeight(hit.xz + vec2(e, 0.0)) - diskHeight(hit.xz - vec2(e, 0.0));
    float hz = diskHeight(hit.xz + vec2(0.0, e)) - diskHeight(hit.xz - vec2(0.0, e));
    vec3 nrm = normalize(vec3(-hx, 2.0 * e, -hz));
    float sheen = pow(clamp(abs(dot(nrm, normalize(vel))), 0.0, 1.0), 1.4);
    col *= 0.68 + 1.05 * sheen;

    // Crests run hot, troughs fall dark. This is what actually sells the wave
    // when the disk is nearly edge-on and the silhouette barely moves.
    float crest = clamp(hit.y / (0.95 * uWarp + 0.08), -1.0, 1.0);
    col *= 1.0 + crest * 0.62;
  }

  alpha = clamp(dens * 0.95, 0.0, 1.0);
  return col * 0.55;
}

void main() {
  vec2 uv = (vUV * uRes - 0.5 * uRes) / uRes.y;

  // --- camera ---------------------------------------------------------
  // Framed so the r=13 disk sits just inside the vertical field of view.
  //
  // Deliberately rigid: no audio-driven dolly, no beat shake, no drift. The
  // black hole is the fixed thing you look *at*; only the disk moves. Anything
  // that displaces the whole frame in time with the music reads as the screen
  // lurching, which is nauseating on a wallpaper you stare at all day.
  // Ambient motion is slow, continuous and completely independent of the
  // audio. That's the distinction that matters: a camera creeping around over
  // minutes reads as drifting through space, while anything synced to the beat
  // reads as the screen lurching. uOrbit accumulates on the CPU side.
  const float dist = 28.0;
  float pitch = uDiskTilt + uAmbient * 0.055 * sin(uTime * 0.043);
  vec3  ro = vec3(sin(uOrbit) * cos(pitch), sin(pitch), cos(uOrbit) * cos(pitch)) * dist;

  vec3 fwd   = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up    = cross(fwd, right);

  vec3 vel = normalize(fwd * 1.05 + right * uv.x + up * uv.y);
  vec3 pos = ro;

  // Conserved angular momentum of this photon
  vec3 hv = cross(pos, vel);
  float h2 = dot(hv, hv);

  vec3  col = vec3(0.0);
  float trans = 1.0;            // remaining transmittance
  float minR = 1e9;             // closest approach -> photon ring glow
  bool  captured = false;
  float prevD = diskDist(pos);  // signed distance to the (warped) disk sheet

  for (int i = 0; i < 512; i++) {
    if (i >= uSteps) break;

    float r = length(pos);
    minR = min(minR, r);

    if (r < R_S) { captured = true; break; }
    if (r > R_FAR) break;
    if (trans < 0.004) break;

    // Adaptive step: coarse on the long approach, fine near the hole, and
    // refined again whenever we're closing in on the disk surface.
    float dt = clamp(r * 0.075, 0.018, 0.9);
    dt *= clamp(abs(prevD) * 0.55 + 0.30, 0.30, 1.0);

    vec3 prev = pos;
    vec3 acc  = -1.5 * h2 * pos / pow(dot(pos, pos), 2.5);
    vel += acc * dt;
    pos += vel * dt;

    // Did we cross the disk? (multiple crossings give the iconic arc of the
    // far side of the disk lensed up over the top and down under the bottom)
    float curD = diskDist(pos);
    if (prevD * curD < 0.0) {
      float f = prevD / (prevD - curD);
      vec3 hit = mix(prev, pos, f);
      float rr = length(hit.xz);
      if (rr > R_IN && rr < R_OUT) {
        float a;
        vec3 dc = diskSample(hit, vel, a);
        col   += trans * dc * a;
        trans *= 1.0 - a * 0.86;
      }
    }
    prevD = curD;
  }

  // Background only reaches us if the photon escaped
  if (!captured) col += trans * background(normalize(vel));

  // Photon ring: light that skimmed r = 1.5 r_s piles up into a thin halo.
  // Rays that fell straight in have minR ~ 1, so the shadow stays truly black.
  // Held at a constant brightness — a black hole that throbs on every beat is
  // exactly the kind of motion we're keeping out of the frame.
  float ringD = abs(minR - 1.5 * R_S);
  float ring  = exp(-ringD * ringD * 90.0);
  col += uHot * ring * 0.30;

  // ---- audio ring -----------------------------------------------------
  // One shape, not two. The spectrum and the waveform used to be a bar crown
  // and a separate oscilloscope loop fighting for the same space; here they
  // are a single closed contour whose radius carries both — the spectrum
  // gives the large lobes, the waveform adds the fine wobble on top. The four
  // styles are just different ways of drawing that one curve.
  //
  // It's drawn into the scene buffer rather than over the finished frame, so
  // the bloom pass treats it as emitted light and the disk can occlude it.
  if (uRings > 0.001 && uRingStyle > 0) {
    vec2  sp = uv * 2.0;                       // y in [-1, 1]
    float rr = length(sp);
    float px = 2.0 / uRes.y;                   // one pixel, in these units
    float t2 = atan(abs(sp.x), sp.y) / PI;     // 0 at 12 o'clock, 1 at 6

    const float R0 = RING_R0;
    float mag, magSeg, rSeg;
    float R = ringRadius(t2, mag);

    // Colour runs cool at the bass end and hot at the treble end, on top of
    // the magnitude ramp - a literal temperature gradient around the ring.
    vec3 bc = mix(uCool, uHot, clamp(mag * 0.95 + t2 * 0.55, 0.0, 1.0));
    vec3 rings = vec3(0.0);

    if (uRingStyle == 1) {
      // Contour: a single glowing line, with a soft bloom skirt.
      float d1 = (rr - R) / (1.7 * px);
      rings += bc * exp(-d1 * d1) * (0.55 + 1.5 * mag);
      float d2 = (rr - R) / (16.0 * px);
      rings += bc * exp(-d2 * d2) * 0.16 * (0.30 + mag);

    } else if (uRingStyle == 2) {
      // Ribbon: a band of light following the contour. Filling all the way
      // down to R0 made a solid gear that swallowed the whole frame, so this
      // tracks the curve at a fixed thickness instead.
      float thick = 0.045 + 0.035 * mag;
      float inner = R - thick;
      float a = smoothstep(inner - 1.5 * px, inner + 1.5 * px, rr)
              * smoothstep(R + 1.5 * px, R - 1.5 * px, rr);
      float along = clamp((rr - inner) / thick, 0.0, 1.0);
      rings += bc * a * (0.35 + 0.65 * along) * (0.30 + 0.75 * mag);
      float d1 = (rr - R) / (1.8 * px);
      rings += bc * exp(-d1 * d1) * 0.50;

    } else if (uRingStyle == 3) {
      // Comb: discrete bars, but capped by the same continuous contour so it
      // still reads as one object rather than bars plus a stray circle.
      // Narrow bars with generous gaps and a fast fade outward, so a loud
      // passage stays a comb rather than filling in to a solid gear.
      const float BARS = 112.0;
      float loc = fract(t2 * BARS);
      float gap = smoothstep(0.14, 0.44, loc) * smoothstep(0.86, 0.56, loc);
      rSeg = ringRadius((floor(t2 * BARS) + 0.5) / BARS, magSeg);
      float base = R0 + 0.085;          // short bars: they hang off the curve
      float a = smoothstep(base - 1.5 * px, base + 1.5 * px, rr)
              * smoothstep(rSeg + 1.5 * px, rSeg - 1.5 * px, rr);
      float along = clamp((rr - base) / max(rSeg - base, 1e-4), 0.0, 1.0);
      rings += bc * a * gap * (1.0 - along * along * 0.88) * (0.20 + 0.52 * magSeg);
      float d1 = (rr - R) / (1.8 * px);
      rings += bc * exp(-d1 * d1) * 0.42;

    } else {
      // Halo: a soft band of light centred on the curve, no edges anywhere.
      // Swelling outward from R0 instead made a solid sunburst.
      float d1 = (rr - R) / (0.055 + 0.045 * mag);
      rings += bc * exp(-d1 * d1) * (0.22 + 0.70 * mag);
    }

    // Let the scene occlude it: where the disk is bright it reads as being in
    // front, which is what stops this looking like a sticker on the glass.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    rings *= 1.0 - clamp(lum * 0.9, 0.0, 0.88);

    // Sink away to nothing in silence rather than sitting there as a dead ring.
    col += rings * uRings * (0.08 + 0.92 * smoothstep(0.02, 0.22, uLevel));
  }

  fragColor = vec4(max(col, 0.0), 1.0);
}`;

// ---------------------------------------------------------------------------
//  Bright pass (with 4-tap downsample)
// ---------------------------------------------------------------------------
export const BRIGHT_FRAG = `#version 300 es
precision highp float;
in  vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uThreshold;

void main() {
  vec3 s = texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUV + uTexel * vec2( 1.0,  1.0)).rgb;
  s *= 0.25;
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  fragColor = vec4(s * k, 1.0);
}`;

// ---------------------------------------------------------------------------
//  Separable 9-tap gaussian
// ---------------------------------------------------------------------------
export const BLUR_FRAG = `#version 300 es
precision highp float;
in  vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;   // texel-sized step along one axis

void main() {
  // Linear-sampling gaussian: 5 taps cover 9 pixels
  const float o1 = 1.3846153846;
  const float o2 = 3.2307692308;
  vec3 c = texture(uTex, vUV).rgb * 0.2270270270;
  c += texture(uTex, vUV + uDir * o1).rgb * 0.3162162162;
  c += texture(uTex, vUV - uDir * o1).rgb * 0.3162162162;
  c += texture(uTex, vUV + uDir * o2).rgb * 0.0702702703;
  c += texture(uTex, vUV - uDir * o2).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------------------
//  Composite: bloom + ACES tonemap + vignette + grain
//  (No overlay rings — all the audio reactivity lives in the disk itself.)
// ---------------------------------------------------------------------------
export const COMPOSITE_FRAG = `#version 300 es
precision highp float;
${COMMON}

in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;

uniform vec2  uRes;
uniform float uTime;
uniform float uBloomAmt;
uniform float uGrain;
uniform float uAlphaOut;   // 1 in overlay mode: punch out the dark areas

// Note: nothing here reacts to the audio, by design. Every audio-driven term
// in this pass moved the whole frame at once (bloom gain, chromatic
// aberration) and that is what made the visualiser hard to look at.

// ACES filmic tonemap (Narkowicz fit)
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUV;
  vec2 p  = (uv * 2.0 - 1.0);
  p.x *= uRes.x / uRes.y;

  // Chromatic aberration grows towards the edges. Constant, not beat-driven:
  // shifting the whole frame's colour fringing in time with the music is a
  // large part of what made this uncomfortable to look at. Kept low anyway —
  // point stars split into coloured dots if it's too strong.
  float ca = 0.0006 * dot(p, p) * 0.35;
  vec2  dir = normalize(uv - 0.5 + 1e-6);
  vec3 scene;
  scene.r = texture(uScene, uv + dir * ca).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - dir * ca).b;

  // Bloom gain is constant too — pumping it made the entire screen breathe.
  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 col = scene + bloom * uBloomAmt;

  // ---- grade ----------------------------------------------------------
  col = aces(col * 1.05);
  col = pow(col, vec3(1.0 / 2.2));

  // Vignette, deep enough that the corners fall to near black
  float vig = smoothstep(1.75, 0.30, length(p) * 0.95);
  col *= mix(0.40, 1.0, vig);

  // Film grain keeps gradients from banding on dark backgrounds
  float g = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 977.0)) - 0.5;
  col += g * uGrain;

  // Overlay mode floats above the desktop: make the alpha follow luminance so
  // empty space is fully see-through and only the glow is drawn. The canvas
  // is premultiplied, so the colour is emitted as-is.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float a = mix(1.0, clamp(lum * 1.9, 0.0, 1.0), uAlphaOut);

  fragColor = vec4(col, a);
}`;
