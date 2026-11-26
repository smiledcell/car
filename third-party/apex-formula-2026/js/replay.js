// APEX FORMULA 2026 — broadcast presentation: instant replay, director cameras,
// the start-gate showcase, the finish replay and photo mode.
//
// Observational only. The recorder reads the car meshes the renderer has just
// posed (never physics), playback runs only while the game's own pause or
// results state has the simulation stopped, and every borrowed transform, the
// camera and the sun are put back exactly. No session random stream is used:
// camera sway comes from a private fixed-seed table.
import * as THREE from 'three';
import { FIXED_DT } from './fixedStep.js';
import { createRandom } from './random.js';
import { resolveChaseCamera } from './cameraFraming.js';
import { cockpitFov, cockpitSeat } from './cockpit.js';

const HZ = 30;          // recording rate; playback interpolates
// Floats per car sample: x y z heading, body pitch roll bump, steer, glow opacity + green, shadow lobe x z turn.
const NF = 13;
const WK = ['fl', 'fr', 'rl', 'rr'];
const CAMS = ['AUTO', 'TV', 'KERB', 'HELI', 'ORBIT', 'CHASE', 'COCKPIT', 'T-CAM', 'NOSE'];
// Onboard mounts as in main.js: forward, height, look-ahead, look height, fov, fov per m/s.
const MOUNT = {
  COCKPIT: [0.43, 0, 22, 0.74, 0, 0], 'T-CAM': [-0.75, 1.62, 14, 1.05, 72, 0.045], NOSE: [2.3, 0.6, 18, 0.5, 75, 0.035],
};
const SPEEDS = [1, 0.5, 0.25];
const RAY_MAX = 2040;   // metres the line-of-sight probe can encode
const SKY_R = 2600;     // sky dome radius (main.js)
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), Q1 = new THREE.Quaternion();
const E1 = new THREE.Euler(0, 0, 0, 'YXZ');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => k * k * (3 - 2 * k);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const turnTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
// Signed lap distance in samples from i to j, in [-N/2, N/2).
const rel = (j, i, N) => ((j - i) % N + N * 1.5) % N - N / 2;

// The showcase and the automatic finish replay stand down for automation (the
// browser suites time the start gate and the results flow against the classic
// camera) and for ?showcase=0. ?showcase=1 forces them, for capture scripts.
function cinematics() {
  let q = null;
  try { q = new URLSearchParams(location.search).get('showcase'); } catch { /* no URL */ }
  return q === '1' || (q !== '0' && !navigator.webdriver);
}

function setBody(body, pitch, roll, bump) {
  if (body) { body.rotation.x = pitch; body.rotation.z = roll; body.position.y = bump; }
}

function setGlow(glows, on, opacity, green) {
  if (!glows?.length) return;
  for (let i = 0; i < glows.length; i++) glows[i].visible = on;
  const mat = glows[0].material;
  if (mat) { mat.opacity = opacity; if (mat.color) mat.color.g = green; }
}

// One-pixel depth render: distance to the first surface along a ray, in two
// bytes. It tests exactly the scenery the player sees.
const RAY_VS = `varying float vD;
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  p = modelViewMatrix * p;
  vD = -p.z;
  gl_Position = projectionMatrix * p;
}`;
const RAY_FS = `varying float vD;
void main() {
  float v = clamp(vD / ${RAY_MAX}.0, 0.0, 1.0) * 255.0;
  gl_FragColor = vec4(floor(v) / 255.0, fract(v), 0.0, 1.0);
}`;

export class ReplayDirector {
  constructor(game) {
    const g = this.g = game, trial = !!g.raceConfig?.trial;
    const n = this.n = g.session.entries.length + (trial ? 1 : 0);   // + the time-trial ghost
    const cap = this.cap = HZ * (trial ? 180 : 45);                   // a whole lap alone, 45 s of a field
    this.F = new Float32Array(cap * n * NF);
    this.S = new Float64Array(cap * n);   // wheel spin is unbounded: full precision
    this.B = new Uint8Array(cap * n);     // 1 visible, 2 rain light, 4 brake glow, 8 name tag, 16 captured
    this.tm = new Float64Array(cap);
    this.head = this.count = this.clock = 0;
    this.last = this.finishT = -1;
    // The live scene at the moment playback borrows it: same layout, full precision.
    this.F0 = new Float64Array(n * NF);
    this.S0 = new Float64Array(n);
    this.B0 = new Uint8Array(n);
    this.X = new Float64Array(NF);
    this.mode = null;                     // null | showcase | blend | replay | photo
    this.kind = '';                       // pause | results | finish
    this.auto = cinematics();
    this.keys = {};
    this.hold = this.cam = this.speed = this.sct = this.nt = 0;
    this.drag = -1;
    this.ti = null;
    this.focus = Math.max(0, g.session.entries.indexOf(g.session.focusEntry || g.session.player));
    for (const k of ['vel', 'aim', 'cpos', 'look', 'smo', 'kp', 'kd', 'pp', 'bp', 'c0p', 's0p', 's0t']) this[k] = new THREE.Vector3();
    this.bq = new THREE.Quaternion();
    this.c0q = new THREE.Quaternion();
    this.fr = {};
    this.fx = [];
    this.hid = [];
    const random = createRandom(0x5eedca3a);   // private: camera sway and placement variety only
    this.nz = Float32Array.from({ length: 64 }, () => random() * 2 - 1);
    try { this.rm = matchMedia('(prefers-reduced-motion: reduce)'); } catch { this.rm = null; }
    this.sunOff = g.sun ? g.sun.position.clone().sub(g.sun.target.position) : null;

    const o = { signal: (this.ac = new AbortController()).signal }, on = (type, fn) => addEventListener(type, fn, o);
    on('click', (e) => {
      const b = e.target.closest?.('[data-replay],[data-rp]');
      if (b?.dataset.replay) this.open(b.dataset.replay);
      else if (b) { this._act(b.dataset.rp, e); b.blur(); }
    });
    on('pointerdown', (e) => {
      const a = e.target.closest?.('[data-rp]')?.dataset.rp;
      this.hold = a === 'back' ? -1 : a === 'fwd' ? 1 : 0;
      if (!a && this.mode === 'photo') { this.drag = e.pointerId; this.lx = e.clientX; this.ly = e.clientY; }
    });
    on('pointermove', (e) => {
      if (this.drag !== e.pointerId || this.mode !== 'photo') return;
      const k = this.pf * Math.PI / 180 / innerHeight;    // one pixel of drag = one pixel of view
      this.py -= (e.clientX - this.lx) * k;
      this.px = clamp(this.px - (e.clientY - this.ly) * k, -1.5, 1.5);
      this.lx = e.clientX; this.ly = e.clientY;
    });
    const release = () => { this.hold = 0; this.drag = -1; };
    on('pointerup', release);
    on('pointercancel', release);
    on('blur', () => { release(); this.keys = {}; });
    addEventListener('wheel', (e) => {
      if (this.mode === 'photo') this.pf = clamp(this.pf * Math.exp(e.deltaY * 0.0012), 3, 110);
    }, { ...o, passive: true });
    document.body.classList.remove('rp-rec');
    document.body.classList.add('rp-ok');
  }

