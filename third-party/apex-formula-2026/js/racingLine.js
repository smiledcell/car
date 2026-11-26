// Dynamic racing-line assist: one ribbon on the ideal line ahead of the player
// that runs green (flat out) through yellow (lift / hold) to red (brake now).
// Purely visual: it reads session state, never writes it, and never draws from
// the session's seeded random stream, so pacing determinism is untouched.
import * as THREE from 'three';

const MODES = ['off', 'braking', 'full'];
const LABEL = { off: 'OFF', braking: 'BRAKING ZONES', full: 'FULL' };
const modeOf = (value) => (MODES.includes(value) ? value : 'braking');

// ---- shape
const HALF_W = 0.55;  // 1.1 m ribbon
// Road strip is height + 0.02, rubber groove + 0.028, night light pools
// + 0.036; polygonOffset settles what is left.
const LIFT = 0.05;
const LEN_MIN = 250, LEN_MAX = 350;  // metres drawn ahead; longer at speed
const NEAR_0 = 3.5, NEAR_1 = 16;  // fade-in window ahead of the car
const CHEVRON_M = 8;  // chevron pitch; 6 m strobes at 340 km/h

// ---- speed model: js/ai.js, read-only and slightly conservative
// The AI targets line[i].spd and allows itself, at sample i, the minimum over
// the road ahead of sqrt(spd[j]^2 + 2 * 38 * distance). Same envelope here,
// with two changes in a newcomer's favour:
//  * 38 m/s^2 is the car's average over a stop from top speed, and only
//    downforce supplies it: measured full braking is 10 + 0.38 v (17 at
//    20 m/s, 46 at 95), so a plan at 38 reaches a hairpin far too fast. The
//    ribbon brakes on the measured curve, scaled by 0.9;
//  * corner targets sit 3% under the line's own.
// A gentler envelope (62% of that braking) is where a relaxed driver brakes:
// green ends there, red starts at the hard one, the ramp between is yellow.
const BRAKE_PEAK = 46, BRAKE_SAFETY = 0.9, SOFT = 0.62, K_SPEED = 0.97;
const FREE = 400;  // "no limit here" (m/s)
const VSC_CAP = 60;  // race.js penalises > 62 m/s under the VSC
const GAP = 2;  // envelope gap (m/s) that makes a braking zone
const RED_AT = 0.5;  // share of planned braking that is fully red
const OVER = 0.08;  // this far over a limit, coasting, is fully red
const brakeAt = (v) => BRAKE_SAFETY * Math.min(BRAKE_PEAK, 10 + 0.38 * v);
// Measured flat-out acceleration: traction-limited, then power against drag.
const accelAt = (v) => (v < 22 ? 8.3 : v < 42 ? 8.3 + 0.22 * (v - 22)
  : Math.max(0, 12.7 - 0.225 * (v - 42)));

const GREEN = [0.05, 0.80, 0.20], YELLOW = [1.0, 0.72, 0.03], RED = [1.0, 0.07, 0.04];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