  /** True while the director, not the game, drives the camera. */
  get cameraActive() { return this.mode !== null; }

  // ---------- hooks called by main.js ----------

  /** Reached only while the simulation is live: the showcase hands the camera back here. */
  updateCamera(dt) {
    const g = this.g, cam = g.camera, P = (g.session.focusEntry || g.session.player)?.mesh.position, bp = this.bp;
    const swing = () => turnTo(Math.atan2(bp.x - P.x, bp.z - P.z), Math.atan2(cam.position.x - P.x, cam.position.z - P.z));
    if (this.mode === 'showcase' && !g.awaitingStart && P) {
      this.mode = 'blend';
      bp.copy(cam.position); this.bq.copy(cam.quaternion); this.bf = cam.fov;
      g.snapCamera();
      this.bk = 0;
      this.bd = 0.7 + Math.abs(swing()) * 0.16;   // a bigger swing takes a little longer
    }
    if (this.mode !== 'blend') return;
    this.bk += dt / this.bd;
    g.snapCamera();                       // the game's own chase pose is the target every frame...
    if (this.bk >= 1 || !P) { this.mode = null; return; }   // ...and the last frame is exactly that pose
    const k = ease(this.bk), a = Math.atan2(bp.x - P.x, bp.z - P.z) + swing() * k;
    const r = lerp(Math.hypot(bp.x - P.x, bp.z - P.z), Math.hypot(cam.position.x - P.x, cam.position.z - P.z), k);
    Q1.copy(cam.quaternion);
    cam.position.set(P.x + Math.sin(a) * r, lerp(bp.y, cam.position.y, k), P.z + Math.cos(a) * r);   // round the car, not through it
    cam.quaternion.copy(this.bq).slerp(Q1, k);
    cam.fov = lerp(this.bf, cam.fov, k);
    cam.updateProjectionMatrix();
    this._sun(P);
  }

  /** Once per rendered frame, after the simulation block. */
  frame(dt) {
    const g = this.g, st = g.state, was = this.pst, m = this.mode;
    this.pst = st;
    if (!g.session) return;
    const driving = st === 'race' || st === 'quali';
    if (m === 'replay' || m === 'photo') {
      // The game moved on underneath us (a wheel button resumed it, results arrived): let go quietly.
      if (this.kind === 'pause' ? !(driving && g.paused) : st !== 'results') this.close(true);
      else if (m === 'photo') this._photo(dt);
      else this._replay(dt);
      return;
    }
    if (driving && !g.paused && !g.awaitingStart) this._record();
    if (m === 'blend') return;
    const idle = driving && g.awaitingStart && !g.paused && !g.onboardingActive;
    if (m === 'showcase') {
      if (idle) this._showcase(dt);
      else if (!driving) this.mode = null;
    } else if (this.auto && !document.hidden && !this.rm?.matches) {
      if (idle) { this.mode = 'showcase'; this._showcase(dt); }
      else if (st === 'results' && was === 'race' && this.finishT > 0) this.open('finish');
    }
  }

  onKey(e, down) {
    const code = this.g.constructor.normalizeKey?.(e) || e.code, m = this.mode, on = m === 'replay' || m === 'photo';
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d/.test(code)) return on;   // browser shortcuts stay the browser's
    if (on) this.keys[code] = down;
    else if (!down || e.repeat || code !== 'KeyR' || !this.open('replay')) return false;
    e.preventDefault();
    if (!on || !down || e.repeat) return true;
    const go = code === 'Enter' || code === 'Space';
    if (go && performance.now() - this.opened < 300) return true;   // the key press that opened us
    if (code === 'Escape') this.close();
    else if (code === 'KeyH') this._act('hide');
    else if (m === 'photo') { if (go || code === 'KeyP') this._act('save'); }
    else if (code === 'KeyR' || code === 'Enter' || (go && this.kind === 'finish')) this.close();
    else if (go) this._act('play');
    else if (code === 'KeyS') this._act('speed');
    else if (code === 'KeyC') this._act('cam');
    else if (code === 'KeyF') this._act('car');
    else if (code === 'KeyP') this._act('photo');
    return true;
  }

  dispose() {
    this.close(true);
    this.mode = null;
    this.ac.abort();
    this.rt?.dispose();
    this.rmat?.dispose();
    document.body.classList.remove('rp-ok', 'rp-rec');
  }

  // ---------- recording and playback ----------

  _record() {
    const g = this.g, pc = g.pacing, j = this.head;
    this.clock += pc.simulatedDt;
    const t = this.clock + (pc.alpha - 1) * FIXED_DT;   // the instant the interpolated pose shows
    if (this.finishT < 0 && g.session.player?.finished) this.finishT = t;
    if (t < this.last + 1 / HZ - 1e-4) return;
    this.last = this.tm[j] = t;
    this._read(this.F, this.S, this.B, j);
    this.head = (j + 1) % this.cap;
    if (this.count < this.cap && ++this.count === HZ) document.body.classList.add('rp-rec');
  }

  /** Car group in slot i; the slot after the field is the time-trial ghost. */
  _mesh(i) {
    const e = this.g.session.entries[i];
    return e ? e.mesh : this.g.timeTrial?.ghost;
  }

  /** Copy what the renderer has posed into sample j. Reads meshes only; allocates nothing. */
  _read(F, S, B, j) {
    const es = this.g.session.entries, n = this.n;
    for (let i = 0; i < n; i++) {
      const e = es[i], m = this._mesh(i), q = j * n + i, o = q * NF;
      if (!m) { B[q] = 0; continue; }
      const body = e?.carHandle?.body, wheel = e?.wheels?.fl, lobe = e?.shadowLobe;
      const glow = e && m.userData.brakeGlows?.[0], rain = e && m.userData.rainLight, mat = glow && glow.material;
      F[o] = m.position.x; F[o + 1] = m.position.y; F[o + 2] = m.position.z; F[o + 3] = m.rotation.y;
      F[o + 4] = body ? body.rotation.x : 0; F[o + 5] = body ? body.rotation.z : 0; F[o + 6] = body ? body.position.y : 0;
      F[o + 7] = wheel ? wheel.rotation.y : 0;
      F[o + 8] = mat ? mat.opacity : 0; F[o + 9] = mat && mat.color ? mat.color.g : 0;
      F[o + 10] = lobe ? lobe.position.x : 0; F[o + 11] = lobe ? lobe.position.z : 0; F[o + 12] = lobe ? lobe.rotation.z : 0;
      S[q] = wheel ? wheel.rotation.x : 0;
      B[q] = 16 | (m.visible ? 1 : 0) | (!rain || rain.visible ? 2 : 0) | (glow && glow.visible ? 4 : 0)
        | (e && e.tag && e.tag.visible ? 8 : 0);
    }
  }

  /**
   * Pose every car from samples i0..i1 blended by a. span is the time between
   * them when playing the ring back; 0 restores the live snapshot exactly.
   */
  _write(F, S, B, i0, i1, a, span) {
    const es = this.g.session.entries, n = this.n, X = this.X, jump = (140 * span + 3) ** 2;
    for (let i = 0; i < n; i++) {
      const e = es[i], m = this._mesh(i), o = (i0 * n + i) * NF, p = (i1 * n + i) * NF;
      const dx = F[p] - F[o], dz = F[p + 2] - F[o + 2];
      const k = dx * dx + dz * dz > jump ? Math.round(a) : a;   // a teleport (pit release, recovery) never smears
      const bits = B[(k < 0.5 ? i0 : i1) * n + i];
      if (!m || !(bits & 16)) continue;
      for (let c = 0; c < NF; c++) {      // 3 and 12 are angles: take the short way round
        X[c] = c === 3 || c === 12 ? F[o + c] + turnTo(F[o + c], F[p + c]) * k : lerp(F[o + c], F[p + c], k);
      }
      m.position.set(X[0], X[1], X[2]);
      m.rotation.y = X[3];
      m.visible = (bits & 1) > 0;
      if (span && i === this.focus) this.vel.set(dx, 0, dz).multiplyScalar(k === a ? 1 / span : 0);
      if (!e) continue;
      // Everything race.js poses below the car group, on the full car and on its distant proxy.
      const far = e.carHandle?.farProxy, lobe = e.shadowLobe, ud = m.userData, spin = lerp(S[i0 * n + i], S[i1 * n + i], k);
      for (let w = 0; w < 4; w++) {
        const near = e.wheels?.[WK[w]], dist = far?.wheels?.[WK[w]];
        if (near) { near.rotation.x = spin; if (w < 2) near.rotation.y = X[7]; }
        if (dist) { dist.rotation.x = spin; if (w < 2) dist.rotation.y = X[7]; }
      }
      setBody(e.carHandle?.body, X[4], X[5], X[6]);
      setBody(far?.body, X[4], X[5], X[6]);
      if (lobe) { lobe.position.x = X[10]; lobe.position.z = X[11]; lobe.rotation.z = X[12]; }
      setGlow(ud.brakeGlows, (bits & 4) > 0, X[8], X[9]);
      setGlow(far?.brakeGlows, (bits & 4) > 0, X[8], X[9]);
      if (ud.rainLight) ud.rainLight.visible = (bits & 2) > 0;
      if (far?.rainLight) far.rainLight.visible = (bits & 2) > 0;
      if (e.tag) e.tag.visible = !span && (bits & 8) > 0;   // tags are laid out for the live chase camera only
    }
  }

  /** Bracket time t in the ring: samples i0/i1 and the blend between them. */
  _find(t) {
    const cap = this.cap, base = (this.head - this.count + cap) % cap, tm = this.tm;
    let lo = 0, hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tm[(base + mid) % cap] <= t) lo = mid; else hi = mid;
    }
    const i0 = this.i0 = (base + lo) % cap, i1 = this.i1 = (base + hi) % cap;
    this.span = Math.max(tm[i1] - tm[i0], 1e-6);
    this.a = clamp((t - tm[i0]) / this.span, 0, 1);
  }

  _pose(t) {
    this._find(t);
    this._write(this.F, this.S, this.B, this.i0, this.i1, this.a, this.span);
  }

  /** Recorded position of one car at any time: how the director looks into the future. */
  _at(i, t, out) {
    this._find(t);
    const F = this.F, o = (this.i0 * this.n + i) * NF, p = (this.i1 * this.n + i) * NF, a = this.a;
    return out.set(lerp(F[o], F[p], a), lerp(F[o + 1], F[p + 1], a), lerp(F[o + 2], F[p + 2], a));
  }

  /** Take the camera (and optionally the car meshes) from the live game, remembering it all exactly. */
  _borrow(meshes) {
    const g = this.g, s = g.session, cam = g.camera;
    this.c0p.copy(cam.position); this.c0q.copy(cam.quaternion); this.c0f = cam.fov; this.c0n = cam.near;
    if (g.sun) { this.s0p.copy(g.sun.position); this.s0t.copy(g.sun.target.position); }
    this.lod = s.carLodTelemetry?.mode;
    s.setCarLodMode?.('forced-full');     // a long lens fills the frame with cars the chase view left as proxies
    document.getElementById('hud')?.classList.add('rp-hide');
    this.held = meshes;
    if (!meshes) return;
    this._read(this.F0, this.S0, this.B0, 0);
    // Frozen sparks, smoke and rain belong to the paused instant, not to the past being shown.
    for (const o of g.scene.children) {
      if ((o.isPoints || o.isSprite) && o.visible && !g._celestialObjects?.includes(o)) { o.visible = false; this.fx.push(o); }
    }
  }

  _return() {
    const g = this.g, s = g.session, cam = g.camera;
    if (this.held) this._write(this.F0, this.S0, this.B0, 0, 0, 0, 0);
    for (const o of this.fx) o.visible = true;
    this.fx.length = 0;
    cam.position.copy(this.c0p); cam.quaternion.copy(this.c0q); cam.fov = this.c0f; cam.near = this.c0n;
    cam.updateProjectionMatrix();
    if (g.sun) { g.sun.position.copy(this.s0p); g.sun.target.position.copy(this.s0t); }
    s.setCarLodMode?.(this.lod === 'forced-full' ? this.lod : 'automatic');
    s.updateCarLod?.(cam);
    document.getElementById('hud')?.classList.remove('rp-hide');
  }

  // ---------- replay / photo lifecycle ----------

  /** what: 'replay' | 'photo' | 'finish'. Returns false when there is nothing to show. */
  open(what) {
    const g = this.g, st = g.state, driving = st === 'race' || st === 'quali', photo = what === 'photo';
    if (this.mode === 'replay' || this.mode === 'photo' || !g.session || g.onboardingActive) return false;
    if (photo ? !driving : !(driving || st === 'results') || g.awaitingStart || this.count < HZ) return false;
    if (this.mode === 'blend') g.snapCamera();
    this.mode = null;
    if (driving && !g.paused) g.togglePause(true);   // the game's own pause: sim, timers and audio stay as they are
    this.kind = driving ? 'pause' : what === 'finish' ? 'finish' : 'results';
    g.ui.hidePause();
    if (!driving) g.ui.screens.results.classList.remove('active');
    document.activeElement?.blur?.();
    this._borrow(!photo);
    this.opened = performance.now();
    this.keys = {};
    this.hold = 0;
    if (photo) { this._photoStart(false); return true; }
    const end = this.t1 = this.tm[(this.head - 1 + this.cap) % this.cap], clip = this.kind === 'finish';
    this.t0 = this.tm[(this.head - this.count + this.cap) % this.cap];
    const fin = this.finishT > this.t0 ? this.finishT : -1;
    this.tEnd = clip && fin > 0 ? Math.min(end, fin + 2.6) : end;
    this.t = this.tStart = Math.max(this.t0, this.kind === 'pause' || fin < 0 ? end - 12 : fin - (clip ? 4.5 : 7));
    this.mode = 'replay';
    this.playing = this.cut = true;
    this.speed = this.cam = this.tick = this.blind = 0;
    this.type = '';
    this.sk = this.mute = -1;
    if (!this.stn) this._stations();
    this._bar();
    this._replay(0);
    return true;
  }

  /** Leave replay/photo and restore the live scene. silent: leave the menus alone. */
  close(silent) {
    const g = this.g, m = this.mode;
    if (m !== 'replay' && m !== 'photo') return;
    if (m === 'photo' && this.fromReplay && !silent) {
      this.mode = 'replay'; this.fromReplay = false; this.cut = true; this.keys = {};
      this._bar();
      return;
    }
    this._return();
    this.mode = null;
    this.bar?.remove();
    this.bar = null;
    if (silent) return;
    if (this.kind === 'pause') g.ui.showPause();
    else g.ui.screens.results.classList.add('active');
  }

  _replay(dt) {
    const clip = this.kind === 'finish';
    let rate = (this.hold || (this.keys.ArrowRight ? 1 : 0) - (this.keys.ArrowLeft ? 1 : 0)) * 3;   // scrub
    if (!rate && this.playing) rate = SPEEDS[this.speed] * (clip && Math.abs(this.t - this.finishT) < 0.45 ? 0.4 : 1);
    this.t = clamp(this.t + dt * rate, this.t0, this.tEnd);
    if (rate > 0 && this.t >= this.tEnd) {
      if (clip) { this.close(); return; }
      this.playing = false;
    }
    this._pose(this.t);
    this._direct(dt, rate);
    this._barText();
  }

  _act(action, e) {
    if (action === 'exit') { this.close(); return; }
    if (action === 'play') {
      this.playing = !this.playing;
      if (this.playing && this.t >= this.tEnd - 0.05) { this.t = this.tStart; this.cut = true; }
    } else if (action === 'speed') this.speed = (this.speed + 1) % SPEEDS.length;
    else if (action === 'cam') { this.cam = (this.cam + 1) % CAMS.length; this.cut = true; }
    else if (action === 'car') {
      for (let k = 1, i = this.focus; k <= this.n; k++) {
        this.focus = (i + k) % this.n;
        if (this._mesh(this.focus)?.visible) break;
      }
      this.cut = true;
    } else if (action === 'seek') {
      const r = e.target.getBoundingClientRect();
      this.t = lerp(this.t0, this.tEnd, clamp((e.clientX - r.left) / r.width, 0, 1));
      this.cut = true;
    } else if (action === 'photo') this._photoStart(true);
    else if (action === 'hide') this.bar?.classList.toggle('rp-min');
    else if (action === 'save') this._save();
    else return;
    this.g.audio?.uiClick?.();
  }

  _bar() {
    let el = this.bar;
    if (!el) {
      el = this.bar = document.createElement('div');
      el.id = 'rp-bar';
      el.setAttribute('role', 'toolbar');
      (document.getElementById('ui-root') || document.body).appendChild(el);
    }
    const photo = this.mode === 'photo';
    const b = (a, label, text = '') => `<button type="button" data-rp="${a}" aria-label="${label}">${text}</button>`;
    el.className = '';
    el.setAttribute('aria-label', photo ? 'Photo mode' : 'Replay controls');
    el.innerHTML = photo
      ? `<b>PHOTO</b><span>WASD move · drag look · Q/E height · wheel zoom · Z/X roll</span>${
        b('save', 'Save PNG', 'SAVE PNG')}${b('hide', 'Hide interface', 'HIDE · H')}${b('exit', 'Leave photo mode', 'BACK')}`
      : `<b>REPLAY</b>${b('back', 'Rewind', '◀◀')}${b('play', 'Play or pause')}${b('fwd', 'Fast forward', '▶▶')
      }<div data-rp="seek"><i></i></div><span></span>${b('speed', 'Playback speed')}${b('cam', 'Next camera')
      }${b('car', 'Next car')}${b('photo', 'Photo mode', 'PHOTO')}${b('exit', 'Leave replay', this.kind === 'finish' ? 'SKIP' : 'EXIT')}`;
    this.stamp = '';
  }

  _barText() {
    const el = this.bar, code = this.g.session.entries[this.focus]?.driver?.code || 'GHOST';
    const cam = (this.cam ? '' : 'AUTO · ') + this.type + (this.type === 'TV' ? ` ${this.sk + 1}` : '');
    const stamp = `${this.playing ? '❚❚' : '▶'}|${(this.t - this.t1).toFixed(1)}s|${SPEEDS[this.speed]}×|${cam}|${code}`;
    if (!el || stamp === this.stamp) return;
    this.stamp = stamp;
    const text = stamp.split('|');
    el.querySelectorAll('[data-rp=play],span,[data-rp=speed],[data-rp=cam],[data-rp=car]').forEach((node, i) => {
      node.textContent = text[i];
    });
    el.querySelector('i').style.width = `${clamp((this.t - this.t0) / (this.tEnd - this.t0 || 1), 0, 1) * 100}%`;
  }

  // ---------- the director ----------

  /** Automatic running order. A function of replay time, so scrubbing shows the same edit. */
  _program(v) {
    if (this.kind === 'finish') {
      const d = this.t - this.finishT;
      return d < -2.2 ? 'TV' : d < 1.1 ? 'KERB' : 'HELI';
    }
    if (v < 5) return 'ORBIT';            // parked on the grid or in the box
    const u = this.t % 27;
    return u < 10 ? 'TV' : u < 13.5 ? (v > 22 ? 'KERB' : 'TV') : u < 20 ? 'TV' : u < 24 ? 'HELI' : 'T-CAM';
  }

  _direct(dt, rate) {
    const g = this.g, c = g.circuit, cam = g.camera, N = c.N, m = this._mesh(this.focus);
    if (!m) return;
    const P = m.position, h = m.rotation.y, fx = Math.sin(h), fz = Math.cos(h), vel = this.vel, v = vel.length();
    const C = this.cpos, T = this.look.set(P.x, P.y + 0.55, P.z);
    let cut = this.cut;
    this.cut = false;
    this.ti = c.nearestSample(P, cut ? null : this.ti);
    let type = CAMS[this.cam], k = -1, fov = 40, pan = 0, frac = 0, lo = 12, hi = 64, sway = 0.004;
    if (type === 'AUTO') type = this._program(v);
    if (type === 'KERB') {
      const spot = this._kerb(P, cut || this.type !== 'KERB');
      if (spot > 1) cut = true;
      if (!spot) type = 'TV';
    }
    if (type === 'TV') {
      const st = this.stn[k = this._tvPick()], muted = k === this.mute;
      const fresh = muted || cut || k !== this.sk || this.type !== 'TV';
      this.tick = (this.tick + 1) & 127;
      // Is the car really in shot? Checked on every cut, a few times a second on air, and every
      // couple of seconds while handed over. The ray sees scenery only, never traffic.
      if (st && (muted ? !this.tick : fresh || !(this.tick & 3))) {
        const was = st.ci, sees = () => this._ray(st.cand[st.ci], V2) > st.cand[st.ci].distanceTo(V2) - 2;
        V2.set(P.x, P.y + 0.6, P.z);
        let seen = sees();
        // Off air, the station steps in from its far tower to its near tower to its pole until one has the car.
        while (!seen && fresh && st.ci < st.cand.length - 1) { st.ci++; seen = sees(); }
        this.blind = seen ? 0 : fresh ? 2 : this.blind + 1;
        this.mute = this.blind > 1 ? k : -1;   // lost behind a gantry, a fence or a stand: hand over
        if (this.blind > 1) st.ci = fresh ? was : Math.min(was + 1, st.cand.length - 1);   // and stand closer next time
      } else if (!muted) this.mute = -1;
      if (!st || k === this.mute) { type = 'HELI'; k = -1; }
    }
    if (type !== this.type || k !== this.sk) cut = true;
    this.type = type;
    this.sk = k;
    if (type === 'TV') {
      C.copy(this.stn[k].cand[this.stn[k].ci]);
      T.x += fx * 1.2; T.z += fz * 1.2;
      frac = 0.25; lo = 1.7; hi = 38; pan = 9;
    } else if (type === 'KERB') {
      C.copy(this.kp);
      frac = 0.42; pan = 16; sway = 0.008;
    } else if (type === 'HELI') {
      const j = this.ti - Math.round(46 / c.ds), s = c.samples[(j % N + N) % N];
      V1.set(s.p.x, c.heightAt(j) + 23 + 3 * this._noise(this.nt * 0.11), s.p.z);   // over the road: clear air
      this._follow(V1, cut, 1.6, rate, dt);
      T.x += fx * 12; T.z += fz * 12;     // show the road it is heading into
      fov = 19; pan = 5; sway = 0.01;
    } else if (type === 'ORBIT') {
      if (cut) this.oa = h + 2.4;
      this.oa += dt * 0.42;               // wall clock: it keeps circling a frozen frame
      V1.set(P.x + Math.sin(this.oa) * 7.6, 0, P.z + Math.cos(this.oa) * 7.6);
      this._corridor(V1, 1, P);
      C.set(V1.x, P.y + 1.6 + 0.5 * Math.sin(this.oa * 0.5), V1.z);
      fov = 42;
    } else if (type === 'CHASE') {
      const fr = resolveChaseCamera(g.ui.settings.cameraProfile, v, false, this.fr);
      this._follow(V1.set(P.x - fx * fr.back, P.y + fr.height, P.z - fz * fr.back), cut, 6, rate, dt);
      T.set(P.x + fx * fr.look, P.y + this._rise(fr.look) + 0.75, P.z + fz * fr.look);
      fov = fr.fov; sway = 0;
    } else {
      const o = MOUNT[type], set = g.ui.settings, seat = type === 'COCKPIT';
      C.set(P.x + fx * o[0], P.y + (seat ? cockpitSeat(set.cockpitSeat) : o[1]), P.z + fz * o[0]);
      T.set(P.x + fx * o[2], P.y + this._rise(o[2]) + o[3], P.z + fz * o[2]);
      fov = (seat ? cockpitFov(set.cockpitFov) : o[4]) + v * o[5]; sway = 0;
    }
    if (frac) {                           // long lens: hold the car at a set share of the frame width
      const dx = P.x - C.x, dz = P.z - C.z, flat = Math.hypot(dx, dz) || 1, along = Math.abs(dx * fx + dz * fz) / flat;
      const width = 5.6 * Math.sqrt(Math.max(0, 1 - along * along)) + 2 * along;   // apparent car width, m
      fov = clamp(Math.atan(width / (2 * frac * Math.hypot(flat, P.y - C.y)) / cam.aspect) * 360 / Math.PI, lo, hi);
    }
    if (cut || !pan) { this.aim.copy(T); this.fov = fov; }
    else {
      const q = damp(pan, dt), lead = rate / pan;   // the lead cancels follow lag: any pan rate stays framed
      this.aim.x += (T.x + vel.x * lead - this.aim.x) * q;
      this.aim.y += (T.y - this.aim.y) * q;
      this.aim.z += (T.z + vel.z * lead - this.aim.z) * q;
      this.fov += (fov - this.fov) * damp(6, dt);
    }
    cam.position.copy(C);
    cam.fov = this.fov;
    cam.near = type === 'TV' || type === 'HELI' ? clamp(C.distanceTo(P) * 0.05, 0.3, 20) : 0.2;
    cam.updateProjectionMatrix();
    cam.lookAt(this.aim);
    if (sway && rate && !this.rm?.matches) {   // hand-held: a fixed share of the frame, whatever the lens
      const nt = (this.nt += dt), amp = sway * cam.fov * Math.PI / 180;
      cam.rotateY(amp * (this._noise(nt * 1.7) + 0.5 * this._noise(nt * 4.3 + 9)));
      cam.rotateX(amp * (this._noise(nt * 1.9 + 31) + 0.5 * this._noise(nt * 5.1 + 47)));
    }
    this._sun(P);
  }

  _noise(x) {
    const i = Math.floor(x), nz = this.nz;
    return lerp(nz[i & 63], nz[(i + 1) & 63], ease(x - i));
  }

  /** A smoothed camera body that travels with the car instead of trailing it. */
  _follow(to, cut, stiff, rate, dt) {
    if (cut) this.smo.copy(to);
    else this.smo.addScaledVector(this.vel, rate * dt).lerp(to, damp(stiff, dt));
    this.cpos.copy(this.smo);
  }

  _rise(ahead) {
    const c = this.g.circuit;
    return c.heightAt(this.ti + ahead / c.ds) - c.heightAt(this.ti);
  }

  _sun(P) {                               // shadows follow the featured car, as updateCamera does
    const sun = this.g.sun, o = this.sunOff;
    if (sun && o) { sun.target.position.copy(P); sun.position.set(P.x + o.x, P.y + o.y, P.z + o.z); }
  }

  /** Keep a camera point between the barriers: never through a wall, a stand or a building. */
  _corridor(v, margin, P) {
    const c = this.g.circuit, i = c.nearestSample(v, this.ti), s = c.samples[i];
    const lat = c.lateralAt(v, i), lim = Math.max(c.wallOff - margin, Math.abs(c.lateralAt(P, i)) + 3);
    if (Math.abs(lat) > lim) {
      const d = lat - Math.sign(lat) * lim;
      v.x -= s.n.x * d; v.z -= s.n.z * d;
    }
  }

  /** Kerb-level hero camera, set beside where the car is about to be. 0 none, 1 keep, 2 moved. */
  _kerb(P, fresh) {
    const c = this.g.circuit, kp = this.kp;
    const past = (P.x - kp.x) * this.kd.x + (P.z - kp.z) * this.kd.z;
    if (!fresh && this.kok && past < 45 && past > -200) return 1;
    const line = this.kind === 'finish' && this.t < this.finishT;   // the finish clip waits on the line itself
    const at = line ? this.finishT : this.t + Math.min(1.5, (this.t1 - this.t) * 0.7);
    this.kok = line || at - this.t > 0.35;
    if (!this.kok) return 0;
    this._at(this.focus, at, V1);
    const i = c.nearestSample(V1, c.nearestSample(V1, null)), s = c.samples[i];
    let lat = c.lateralAt(V1, i);
    if (Math.abs(lat) > c.wallOff - 3.4) { this.kok = false; return 0; }   // pit lane or against the wall: no room
    lat = (lat < 0 ? -1 : 1) * Math.max(c.halfWidth + 0.7, Math.abs(lat) + 2.4);
    kp.set(s.p.x + s.n.x * lat, V1.y + 0.3, s.p.z + s.n.z * lat);
    this.kd.copy(s.t);
    return 2;
  }

  // ---------- trackside TV cameras ----------

  /** Deterministic stations: one outside every corner, plus one every ~330 m of straight. */
  _stations() {
    const g = this.g, c = g.circuit, S = c.samples, N = c.N, ds = c.ds, wall = c.wallOff;
    const W = Math.max(2, Math.round(24 / ds)), span = Math.round(60 / ds);
    const turn = (i) => {                 // heading change across ~48 m; positive is a left-hander
      const a = S[(i - W + N) % N].t, b = S[(i + W) % N].t, n = S[i].n;
      return (b.x - a.x) * n.x + (b.z - a.z) * n.z;
    };
    const apex = [];
    for (let i = 0; i < N; i++) {
      const m = Math.abs(turn(i));
      let top = m >= 0.17;
      for (let k = 1; top && k <= span; k++) top = m >= Math.abs(turn((i + k) % N)) && m > Math.abs(turn((i - k + N) % N));
      if (top) apex.push(i);
    }
    if (!apex.length) apex.push(0);
    const all = [], every = Math.round(330 / ds);
    apex.forEach((a, k) => {
      const d = (apex[(k + 1) % apex.length] - a + N) % N || N, count = Math.max(1, Math.round(d / every));
      for (let j = 0; j < count; j++) all.push((a + Math.round(d * j / count)) % N);
    });
    all.sort((p, q) => p - q);
    const fog = g.scene.fog, reach = Math.min(380, fog ? fog.near + 0.3 * (fog.far - fog.near) : 380) / ds;
    const pit = c.pitLane?.samples || [];
    const pitGap = (p) => {
      let best = Infinity;
      for (let i = 0; i < pit.length; i += 3) best = Math.min(best, Math.hypot(p.x - pit[i].p.x, p.z - pit[i].p.z));
      return best;
    };
    this.stn = all.map((i, k) => {
      const prev = (i - all[(k - 1 + all.length) % all.length] + N) % N || N;
      const next = (all[(k + 1) % all.length] - i + N) % N || N;
      const tr = turn(i), corner = Math.abs(tr) >= 0.17, u = this.nz[(i * 13) & 63];
      let side = corner ? -Math.sign(tr) : k % 2 ? 1 : -1;        // the outside of the corner
      if (!corner && pitGap(S[i].p) < wall + 45) side = -(c.pitLane?.pitSide || 1);
      const s0 = S[(i + (corner ? Math.round(6 / ds) : 0)) % N], cand = [];
      // Towers 20 and 14 m back from the track edge, tall enough to clear a catch fence, then a pole just
      // inside the barrier, which is clear by construction. _direct() settles which one a station uses.
      for (const lat of [wall + 11, wall + 4.5, wall - 1.3]) {
        if (lat > 2 * wall - 0.5) continue;                       // past the verge the ground is not road level
        const p = new THREE.Vector3(s0.p.x + s0.n.x * side * lat, 0, s0.p.z + s0.n.z * side * lat);
        const j = c.nearestSample(p, c.nearestSample(p, null)), tower = lat > wall;
        // Another piece of track (a crossover, a hairpin's return leg) or the pit complex is in the way.
        if (Math.abs(rel(j, i, N)) * ds > lat + 14 || Math.hypot(p.x - S[j].p.x, p.z - S[j].p.z) < lat - 1.5
          || (tower && pitGap(p) < 24)) continue;
        p.y = c.heightAt(j) + (lat > wall + 8 ? 7.9 : tower ? 6.6 + 1.2 * Math.abs(u) : 5.4 + 0.9 * u);
        cand.push(p);
      }
      // Sectors tile the lap, each seeing more approach than departure; a station with no position has none.
      const on = cand.length ? 1 : -1;
      return { i, cand, ci: 0, back: on * Math.min(prev * 0.62, reach), fwd: on * Math.min(next * 0.38, reach * 0.8) };
    });
  }

  /** Station whose sector holds the featured car, or -1 when no camera has it. */
  _tvPick() {
    const N = this.g.circuit.N, stn = this.stn;
    for (let k = 0; k < stn.length; k++) {
      const st = stn[k], r = rel(this.ti, st.i, N), slack = k === this.sk && this.type === 'TV' ? 4 : 0;
      if (r >= -st.back - slack && r <= st.fwd + slack) return k;
    }
    return -1;
  }

  /** Distance (m) to the first rendered surface from `from` towards `to`; 0 if it cannot be measured. */
  _ray(from, to) {
    const g = this.g, r = g.renderer, sc = g.scene, hid = this.hid;
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(1, 1);
      this.rcam = new THREE.PerspectiveCamera(1, 1, 0.3, 4000);
      this.rmat = new THREE.ShaderMaterial({ side: THREE.DoubleSide, vertexShader: RAY_VS, fragmentShader: RAY_FS });
      this.rpx = new Uint8Array(4);
      this.rcol = new THREE.Color();
    }
    const bg = sc.background, om = sc.overrideMaterial, shadows = r.shadowMap.autoUpdate;
    const target = r.getRenderTarget(), alpha = r.getClearAlpha();
    r.getClearColor(this.rcol);
    this.rpx[0] = this.rpx[1] = 0;
    try {
      for (const o of sc.children) {      // particles and cars are not scenery
        if ((o.isPoints || o.isSprite || o.userData.carVariant) && o.visible) { o.visible = false; hid.push(o); }
      }
      this.rcam.position.copy(from);
      this.rcam.lookAt(to);
      sc.background = null; sc.overrideMaterial = this.rmat; r.shadowMap.autoUpdate = false;
      r.setRenderTarget(this.rt);
      r.setClearColor(0xffffff, 1);
      r.render(sc, this.rcam);
      r.readRenderTargetPixels(this.rt, 0, 0, 1, 1, this.rpx);
    } catch { /* context lost: report "cannot see" */ } finally {
      sc.background = bg; sc.overrideMaterial = om; r.shadowMap.autoUpdate = shadows;
      r.setRenderTarget(target);
      r.setClearColor(this.rcol, alpha);
      for (const o of hid) o.visible = true;
      hid.length = 0;
    }
    return (this.rpx[0] + this.rpx[1] / 255) / 255 * RAY_MAX;
  }

  // ---------- showcase (start gate) ----------

  _showcase(dt) {
    const g = this.g, cam = g.camera, m = (g.session.focusEntry || g.session.player)?.mesh;
    if (!m) return;
    const t = (this.sct += dt), P = m.position, k = 1 - ease(Math.min(1, t / 5));   // opening crane, settling into an orbit
    const a = m.rotation.y + 2.5 + t * 0.2, r = 7.4 + 1.5 * Math.sin(t * 0.23) + 7 * k;
    this.ti = g.circuit.nearestSample(P, this.ti);
    V1.set(P.x + Math.sin(a) * r, 0, P.z + Math.cos(a) * r);
    this._corridor(V1, 1.2, P);
    cam.position.set(V1.x, P.y + 2 + 0.5 * Math.sin(t * 0.17) + 5.5 * k, V1.z);
    cam.fov = 37 + 2 * Math.sin(t * 0.11);
    cam.updateProjectionMatrix();
    cam.lookAt(P.x, P.y + 0.6, P.z);
    this._sun(P);
  }

  // ---------- photo mode ----------

  _photoStart(fromReplay) {
    const cam = this.g.camera, m = this._mesh(this.focus);
    this.fromReplay = fromReplay;
    this.mode = 'photo';
    this.pp.copy(cam.position);
    this.pf = cam.fov;
    if (fromReplay && m && cam.fov < 25) {   // off a long lens: stand beside the car on the same line of sight
      this.pp.copy(m.position).addScaledVector(cam.getWorldDirection(V1), -9);
      this.pp.y += 1.4;
      this.pf = 40;
    }
    E1.setFromQuaternion(cam.quaternion);
    this.px = E1.x; this.py = E1.y; this.pr = 0;
    this.drag = -1;
    this._bar();
  }

  _photo(dt) {
    const g = this.g, cam = g.camera, K = this.keys, pp = this.pp;
    if (this.fromReplay) this._pose(this.t);
    const step = (K.ShiftLeft || K.ShiftRight ? 48 : 12) * Math.min(dt, 0.05);
    const fwd = (K.KeyW || K.ArrowUp ? 1 : 0) - (K.KeyS || K.ArrowDown ? 1 : 0);
    const side = (K.KeyD || K.ArrowRight ? 1 : 0) - (K.KeyA || K.ArrowLeft ? 1 : 0);
    const up = (K.KeyE ? 1 : 0) - (K.KeyQ ? 1 : 0);
    this.pr = clamp(this.pr + ((K.KeyX ? 1 : 0) - (K.KeyZ ? 1 : 0)) * dt * 0.7, -1.3, 1.3);
    if (fwd || side || up) {
      const sy = Math.sin(this.py), cy = Math.cos(this.py), sx = Math.sin(this.px), cx = Math.cos(this.px);
      pp.x += (cy * side - sy * cx * fwd) * step;
      pp.y += (sx * fwd + up) * step;
      pp.z += (-sy * side - cy * cx * fwd) * step;
      const far = pp.length(), c = g.circuit;
      if (far > SKY_R - 150) pp.multiplyScalar((SKY_R - 150) / far);   // stay inside the sky dome
      // ...and above whatever is underneath: probe the real surface, fall back to road level.
      const d = this._ray(V1.set(pp.x, pp.y + 1.2, pp.z), V2.set(pp.x, pp.y - 80, pp.z));
      pp.y = Math.max(pp.y, (d > 0 && d < 80 ? pp.y + 1.2 - d : c.heightAt(c.nearestSample(pp, null))) + 0.3);
    }
    cam.position.copy(pp);
    cam.quaternion.setFromEuler(E1.set(this.px, this.py, this.pr));
    cam.fov = this.pf;
    cam.near = 0.15;
    cam.updateProjectionMatrix();
  }

  /** Save the canvas as a PNG, entirely locally. */
  _save() {
    const g = this.g;
    // Render in this task: the drawing buffer is only guaranteed until the browser composites.
    if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera);
    g.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `apex-formula-${g.circuit?.id || 'photo'}-${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    }, 'image/png');
  }
}