const VERT = `
attribute vec4 tint;
attribute vec2 lane;
varying vec4 vTint;
varying vec2 vLane;
#include <fog_pars_vertex>
void main() {
  vTint = tint;
  vLane = lane;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
// Analytic chevrons: antialiased by their own derivative and dissolved into
// their mean where a pixel cannot resolve the pitch (no moire far away). The
// peak stays under the day bloom threshold: a guide, not a light source.
const FRAG = `
uniform float uGain;
uniform float uChevron;
varying vec4 vTint;
varying vec2 vLane;
#include <fog_pars_fragment>
void main() {
  float ax = abs(vLane.x);
  float phase = vLane.y + ax * 0.25;
  float f = fract(phase);
  float w = max(fwidth(phase), 1e-4);
  float band = smoothstep(0.0, w, f) * (1.0 - smoothstep(0.5, 0.5 + w, f));
  band = mix(0.5, mix(band, 0.5, smoothstep(0.25, 0.7, w)), uChevron);
  float edge = 1.0 - smoothstep(1.0 - max(fwidth(ax) * 1.5, 0.08), 1.0, ax);
  float alpha = vTint.a * edge * (0.5 + 0.45 * band);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vTint.rgb * uGain * (0.78 + 0.27 * band), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class RacingLine {
  constructor(scene, circuit) {
    this.mesh = null;
    if (scene && circuit) this.build(scene, circuit);
  }

  /** Cycle Off -> Braking zones -> Full on the UI's settings; returns the label. */
  static cycle(ui) {
    const next = MODES[(MODES.indexOf(modeOf(ui.settings.racingLine)) + 1) % 3];
    ui.settings.racingLine = next;
    ui.saveSettings?.();
    return LABEL[next];
  }

  build(scene, circuit) {
    this.dispose();
    const { N, ds, line } = circuit;
    this.scene = scene;
    this.circuit = circuit;

    // A sample limits speed only where the line is cornering. The top-speed
    // plateau and the straights (targets there are only the builder's
    // acceleration ramp) are free, so a strong exit never reads as too fast.
    let top = 0;
    for (let i = 0; i < N; i++) top = Math.max(top, line[i].spd);
    this.lim = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const free = line[i].spd >= top - 0.05 || line[i].curv < 1 / 400;
      this.lim[i] = free ? FREE : line[i].spd * K_SPEED;
    }
    // Whole chevrons per lap, so the pattern closes on itself at the line.
    this.rep = Math.max(1, Math.round(N * ds / CHEVRON_M)) / N;

    const S = this.max = Math.ceil(LEN_MAX / ds) + 3;  // ribbon stations
    this.horizon = Math.ceil(300 / ds);  // a gentle stop from top speed
    this.hard = new Float32Array(S + 2);
    this.soft = new Float32Array(S + 2);
    this.sev = new Float32Array(N);  // smoothed, per track sample
    this.stamp = new Int32Array(N).fill(-9);
    this.frame = this.show = 0;
    this.moving = false;
    this.grip = { opts: { wetTyre: 0 }, out: { surface: {} } };

    this.pos = new Float32Array(S * 6);
    this.tint = new Float32Array(S * 8);
    this.lane = new Float32Array(S * 4);
    const index = new Uint16Array((S - 1) * 6);
    for (let k = 0; k < S; k++) {
      const a = k * 2;
      if (k < S - 1) index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k * 6);  // road winding
      this.lane[k * 4] = 1;
      this.lane[k * 4 + 2] = -1;
    }
    const geometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [['position', this.pos, 3], ['tint', this.tint, 4], ['lane', this.lane, 2]]) {
      geometry.setAttribute(name, new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);

    const theme = circuit.theme || {};
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        // Unlit is as bright at midnight as at noon: dim it with the venue.
        uGain: { value: theme.night ? 0.62 : theme.floodlit ? 0.85 : 1 },
        uChevron: { value: calm ? 0 : 1 },
      }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
    });
    material.extensions.derivatives = true;

    const mesh = this.mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'racing-line-assist';
    mesh.frustumCulled = false;  // rewritten in place every frame
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 3.5;  // after the groove, skid marks and light pools
    mesh.visible = false;
    // GTAO's opaque override material would see this overlay as a solid strip.
    mesh.userData.gtaoExcluded = true;
    scene.add(mesh);
    return this;
  }

  /** Once per rendered frame. `mode` is 'off' | 'braking' | 'full'. */
  update(session, mode, dt) {
    const mesh = this.mesh;
    if (!mesh) return;
    mode = modeOf(mode);
    const e = session?.player, p = e?.phys;
    if (mode === 'off' || !p) return this.hide();
    const c = this.circuit, N = c.N, ds = c.ds;
    const pose = e.renderPose;
    const v = Math.max(0, pose ? pose.v : p.v) || 0;
    this.moving = v > (this.moving ? 2 : 5);
    // Never for an AI car, and not where the line means nothing: the pit lane,
    // the formation lap, a parked car, or after the flag.
    const want = this.moving && !p.disabled && !p.corridor && !e.finished && !e.dnf &&
      !(e.pitState && !e.pitState.driven) && session.phase !== 'formation' &&
      (session.focusEntry || e) === e && !(session.mode !== 'race' && session.qualiState === 'done');
    this.show += ((want ? 1 : 0) - this.show) * Math.min(1, dt * (want ? 4 : 7));
    if (!want && this.show < 0.02) return this.hide();

    const i0 = (((p.trackIdx ?? p.sampleIdx) % N) + N) % N;
    const s0 = c.samples[i0];
    const along = ((pose ? pose.x : p.pos.x) - s0.p.x) * s0.t.x + ((pose ? pose.z : p.pos.z) - s0.p.z) * s0.t.z;
    const length = LEN_MIN + (LEN_MAX - LEN_MIN) * clamp01(v / 90);
    const count = Math.min(this.max, Math.ceil((length + along) / ds) + 1);

    // ---- allowed speed: backward over the ribbon plus a stopping horizon
    const state = c.trackState;
    const wet = (state?.visualState?.wetness || 0) > 0.02;
    const grip = this.grip;
    grip.opts.wetTyre = p.compoundData?.wetTyre || 0;
    const wear = 1 - 0.06 * (p.wear || 0);  // ai.js tyreF
    const cap = session.vsc?.active ? VSC_CAP : FREE;
    const hard = this.hard, soft = this.soft, lim = this.lim;
    let H = FREE, S = FREE, speedScale = wear, brakeScale = 1;
    for (let j = count + this.horizon; j >= 0; j--) {
      const idx = (i0 + j) % N;
      if (wet && (j & 3) === 0) {
        // ai.js: targets * sqrt(grip) * (1 - 0.08 wetness), with grip sampled
        // on the line for the fitted tyre. Braking takes it linearly.
        const g = c.gripAt(idx, state.lineOffset?.[idx] || 0, grip.opts, grip.out);
        brakeScale = Math.min(1, Math.max(0.45, g.multiplier));
        speedScale = wear * Math.sqrt(brakeScale) * (1 - 0.08 * (g.wetness || 0));
      }
      const limit = Math.min(cap, lim[idx] >= FREE ? FREE : lim[idx] * speedScale);
      H = Math.min(limit, Math.sqrt(H * H + 2 * brakeAt(H) * brakeScale * ds));
      S = Math.min(limit, Math.sqrt(S * S + 2 * brakeAt(S) * brakeScale * SOFT * ds));
      if (j <= count) { hard[j] = H; soft[j] = S; }
    }

    // ---- forward: a virtual car leaves at the player's speed, stays flat out
    // while it can and otherwise follows the hard envelope. What it has to do
    // at each station is that station's colour.
    const reach = Math.max(25, v * 1.5);
    let u = Math.max(v, 1), coast = u;
    for (let k = 0; k < count; k++) {
      const d = k * ds - along;
      const Hn = hard[k + 1], Sn = soft[k + 1];
      const u2 = u * u, flat = accelAt(u), hi2 = u2 + 2 * flat * ds;
      const zone = clamp01((Hn - Sn) / GAP);
      let target;
      if (hi2 <= Sn * Sn) { target = 0; u = Math.sqrt(hi2); }
      else if (hi2 <= Hn * Hn) { u = Math.sqrt(hi2); target = zone * (u - Sn) / (Hn - Sn); }
      else {
        const need = (Hn * Hn - u2) / (2 * ds), brake = brakeAt(u) * brakeScale;
        const held = need >= 0 ? 0.5 * (1 - Math.min(1, need / Math.max(flat, 0.5)))
          : 0.5 + 0.5 * Math.min(1, -need / (RED_AT * brake));
        target = held + (1 - held) * zone;
        u = Math.max(Hn, Math.sqrt(Math.max(0, u2 - 2 * brake * ds)));
      }
      // That car sheds a small excess in a few metres nobody would see, so
      // wherever merely lifting still arrives over the limit soon: red.
      const over = coast / hard[k] - 1;
      if (over > 0 && d < reach) {
        target = Math.max(target, (0.5 + 0.5 * Math.min(1, over / OVER)) * (1 - smooth(0.6 * reach, reach, d)));
      }
      coast = Math.sqrt(Math.max(1, coast * coast - 2 * (0.8 + 0.00104 * coast * coast) * ds));
      soft[k] = target;  // this slot of the envelope is spent
    }

    // ---- write the ribbon
    const frame = ++this.frame;
    const sev = this.sev, stamp = this.stamp, pos = this.pos, tint = this.tint, lane = this.lane;
    const rise = Math.min(1, dt * 14), fall = Math.min(1, dt * 5);
    const far0 = length * 0.7, zones = mode === 'braking';
    const phase0 = (i0 * this.rep) % 1;
    for (let k = 0; k < count; k++) {
      const d = k * ds - along;
      const target = 0.25 * soft[k > 0 ? k - 1 : 0] + 0.5 * soft[k] + 0.25 * soft[k < count - 1 ? k + 1 : k];
      // Hysteresis: quick to warn, slower to clear, remembered per track
      // sample, so colour cannot chatter as speed hunts around a threshold.
      const idx = (i0 + k) % N;
      let s = stamp[idx] === frame - 1 ? sev[idx] : target;
      s += (target - s) * (target > s ? rise : fall);
      sev[idx] = s;
      stamp[idx] = frame;

      let alpha = this.show * smooth(NEAR_0, NEAR_1, d) * (1 - smooth(far0, length, d));
      if (zones) alpha *= smooth(0.14, 0.4, s);
      const a = s < 0.5 ? GREEN : YELLOW, b = s < 0.5 ? YELLOW : RED, t = s < 0.5 ? s * 2 : s * 2 - 1;

      // Both edges sit on sample idx's cross-section, where the road mesh has
      // its vertices, so the ribbon follows every crest.
      const sm = c.samples[idx], lp = c.line[idx];
      const w = HALF_W / Math.max(0.8, lp.t.x * sm.t.x + lp.t.z * sm.t.z);
      const y = c.heights[idx] + LIFT, o = k * 6, q = k * 8;
      pos[o] = lp.p.x + sm.n.x * w; pos[o + 1] = y; pos[o + 2] = lp.p.z + sm.n.z * w;
      pos[o + 3] = lp.p.x - sm.n.x * w; pos[o + 4] = y; pos[o + 5] = lp.p.z - sm.n.z * w;
      tint[q] = tint[q + 4] = a[0] + (b[0] - a[0]) * t;
      tint[q + 1] = tint[q + 5] = a[1] + (b[1] - a[1]) * t;
      tint[q + 2] = tint[q + 6] = a[2] + (b[2] - a[2]) * t;
      tint[q + 3] = tint[q + 7] = alpha;
      lane[k * 4 + 1] = lane[k * 4 + 3] = phase0 + k * this.rep;
    }
    const attributes = mesh.geometry.attributes;
    attributes.position.needsUpdate = attributes.tint.needsUpdate = attributes.lane.needsUpdate = true;
    mesh.geometry.setDrawRange(0, Math.max(0, count - 1) * 6);
    mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
    this.show = 0;
    this.frame++;  // colour memory must not survive a gap
  }

  dispose() {
    const mesh = this.mesh;
    if (!mesh) return;
    this.scene?.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.mesh = this.scene = this.circuit = null;
  }
}
