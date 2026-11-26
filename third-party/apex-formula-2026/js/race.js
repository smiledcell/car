// Race session: grid → lights → racing → chequered flag. Owns all 22 cars,
// timing, positions, pit stops, collisions, slipstream/dirty air, results.
import { BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, MeshBasicMaterial, Mesh, PlaneGeometry } from 'three';
import { CarPhysics, COMPOUNDS } from './physics.js';
import { AIDriver } from './ai.js';
import * as CAR from './car.js';
import { layoutNametags } from './nametags.js';
import { DRIVERS, TEAMS, POINTS } from './data.js';
import { fmtTime } from './format.js';
import { StrategyPlanner, chooseWeatherTyre, compoundFamily, normalizeForecast } from './strategy.js';
import {
  applyImpactDamage,
  applyRepairPlan,
  createVehicleHealth,
  damageSeverity,
  performanceModifiers,
  repairPlan,
  stepReliability,
} from './damage.js';
import { RaceControl } from './raceControl.js';
import { VEHICLE_DEFAULTS } from './vehicleDynamics.js';
import { PIT_BOX_STOP_WINDOW_M } from './pitLane.js';
import {
  applyContactVelocity,
  contactLongitudinalFor,
  contactSideFor,
  orientedCarContact,
  syncContactBody,
  velocityOf,
} from './contact.js';

// Preserve the established public race-module API for headless tooling while
// allowing menu code to import the tiny formatter without loading this module.
export { fmtTime } from './format.js';

const { buildCarMesh, buildNameTag } = CAR;

const teamById = Object.fromEntries(TEAMS.map(t => [t.id, t]));
const CONTACT_SLOP = 0.002;
const isInPits = entry =>
  !!entry?.phys?.corridor || !!(entry?.pitState && !entry.pitState.driven);
// Treat an above-limit car as actively correcting only when its measured
// deceleration projects a return to the limit within this horizon. This keeps
// the unavoidable braking tail out of the offence window without making a
// slow, pedal-free coast from a large excess free.
const PIT_SPEED_CORRECTION_HORIZON = 2;
// Hard ceiling on stationary time in the box, in seconds. A real stop is ~2.5 s;
// what made this feel long was the damaged/botched tail running to ~10 s while
// the player just watched. Repairs still cost time up to this bound.
const PIT_SERVICE_MAX = 5;
const STOP_AND_GO_SECONDS = 10;
const STOP_AND_GO_EQUIVALENT_SECONDS = 30;

/**
 * A network-driven car is kinematic: its pose belongs to the machine steering
 * it. Zeroing the inverse mass lets the local car be pushed off a rival without
 * the local solver dragging that rival somewhere its own owner never drove it.
 */
function applyNetworkMass(entries, bodies) {
  for (let i = 0; i < entries.length; i++) if (entries[i].netRemote) bodies[i].invMass = 0;
}

function solveContactPositions(session, entries, bodies, corrX, corrZ, passes = 8) {
  for (let iteration = 0; iteration < passes; iteration++) {
    corrX.fill(0);
    corrZ.fill(0);
    for (let i = 0; i < entries.length; i++) syncContactBody(bodies[i], entries[i].phys);
    applyNetworkMass(entries, bodies);
    let any = false;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].phys.disabled || entries[i].dnf) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].phys.disabled || entries[j].dnf) continue;
        // Hold-zone pit traffic is handled by spacing and limiter, not by the
        // open-road contact solver: packing 10 AI into a 12 m corridor under
        // the racing collision model freezes them short of their boxes. The
        // entry/exit BLENDS stay solid — a car merging at the pit exit is on
        // the racing surface and must not be a ghost.
        if (entries[i].phys.corridor?.isProtectedIdx(entries[i].phys.sampleIdx)
          || entries[j].phys.corridor?.isProtectedIdx(entries[j].phys.sampleIdx)) continue;
        const contact = orientedCarContact(bodies[i], bodies[j]);
        if (!contact || contact.penetration <= CONTACT_SLOP) continue;
        any = true;
        const invA = bodies[i].invMass;
        const invB = bodies[j].invMass;
        const invSum = invA + invB;
        // Two kinematic cars (both owned by other machines) have nothing to
        // solve here, and dividing by a zero mass sum would emit NaN positions.
        if (!(invSum > 0)) continue;
        const correction = Math.min(0.7, contact.penetration - CONTACT_SLOP);
        const moveA = Math.min(0.35, correction * invA / invSum);
        const moveB = Math.min(0.35, correction * invB / invSum);
        corrX[i] += contact.nx * moveA;
        corrZ[i] += contact.nz * moveA;
        corrX[j] -= contact.nx * moveB;
        corrZ[j] -= contact.nz * moveB;
      }
    }
    if (!any) break;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].netRemote) continue;
      entries[i].phys.pos.x += corrX[i];
      entries[i].phys.pos.z += corrZ[i];
      entries[i].phys.projectWallConstraint?.();
    }
  }
}

// Square canvas + fully-contained radius: the plane's own scale turns this into
// the ellipse, and alpha genuinely reaches 0 before the quad edge (the old
// 128x64 canvas clipped the gradient at ~0.3 alpha on its top/bottom edges,
// which drew a visible rectangle seam on the road).
// main.js parks the sun at (260,380,160) on every theme, so a cast shadow's
// ground direction is a world constant: away from the sun in plan view. The
// offset is height/tan(elevation) with elevation = atan(380/|(260,160)|) ~51deg,
// i.e. ~0.8x the car's ~1.1m body height, nudged up so the lobe reads.
const SUN_GROUND_AZI = Math.atan2(-260, -160);
const SUN_SHADOW_OFF = 1.15;
export const CAR_LOD_SPEC = Object.freeze({
  enterFarM: 55,
  returnFullM: 45,
  cadenceMs: 100,
  cadenceHz: 10,
  // (55 - 45) / 55 = 18.18%; reported explicitly for telemetry/validators.
  hysteresis: (55 - 45) / 55,
});
const RENDER_LINEAR_FIELDS = [
  'x', 'y', 'z', 'v', 'wheelSpin', 'steer', 'pitch', 'roll', 'rideBump',
];

export function clampRenderAlpha(alpha) {
  if (typeof alpha !== 'number' || Number.isNaN(alpha)) return 0;
  return Math.max(0, Math.min(1, alpha));
}

export function shortestAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Presentation-only brake-disc response. Actual thermal state remains owned by
// CarPhysics; keeping this pure also makes the visual curve deterministic and
// independently testable. A faint heat-soak afterglow remains when the driver
// releases the pedal instead of popping off on the next frame.
export function brakeGlowIntensity(brakeTemp, brake, speed) {
  const temp = Math.max(0, Math.min(1, (finiteOrZero(brakeTemp) - 300) / 700));
  const load = Math.max(0, Math.min(1, (finiteOrZero(brake) - 0.08) / 0.82));
  const airflow = Math.max(0, Math.min(1, (Math.abs(finiteOrZero(speed)) - 8) / 42));
  return temp * (0.26 + load * 0.74) * (0.68 + airflow * 0.32);
}

export function resolveCarLod(previous, distanceM, isPlayer = false, mode = 'automatic') {
  if (isPlayer || mode === 'forced-full') return 'full';
  const distance = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  if (previous === 'far') return distance <= CAR_LOD_SPEC.returnFullM ? 'full' : 'far';
  return distance >= CAR_LOD_SPEC.enterFarM ? 'far' : 'full';
}

function applyBrakeGlowState(glows, glow) {
  if (!glows?.length) return;
  const visible = glow > 0.025;
  for (const brakeGlow of glows) brakeGlow.visible = visible;
  const mat = glows[0]?.material;
  if (!mat) return;
  mat.opacity = 0.16 + glow * 0.84;
  // Discs transition from a deep ember to a restrained orange-yellow at peak
  // load; bloom can enhance it on higher tiers, but is not required.
  if (mat.color?.setRGB) mat.color.setRGB(1, 0.12 + glow * 0.42, 0.015);
}

export function interpolateRenderSnapshot(previous, current, alpha, out = {}) {
  const t = clampRenderAlpha(alpha);
  for (const field of RENDER_LINEAR_FIELDS) {
    out[field] = previous[field] + (current[field] - previous[field]) * t;
  }
  out.heading = previous.heading + shortestAngleDelta(previous.heading, current.heading) * t;
  return out;
}

function copyRenderSnapshot(source, target) {
  for (const field of RENDER_LINEAR_FIELDS) target[field] = source[field];
  target.heading = source.heading;
  return target;
}

function makeRenderSnapshot() {
  return {
    x: 0, y: 0, z: 0, heading: 0, v: 0,
    wheelSpin: 0, steer: 0, pitch: 0, roll: 0, rideBump: 0,
  };
}

function radialShadowTex(stops) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  for (const [t, a] of stops) grad.addColorStop(t, `rgba(0,0,0,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.userData.shared = true;
  return tex;
}

// Shared soft contact shadow: one wide blob under the floor plus a STRONGER,
// tighter darkening patch directly beneath each tyre. Unconditional on every
// car (both car-mesh generations, race and quali, near or far) and independent
// of the directional shadow map — the certified grid hero shot showed cars with
// zero contact darkening because the shadow map did not span the grid. The
// per-wheel patches sit a hair above the body blob and draw after it, so the
// two multiply into >=20% darkening at each contact patch even where the blob
// alone has faded out. Exported for the car render harness.
let _shadowTex = null, _wheelShadowTex = null;
function fannedShadowGeometry(fans) {
  if (fans <= 1) return new PlaneGeometry(3.6, 7.0);
  const positions = [], normals = [], uvs = [];
  for (let fan = 0; fan < fans; fan++) {
    const offset = (fan - (fans - 1) / 2) * 0.14;
    const g = new PlaneGeometry(3.25, 6.5).toNonIndexed();
    g.rotateZ(offset);
    g.translate(Math.sin(offset) * 0.52, Math.cos(offset) * 0.22, 0);
    positions.push(...g.attributes.position.array);
    normals.push(...g.attributes.normal.array);
    uvs.push(...g.attributes.uv.array);
    g.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return merged;
}

export function makeContactShadow(shadowFans = 1) {
  const fans = Math.max(1, Math.min(6, Math.round(shadowFans) || 1));
  if (!_shadowTex) {
    _shadowTex = radialShadowTex([[0, 0.5], [0.55, 0.3], [1, 0]]);
    _wheelShadowTex = radialShadowTex([[0, 0.68], [0.4, 0.58], [0.75, 0.34], [1, 0]]);
  }
  const grp = new Group();
  grp.name = 'contactShadow';
  // long axis along the CAR's long axis (+z): the old 6.2 x 3.1 plane was
  // transposed, so it faded to nothing exactly at the axles (z = +-1.6) while
  // spilling 3m sideways — it read as a dark quad on the grass when riding a
  // kerb, and left no darkening under any tyre in the certified grid shot.
  // 2.5 x 5.9 keeps a ~0.3m soft fade past the real ~1.91m-wide footprint
  // (the width the env harness measured as zero detached-on-grass pixels).
  const blob = new Mesh(
    new PlaneGeometry(2.5, 5.9),
    new MeshBasicMaterial({ map: _shadowTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 0;
  // Sun-cast lobe. Round-4 cars major: "no directional cast shadow from any of
  // the 22 cars — the cars read as decals pasted onto the asphalt." The sun is
  // parked at (260,380,160) on every theme, so the ground direction of a cast
  // shadow is a world constant; this lobe is that shadow, kept in the group's
  // LOCAL space by counter-rotating with the car's heading each frame (see
  // updateShadowLobe). Wider and softer than the body blob so it reads as a
  // cast shadow rather than a second contact patch.
  const lobe = new Mesh(
    fannedShadowGeometry(fans),
    new MeshBasicMaterial({
      map: _shadowTex, transparent: true,
      opacity: fans > 1 ? Math.max(0.14, 0.58 / fans) : 0.55,
      depthWrite: false,
    }));
  lobe.rotation.x = -Math.PI / 2;
  lobe.renderOrder = -1;        // under the contact patches
  lobe.name = 'sunShadowLobe';
  lobe.userData.shadowFans = fans;
  grp.add(lobe);
  grp.add(blob);
  // wheel centres in car space are (±0.82, 1.55) front / (±0.85, -1.60) rear on
  // BOTH car generations; the group itself is parked at (0, 0.028, -0.05), so
  // local z compensates that -0.05.
  for (const [wx, wz] of [[-0.82, 1.60], [0.82, 1.60], [-0.85, -1.55], [0.85, -1.55]]) {
    const patch = new Mesh(
      new PlaneGeometry(1.25, 1.0),
      new MeshBasicMaterial({ map: _wheelShadowTex, transparent: true, depthWrite: false }));
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(wx, 0.004, wz);
    patch.renderOrder = 1;
    patch.name = 'wheelContactShadow';
    grp.add(patch);
  }
  return grp;
}

export class RaceSession {
  /**
   * opts: { scene, circuit, playerDriverId, laps, difficulty(0..2), assists,
   *         mode: 'race'|'quali', gridOrder: [driverId]|null, onMessage(text,color,meta),
   *         onPitLimiter(enabled),
   *         random: function|null, seed: any }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.circuit = opts.circuit;
    this.mode = opts.mode || 'race';
    this.laps = Math.max(1, opts.laps || 5);
    this.difficulty = opts.difficulty ?? 1;
    this.onMessage = opts.onMessage || (() => {});
    this.onPitLimiter = opts.onPitLimiter;
    this.playerDriverId = opts.playerDriverId;
    this.trial = !!opts.trial;
    this.random = opts.random || (() => Math.random());
    this.seed = opts.seed;

    // ---- private multiplayer ----
    // 'host' owns the phase, the AI and the classification; 'guest' renders the
    // host's world and simulates only the car its player is steering. A null
    // role is the established single-player session, unchanged.
    this.netRole = opts.netRole === 'host' || opts.netRole === 'guest' ? opts.netRole : null;
    this.netRemoteDrivers = new Set(
      Array.isArray(opts.remoteDriverIds) ? opts.remoteDriverIds.filter(Boolean) : [],
    );
    this.netResults = null;

    this.phase = opts.formationLap ? 'formation' : 'grid';
    this.phaseT = 0;
    // constant hazard ≈ 2 mechanical DNFs across the field over a full 90-min GP,
    // proportionally fewer in short races (mechanical stress scales with distance)
    this._dnfRate = 0.000017;
    this.lightsOn = 0;
    this.lightsHold = 0;
    this.raceTime = 0;
    this.fastestLap = null;    // {driverId, time}
    this.results = null;
    this.jumpStart = false;
    this.hasForecast = opts.forecast !== undefined && opts.forecast !== null;
    this.forecast = typeof opts.forecast === 'function'
      ? opts.forecast
      : (lap) => Array.isArray(opts.forecast)
        ? (opts.forecast[Math.min(opts.forecast.length - 1, Math.max(0, lap))] || {})
        : (opts.forecast || {});
    this.conditions = normalizeForecast(Object.assign({}, this.forecast(0), {
      wetness: opts.wetness ?? this.forecast(0)?.wetness,
      trackGrip: opts.trackGrip ?? this.forecast(0)?.trackGrip,
    }));
    this.startProcedure = {
      formationEnabled: !!opts.formationLap,
      state: opts.formationLap ? 'formation' : 'grid',
      lapStarted: false,
      lapComplete: false,
      formationElapsed: 0,
      formationDistance: 0,
      launchMap: opts.launchMap || 'normal',
    };
    this._posTimer = 0;
    this._activeContacts = new Set();
    this._impactingContacts = new Set();
    this._wallEvent = 0;
    this._touchEvent = 0;

    // ---- race direction ----
    this.vsc = {
      active: false,
      timeLeft: 0,
      cycle: 0,
      deployEventKey: '',
      greenEventKey: '',
    };                                          // virtual safety car
    this.blueFlagFor = null;    // driverId being shown blue flags (player only)
    this.radioQueue = [];       // {text, tone, eventKey?} — HUD consumes by shifting
    this._radioCool = 0;        // contextual engineer radio: max 1 per 12s
    this._vscEnding = false;
    this._vscViol = 0;          // player VSC over-speed time accumulator
    this._vscPenalised = false;
    this._vscWarned = false;
    this.raceControl = new RaceControl({
      random: this.random,
      onEvent: (event) => this._onRaceControlEvent(event),
    });

    const c = this.circuit;
    this.entries = [];
    this.focusEntry = null;
    this._renderDisposed = false;
    this._carLodMode = 'automatic';
    this._carLodNextAt = -Infinity;
    this._carLodLastAt = -Infinity;
    this._carLodUpdates = 0;
    this._carLodSwitches = 0;
    this._carLodInitialized = false;

    if (this.mode === 'quali' || this.mode === 'practice') {
      this._buildQuali(opts);
      this.resetRenderState();
      return;
    }

    // ---- grid order ----
    let order = opts.gridOrder;
    if (!order) {
      const scored = DRIVERS.map((driver) => ({
        driver,
        score: teamById[driver.team].perf * (0.7 + 0.3 * driver.pace) +
          (this.random() - 0.5) * 0.012,
      }));
      order = scored.sort((a, b) => b.score - a.score).map(({ driver }) => driver.id);
    }

    // ---- build cars ----
    order.forEach((driverId, gi) => {
      const driver = DRIVERS.find(d => d.id === driverId);
      const team = teamById[driver.team];
      const isPlayer = driverId === this.playerDriverId;
      // A network-driven car has no local controller: its pose arrives from the
      // machine that owns it. On a guest that is every car except its own,
      // because the host also owns the AI.
      const netRemote = !isPlayer &&
        (this.netRemoteDrivers.has(driverId) || this.netRole === 'guest');
      // AI always run full assists (their controller expects auto shifting)
      const phys = new CarPhysics(c, {
        perf: team.perf, isPlayer,
        assists: isPlayer ? opts.assists : { tc: true, abs: true, autoGear: true },
        random: this.random,
      });
      phys.fuelBurnPerMeter = 1 / (this.laps * c.length * 1.06);
      const slot = c.gridSlots[gi];
      phys.placeAt(slot.pos, slot.heading, slot.idx);
      const carHandle = buildCarMesh(team, driver);
      // Standalone/hero cars retain the established body+wheel hierarchy and no
      // proxy allocation. Only non-player race entries opt into distant detail.
      if (!isPlayer) CAR.attachDistantCarProxy?.(carHandle);
      const { group, wheels, wheelRadius } = carHandle;
      group.position.copy(slot.pos);
      group.rotation.y = slot.heading;
      this.scene.add(group);
      const blob = makeContactShadow(c.group.userData.lightingRig?.shadowFans || 1);
      blob.position.set(0, 0.028, -0.05);
      group.add(blob);
      const tag = buildNameTag(driver, team);
      tag.position.y = 1.6;
      tag.visible = false;
      group.add(tag);

      // Each car owns a deterministic planner. Forecast input is optional and
      // dry-safe, so legacy sessions reproduce the established compounds.
      const strategy = new StrategyPlanner({
        random: this.random,
        totalLaps: this.laps,
        aggression: 0.35 + (driver.racecraft ?? driver.pace ?? 0.8) * 0.5,
        forecast: (lap) => this.getForecast(lap),
      });
      const requestedStart = strategy.chooseStartCompound(gi + 1);
      const startC = physicalCompound(requestedStart);
      phys.setTyre(startC);
      if (CAR.setTyreCompound) CAR.setTyreCompound(carHandle, startC);
      let plannedPitLap = -1, plannedNext = null;
      if (this.laps >= 12 && compoundFamily(startC) === 'dry') {
        plannedPitLap = Math.max(3, Math.round(this.laps * (0.42 + this.random() * 0.2)));
        plannedNext = startC === 'S' ? (this.random() < 0.6 ? 'M' : 'H') : startC === 'M' ? 'H' : 'M';
      }

      this.entries.push({
        driver, team, phys, isPlayer, carHandle, netRemote,
        netPose: null, netPit: false,
        ai: (isPlayer || netRemote) ? null : new AIDriver(phys, c, driver, this.difficulty, this.random),
        mesh: group, wheels, wheelRadius, tag, contactShadow: blob, lodLevel: 'full',
        shadowLobe: blob.getObjectByName('sunShadowLobe'),
        lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, lapTimes: [],
        position: gi + 1, gridPos: gi + 1, gapText: '', intervalText: '',
        pitStops: 0, pitState: null, plannedPitLap, plannedNext, boxThisLap: false,
        strategy, strategyDecision: null, strategyCompound: startC,
        damage: createVehicleHealth(), reliabilityWarning: null,
        finished: false, finishTime: 0, dnf: false, wheelSpin: 0,
        // ---- race-direction / timing detail (read by the HUD) ----
        sectors: [null, null, null],      // live current-lap sector times
        lastSectors: [null, null, null],  // previous completed lap
        bestSectors: [null, null, null],  // session minima
        tyreAgeLaps: 0,
        penaltySeconds: 0,
        positionsGained: 0,
        wingDamage: 0,
        trackLimits: 0,
        _secStage: 0, _secSplit: [null, null], _offAcc: 0, _offLatched: false,
        _blueFrom: null, _blueT: 0, _contactCool: 0,
      _wallDamageCool: 0, _carDamageCool: 0,
      });
    });
    this.player = this.entries.find(e => e.isPlayer) || null;
    this.focusEntry = this.player;
    // AI cars need their entry so the shared pit-lane mode can see box/pitState.
    for (const e of this.entries) if (e.ai) e.ai.entry = e;
    this.resetRenderState();
  }

  _buildQuali(opts) {
    const c = this.circuit;
    const driver = DRIVERS.find(d => d.id === this.playerDriverId);
    const team = teamById[driver.team];
    const phys = new CarPhysics(c, {
      perf: team.perf, isPlayer: true, assists: opts.assists, random: this.random,
    });
    phys.fuelBurnPerMeter = 0; phys.fuel = 0.12;
    phys.setTyre('S');
    const startIdx = (c.N - Math.round(140 / c.ds)) % c.N;
    const s = c.samples[startIdx];
    phys.placeAt(s.p.clone(), Math.atan2(s.t.x, s.t.z), startIdx);
    // Browser sessions now wait behind an explicit start gate. The player must
    // also be physically stationary there; a hidden 46m/s initial velocity was
    // launching FP1 before any input and sending the car off the curved straight.
    phys.v = 0;
    phys.gear = 1;
    const carHandle = buildCarMesh(team, driver);
    const { group, wheels, wheelRadius } = carHandle;
    if (CAR.setTyreCompound) CAR.setTyreCompound(carHandle, 'S');
    this.scene.add(group);
    const blob = makeContactShadow(c.group.userData.lightingRig?.shadowFans || 1);
    blob.position.set(0, 0.028, -0.05);
    group.add(blob);
    this.entries = [{
      driver, team, phys, isPlayer: true, ai: null, carHandle,
      mesh: group, wheels, wheelRadius, tag: null, contactShadow: blob, lodLevel: 'full',
      shadowLobe: blob.getObjectByName('sunShadowLobe'),
      lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, lapTimes: [],
      position: 1, gridPos: 1, gapText: '', intervalText: '',
      pitStops: 0, pitState: null, boxThisLap: false,
      strategy: new StrategyPlanner({ random: this.random, totalLaps: this.laps, forecast: (lap) => this.getForecast(lap) }),
      strategyDecision: null, strategyCompound: 'S',
      damage: createVehicleHealth(), reliabilityWarning: null,
      finished: false, finishTime: 0, dnf: false, wheelSpin: 0,
      sectors: [null, null, null],
      lastSectors: [null, null, null],
      bestSectors: [null, null, null],
      tyreAgeLaps: 0,
      penaltySeconds: 0,
      positionsGained: 0,
      wingDamage: 0,
      trackLimits: 0,
      _secStage: 0, _secSplit: [null, null], _offAcc: 0, _offLatched: false,
      _blueFrom: null, _blueT: 0, _contactCool: 0,
      _wallDamageCool: 0, _carDamageCool: 0,
    }];
    // Time trial deliberately remains a single clear-track car. A normal
    // qualifying/practice session now runs every rival through the same
    // CarPhysics + AIDriver loop, so their laps are earned rather than sampled.
    if (!this.trial) {
      const rivals = DRIVERS.filter(d => d.id !== this.playerDriverId);
      rivals.forEach((rival, ri) => {
        const rivalTeam = teamById[rival.team];
        const rp = new CarPhysics(c, {
          perf: rivalTeam.perf, isPlayer: false,
          assists: { tc: true, abs: true, autoGear: true }, random: this.random,
        });
        rp.fuelBurnPerMeter = 0;
        rp.fuel = 0.12;
        rp.setTyre('S');
        // Stagger cars around the lap with >100m average separation. Every AI
        // must cross S/F and then complete a real flying lap.
        const idx = Math.round(((ri + 1) / (rivals.length + 1)) * c.N) % c.N;
        const sm = c.samples[idx];
        rp.placeAt(sm.p.clone(), Math.atan2(sm.t.x, sm.t.z), idx);
        rp.v = 42;
        rp.gear = 5;
        const handle = buildCarMesh(rivalTeam, rival);
        CAR.attachDistantCarProxy?.(handle);
        const shadow = makeContactShadow(c.group.userData.lightingRig?.shadowFans || 1);
        shadow.position.set(0, 0.028, -0.05);
        handle.group.add(shadow);
        if (CAR.setTyreCompound) CAR.setTyreCompound(handle, 'S');
        this.scene.add(handle.group);
        this.entries.push({
          driver: rival, team: rivalTeam, phys: rp, isPlayer: false,
          ai: new AIDriver(rp, c, rival, this.difficulty, this.random), carHandle: handle,
          mesh: handle.group, wheels: handle.wheels, wheelRadius: handle.wheelRadius,
          tag: null, contactShadow: shadow, lodLevel: 'full',
          shadowLobe: shadow.getObjectByName('sunShadowLobe'),
          lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, lapTimes: [],
          position: ri + 2, gridPos: ri + 2, gapText: '', intervalText: '',
          pitStops: 0, pitState: null, boxThisLap: false,
          strategy: new StrategyPlanner({ random: this.random, totalLaps: this.laps, forecast: (lap) => this.getForecast(lap) }),
          strategyDecision: null, strategyCompound: 'S',
          damage: createVehicleHealth(), reliabilityWarning: null,
          finished: false, finishTime: 0, dnf: false, wheelSpin: 0,
          sectors: [null, null, null], lastSectors: [null, null, null], bestSectors: [null, null, null],
          tyreAgeLaps: 0, penaltySeconds: 0, positionsGained: 0, wingDamage: 0, trackLimits: 0,
          _secStage: 0, _secSplit: [null, null], _offAcc: 0, _offLatched: false,
          _blueFrom: null, _blueT: 0, _contactCool: 0, _wallDamageCool: 0, _carDamageCool: 0,
        });
      });
    }
    this.player = this.entries[0];
    this.focusEntry = this.player;
    this.phase = 'racing';
    // Practice uses the same physical out-lap / flying-lap lifecycle as
    // qualifying. The mode only changes how the completed classification is
    // presented by the game shell.
    this.qualiState = 'outlap';
    this.qualiTime = null;
    this.aiQualiTimes = [];
    this.qualifying = {
      stage: opts.qualiStage || 'Q1',
      format: opts.qualiFormat || 'full',
      eliminated: [],
      stageResults: {},
    };
  }

  // Legacy alias: penalties are now per-entry, but callers still read/write the
  // player's total through this property.
  get playerPenalty() { return this.player ? this.player.penaltySeconds : 0; }
  set playerPenalty(v) {
    if (this.player) this.player.penaltySeconds = Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  getForecast(lap = this.player?.lap || 0) {
    if (!this.hasForecast) return { ...this.conditions };
    return normalizeForecast(this.forecast(Math.max(0, lap)) || this.conditions);
  }

  setTrackConditions(next = {}) {
    this.conditions = normalizeForecast(Object.assign({}, this.conditions, next));
    return { ...this.conditions };
  }

  /** Public offline integration hook for incident directors and scripted races. */
  requestRaceControl(kind, options = {}) {
    return this.raceControl.deploy(kind, options);
  }

  resumeRace(options = {}) { return this.raceControl.resume(options); }

  startFormation() {
    if (this.mode !== 'race' || (this.phase !== 'grid' && this.phase !== 'formation')) return false;
    this.phase = 'formation';
    this.phaseT = 0;
    this.startProcedure.formationEnabled = true;
    this.startProcedure.state = 'formation';
    this.startProcedure.lapStarted = false;
    this.startProcedure.lapComplete = false;
    this.startProcedure.formationElapsed = 0;
    this.startProcedure.formationDistance = 0;
    for (const e of this.entries) if (e.ai) { e.ai.vscFactor = 0.45; e.ai.noOvertake = true; }
    this.onMessage('FORMATION LAP', 'yellow', { eventKey: 'start:formation' });
    return true;
  }

  completeFormation() {
    if (this.phase !== 'formation') return false;
    const c = this.circuit;
    this.startProcedure.formationElapsed = this.phaseT;
    this.startProcedure.formationDistance = Math.max(0, this.player?.phys?.totalDist || 0);
    this.entries.forEach((e, i) => {
      const slot = c.gridSlots[e.gridPos - 1] || c.gridSlots[i];
      e.phys.placeAt(slot.pos, slot.heading, slot.idx);
      e.mesh.visible = true;
      e.phys.disabled = false;
      if (e.ai) { e.ai.vscFactor = 1; e.ai.noOvertake = false; }
    });
    this.resetRenderState();
    this.phase = 'grid';
    this.phaseT = 0;
    this.startProcedure.lapComplete = true;
    this.startProcedure.state = 'grid';
    this.onMessage('GRID SET — START PROCEDURE', '', { eventKey: 'start:grid-set' });
    return true;
  }

  /** Queue an engineer radio line. Contextual chatter is gated to 1 per 12s;
   *  mandated race-control calls pass force=true. */
  _radio(text, tone = 'info', force = false, meta = null) {
    if (!force && this._radioCool > 0) return false;
    this._radioCool = 12;
    const item = { text, tone };
    if (meta && typeof meta.eventKey === 'string' && meta.eventKey) item.eventKey = meta.eventKey;
    this.radioQueue.push(item);
    // the HUD drains this by shifting; cap it so a headless session can't grow
    while (this.radioQueue.length > 16) this.radioQueue.shift();
    return true;
  }

  // ======== update ========
  update(dt, playerInput) {
    if (this._renderDisposed) return;
    this._beginRenderTick();
    dt = Math.min(dt, 1 / 25);
    const c = this.circuit;
    this.phaseT += dt;

    // A guest never runs the start procedure: the host's lights are the only
    // lights, and two independently drifting countdowns would put the cars on
    // track at different moments.
    if (this.netRole === 'guest') {
      // no local phase advance
    } else if (this.phase === 'formation' && !this.startProcedure.formationEnabled) {
      this.completeFormation();
    } else if (this.phase === 'grid') {
      if (this.phaseT > 2.6) { this.phase = 'lights'; this.phaseT = 0; this.lightsOn = 0; this.lightsHold = 0.5 + this.random(); }
    } else if (this.phase === 'lights') {
      const want = Math.min(5, Math.floor(this.phaseT / 0.9) + 1);
      if (want > this.lightsOn) { this.lightsOn = want; this._lightEvent = true; }
      // jump start check
      if (this.player && this.player.phys.v > 0.6) this.jumpStart = true;
      if (this.lightsOn >= 5 && this.phaseT > 5 * 0.9 + this.lightsHold) {
        this.phase = 'racing'; this.phaseT = 0; this.lightsOut = true;
        this.raceTime = 0;
        for (const e of this.entries) e.lapStart = 0;
        if (this.jumpStart) {
          if (this.player) this.player.penaltySeconds += 5;
          this.onMessage('JUMP START — +5s PENALTY', 'red');
          this._radio('Jump start — that is a five second penalty.', 'warning', true);
        }
      }
    }

    const racing = this.phase === 'racing' || this.phase === 'finished';
    if (racing) this.raceTime += dt;
    if (this._radioCool > 0) this._radioCool = Math.max(0, this._radioCool - dt);

    // ---- race direction: virtual safety car ----
    // The VSC is a seeded random event evaluated per machine. In a private
    // multiplayer race that would deploy on one screen and not the other, so
    // the whole subsystem stays out of networked sessions.
    if (this.mode === 'race' && !this.netRole) this._updateVSC(dt);

    // ---- aero interactions (slipstream / dirty air) ----
    if (this.mode === 'race') this._aeroInteractions();
    // a damaged front wing costs downforce for the rest of the lap; the existing
    // physics turns a dirtyAir floor into exactly that grip loss
    for (const e of this.entries) {
      if (e.wingDamage > 0) e.phys.dirtyAir = Math.max(e.phys.dirtyAir, 0.6);
    }

    // ---- step cars ----
    const liveDrive = this.phase === 'racing' || this.phase === 'finished' || this.phase === 'formation';
    const allPhys = this.entries.map(x => x.phys);
    let formationCompleteAfterStep = false;
    for (const e of this.entries) {
      if (e.netRemote) { this._stepNetworkEntry(e, dt); continue; }
      if (e.dnf) continue;
      // Scripted force-completion / legacy AI timer stops still freeze physics.
      // Driven stops (player and AI pit mode) keep CarPhysics live.
      if (e.pitState && !e.pitState.driven && Number.isFinite(e.pitState.phaseT)) {
        this._updatePit(e, dt);
        this._advanceWheelSpin(e, dt);
        continue;
      }
      if (e.pitState && !e.pitState.driven && (!Number.isFinite(e.pitState.phaseT) || !Number.isFinite(e.pitState.entrySeconds))) {
        this._updatePit(e, dt);
        this._advanceWheelSpin(e, dt);
        continue;
      }
      // finished cars cool down, then AI cars leave the track (parc fermé)
      if (e.finished && e.coolDown != null) {
        e.coolDown -= dt;
        if (e.coolDown <= 0) {
          const finishingPit = !!e.phys.corridor && e.pitState?.driven &&
            e.pitState.phase !== 'released';
          if (finishingPit) {
            e.coolDown = 0.5;
          } else {
            e.coolDown = null;
            if (!e.isPlayer) { e.phys.disabled = true; e.mesh.visible = false; }
          }
        }
      }
      let input;
      const control = this.raceControl.controlForSample(e.phys.trackIdx ?? e.phys.sampleIdx, c.N);
      if (e.ai) {
        e.ai.vscFactor = this.phase === 'formation' ? 0.45 : control.paceFactor;
        e.ai.noOvertake = this.phase === 'formation' || control.noOvertake;
        e.ai.setRaceContext({
          ...this.conditions,
          damage: performanceModifiers(e.damage),
          fuelMode: e.strategyDecision?.fuelMode || 'balanced',
          strategy: e.strategyDecision,
          raceControlState: this.raceControl.state,
        });
      }
      if (e.isPlayer) {
        const finishingPit = !!e.phys.corridor && e.pitState?.driven && e.pitState.phase !== 'stopped';
        input = ((liveDrive && (!e.finished || finishingPit)) || this.phase === 'lights') ? playerInput : ZERO_INPUT;
      } else {
        // A driven AI stop must keep receiving AI input until the car rejoins,
        // even if the chequered already fell while they were still in the lane.
        const finishingPit = !!(e.pitState?.driven && e.pitState.phase !== 'released');
        input = (liveDrive && (!e.finished || finishingPit)) ? e.ai.update(dt, allPhys) : ZERO_INPUT;
      }
      input = this._applyEntrySystems(e, dt, input, control);
      if (e._wallDamageCool > 0) e._wallDamageCool -= dt;
      if (e._carDamageCool > 0) e._carDamageCool -= dt;
      const ev = e.phys.step(dt, input);
      // AI holds the limiter for the entire corridor, including the exit lane.
      // Dropping it before the pit-exit line is what earned the specious +5s on
      // the way out of the box in the headless race sim.
      if (!e.isPlayer && e.phys.corridor && e.pitState?.driven) e.phys.pitLimiter = true;
      if (e.phys.pitLimiter && e.phys.corridor) {
        // Engaged limiter: settle at the corridor speed limit without a hard clamp
        // that would make the stewarding penalty impossible when disengaged.
        const lim = e.phys.corridor.speedLimit || 22.22;
        if (e.phys.v > lim) e.phys.v = lim;
        if (e.phys.vehicle?.velocityLong > lim) e.phys.vehicle.velocityLong = lim;
      }
      if (e.pitState?.driven) this._updatePit(e, dt);
      else if (!e.pitState) this._updatePitApproach(e);
      if (ev.crossedSF && this.phase === 'formation' && e.isPlayer && ev.crossedSF > 0) {
        // Every grid slot sits before the timing line. The first crossing only
        // starts the formation lap; completing immediately there would turn a
        // seven-kilometre Spa lap into a few seconds of driving.
        if (this.startProcedure.lapStarted) formationCompleteAfterStep = true;
        else {
          this.startProcedure.lapStarted = true;
          this.onMessage('FORMATION LAP UNDERWAY', 'yellow', { eventKey: 'start:formation-underway' });
        }
      } else if (ev.crossedSF && (racing || this.phase === 'lights')) this._onCross(e, ev.crossedSF);
      if (ev.wrongWay && e.isPlayer) this._msgOnce('wrongway', 'WRONG WAY', 'red');
      if (ev.wallHit) this._handleWallImpact(e, ev.wallHit);
      if (ev.shifted && e.isPlayer) this._shiftEvent = ev.shifted; // ±1: up/down for audio character
      if (racing) {
        this._sectorTiming(e);
        if (this.mode === 'race') this._trackLimits(e, dt);
      }
      // mechanical retirement (AI only, race only)
      // Reliability is now subsystem-based and applies to every car. The
      // legacy _dnfRate remains readable for tooling but no longer decides the
      // failure without a named part and performance degradation first.
      // stranded watchdog: a car off the racing surface and making no real
      // track progress must never hang the session — AI get recovered by the
      // marshals (retired), the player is lifted back onto the track.
      // "No progress" covers both a parked car (v≈0) and a wall-pinned car
      // grinding nose-in against a street-circuit barrier at walking pace
      // (v≈2-4 with zero sample progress — on singapore that state used to
      // persist for the rest of the race, so the player never reached the
      // lap where their armed pit stop would trigger).
      // Armed box is still on-track racing. Only skip while actually in the
      // corridor, in a legacy disabled stop, or physically disabled.
      if (!e.finished && !e.dnf && !e.phys.corridor && !e.phys.disabled &&
          !(e.pitState && !e.pitState.driven) &&
          (this.phase === 'racing' || this.phase === 'finished') && e.phys.offTrack) {
        // >4m of forward progress since the reference means the car is actually
        // moving through the runoff, not stuck — rebaseline and clear the timer
        if (e._stuckRef == null) e._stuckRef = e.phys.totalDist;
        if (e.phys.totalDist - e._stuckRef > 4) {
          e._stuckT = 0;
          e._stuckRef = e.phys.totalDist;
        }
        e._stuckT = (e._stuckT || 0) + dt;
        if (!e.isPlayer && e._stuckT > 6) {
          this._retire(e);
          this.onMessage(`${e.driver.code} BEACHED — RECOVERED BY MARSHALS`, 'yellow');
        } else if (e.isPlayer && e._stuckT > 10) {
          e._stuckT = 0;
          e._stuckRef = null;
          // placeAt at the car's own nearest sample: no progress gained or lost,
          // and the progress-floor lap tracker re-baselines cleanly
          const i = e.phys.sampleIdx;
          const sm = this.circuit.samples[i];
          e.phys.placeAt(sm.p.clone(), Math.atan2(sm.t.x, sm.t.z), i);
          this.resetRenderState(e);
          this.onMessage('RECOVERED TO THE TRACK', 'yellow');
        }
      } else { e._stuckT = 0; e._stuckRef = null; }
      this._advanceWheelSpin(e, dt);
    }

    // Re-grid only after every car has completed this formation tick. Doing it
    // inside the player iteration could let cars later in the array drive away
    // from their freshly assigned grid slots for one frame.
    if (formationCompleteAfterStep) this.completeFormation();

    if (this.mode === 'race') {
      this._collisions();
      this._posTimer -= dt;
      if (this._posTimer <= 0) { this._posTimer = 0.4; this._updatePositions(); }
      this._blueFlags(dt);
      this._engineerRadio(dt);
    } else this._updateQuali();

    // Capture after collision separation and every teleport-capable subsystem.
    // Applying the current endpoint preserves the legacy update()-drives-mesh
    // contract until the outer render loop calls render(alpha) explicitly.
    this._finishRenderTick();
    this.render(1);

    // finish condition — hard cutoff guarantees the race always classifies
    if (this.mode === 'race' && this.phase === 'finished' && !this.results) {
      if (this.netRole === 'guest') {
        // The host publishes the official sheet. Classifying locally only
        // matters if the host goes quiet, so the race can still end.
        if (this.phaseT > 20) this._classify();
      } else {
        const allDone = this.entries.every(e => e.finished || e.dnf);
        const playerDone = !this.player || this.player.finished || this.player.dnf;
        // A real pit stop can still be underway when the leader takes the flag.
        // Classifying a few seconds later freezes half the field mid-box / mid-lap
        // and reports multi-lap deficits that aren't race pace.
        const pitInProgress = this.entries.some(e =>
          !e.dnf && !e.finished && !e.phys.disabled && !!e.phys.corridor &&
          e.pitState?.driven && e.pitState.phase !== 'released');
        const stillRacing = this.entries.filter(e => !e.finished && !e.dnf).length;
        // Short player-facing grace when the pack is done; otherwise hold the
        // order long enough for cars still on track (or in the lane) to finish.
        const packGrace = stillRacing > 0
          ? Math.min(28, Math.max(this._finishGrace || 4, 12 + stillRacing * 4))
          : (this._finishGrace || 4);
        const hardCut = this.phaseT > 180;
        if (allDone || hardCut || (playerDone && this.phaseT > packGrace && !pitInProgress)) {
          this._classify();
        }
      }
    }
  }

  _aeroInteractions() {
    const c = this.circuit, N = c.N, ds = c.ds;
    for (const e of this.entries) { e.phys.slipstream = 0; e.phys.dirtyAir = 0; }
    for (const a of this.entries) {
      if (a.phys.disabled || a.dnf) continue;
      for (const b of this.entries) {
        if (a === b || b.phys.disabled || b.dnf) continue;
        if (a.phys.corridor || b.phys.corridor) continue;
        let ahead = (b.phys.trackIdx ?? b.phys.sampleIdx) - (a.phys.trackIdx ?? a.phys.sampleIdx);
        if (ahead > N / 2) ahead -= N;
        if (ahead < -N / 2) ahead += N;
        const d = ahead * ds;
        if (d < 2 || d > 42) continue;
        if (Math.abs(b.phys.trackLat - a.phys.trackLat) > 3) continue;
        const str = 1 - d / 42;
        const curv = Math.abs(c.line[a.phys.trackIdx ?? a.phys.sampleIdx].curv);
        if (curv > 1 / 420) a.phys.dirtyAir = Math.max(a.phys.dirtyAir, str);
        else a.phys.slipstream = Math.max(a.phys.slipstream, str);
      }
    }
  }

  _applyEntrySystems(e, dt, sourceInput, control) {
    const input = Object.assign({}, sourceInput || ZERO_INPUT);
    const mods = performanceModifiers(e.damage);
    const controlFactor = control?.paceFactor ?? 1;
    // Pit limiter is a driver aid (L). Engaged: cap throttle so the car settles
    // at 80 km/h. Disengaged: nothing is clamped, so a hot entry earns +5 s.
    if (e.phys.pitLimiter) {
      const lim = e.phys.corridor?.speedLimit || this.circuit.pitLane?.speedLimit || 22.22;
      if (e.phys.v > lim - 0.4) input.throttle = Math.min(input.throttle || 0, 0.08);
      if (e.phys.v > lim + 0.2) {
        input.throttle = 0;
        input.brake = Math.max(input.brake || 0, Math.min(0.55, (e.phys.v - lim) * 0.25));
      }
      input.boost = false;
    } else if (e.phys.corridor && e.isPlayer && !e._pitLimiterWarned) {
      e._pitLimiterWarned = true;
      this.onMessage('PIT LANE — ENGAGE LIMITER (L)', 'yellow');
    }
    if (!e.phys.corridor) e._pitLimiterWarned = false;
    input.throttle = Math.min(input.throttle || 0, mods.power, controlFactor < 1 ? controlFactor + 0.12 : 1);
    input.brake = Math.max(0, Math.min(1, (input.brake || 0) * mods.braking));
    input.steer = Math.max(-1, Math.min(1, (input.steer || 0) + mods.steeringBias));
    if (input.ersMode == null && e.strategyDecision) input.ersMode = e.strategyDecision.ersMode;
    if (e.strategyDecision?.fuelMode === 'save') input.throttle = Math.min(input.throttle, 0.86);
    if (controlFactor === 0) {
      e.phys.v = 0;
      input.throttle = 0;
      input.brake = 0;
      input.boost = false;
      input.ersMode = 0;
    }
    if (e.damage?.puncture) { input.throttle = Math.min(input.throttle, 0.28); input.boost = false; }
    e.phys.dirtyAir = Math.max(e.phys.dirtyAir, mods.aeroLoss);
    e.wingDamage = Math.max(e.wingDamage || 0, 1 - (e.damage?.frontWing ?? 1));

    if (this.mode === 'race' && this.phase === 'racing' && !e.finished && !e.dnf) {
      const outcome = stepReliability(e.damage, dt, {
        stress: Math.max(input.throttle || 0, input.brake || 0) + (e.phys.tyreTemp > 118 ? 0.2 : 0),
        raceProgress: Math.max(0, e.lap) / this.laps,
      }, this.random);
      if (outcome.warning && outcome.warning !== e.reliabilityWarning) {
        e.reliabilityWarning = outcome.warning;
        if (e.isPlayer) this._radio(`${partLabel(outcome.warning)} issue detected — manage the car.`, 'warning', true);
      }
      if (outcome.failed && e.isPlayer) {
        // A local browser race should remain recoverable: terminal telemetry
        // becomes a severe limp-home state so the player can reach the pits.
        // AI cars still retire and exercise official DNF classification.
        e.damage.terminal = false;
        e.damage.cause = null;
        e.damage.puncture = true;
        for (const part of ['suspension', 'powerUnit', 'gearbox', 'brakes', 'cooling']) {
          e.damage[part] = Math.max(0.34, e.damage[part]);
        }
        if (!e._terminalWarning) {
          e._terminalWarning = true;
          this._radio('Critical damage — limp back and box for repairs.', 'warning', true);
        }
      } else if (outcome.failed) this._retire(e, outcome.cause);
    }
    return input;
  }

  // ======== race direction ========

  _onRaceControlEvent(event) {
    const eventKey = event.state === 'vsc' && event.action === 'deploy'
      ? `vsc:${event.cycle}:deploy`
      : event.action === 'green' && event.previous === 'vsc'
        ? `vsc:${event.cycle}:green`
        : event.eventKey;
    if (event.action === 'deploy') {
      const labels = {
        'local-yellow': 'LOCAL YELLOW', yellow: 'YELLOW FLAG', vsc: 'VIRTUAL SAFETY CAR',
        'safety-car': 'SAFETY CAR DEPLOYED', 'red-flag': 'RED FLAG — SESSION SUSPENDED',
      };
      this.onMessage(labels[event.state] || event.state.toUpperCase(), event.state === 'red-flag' ? 'red' : 'yellow', { eventKey });
      if (event.state === 'vsc') this._radio('Virtual safety car deployed — hold the delta.', 'warning', true, { eventKey });
      else if (event.state === 'safety-car') this._radio('Safety car deployed — positive delta, no overtaking.', 'warning', true, { eventKey });
      else if (event.state === 'red-flag') this._radio('Red flag — slow down and stop safely.', 'warning', true, { eventKey });
    } else if (event.action === 'restart') {
      this.onMessage(event.restartType === 'standing' ? 'STANDING RESTART' : 'SAFETY CAR IN — RESTART', 'yellow', { eventKey: event.eventKey });
    } else if (event.action === 'green') {
      this.onMessage('GREEN FLAG — RACE RESUMES', 'green', { eventKey });
      this._radio('Green flag — go, go, go.', 'info', true, { eventKey });
    }
    this.vsc.active = event.state === 'vsc';
    this.vsc.timeLeft = this.vsc.active ? event.timeLeft : 0;
    this.vsc.cycle = event.cycle;
    this.vsc.deployEventKey = `vsc:${event.cycle}:deploy`;
    this.vsc.greenEventKey = `vsc:${event.cycle}:green`;
  }

  /** Legacy VSC hook retained for headless tooling. */
  _startVSC(secs) {
    this._vscEnding = false;
    this._vscViol = 0;
    this._vscWarned = false;
    this._vscPenalised = false;
    return this.requestRaceControl('vsc', { duration: secs, reason: 'stopped-car' });
  }

  _updateVSC(dt) {
    const wasVsc = this.raceControl.state === 'vsc';
    if (wasVsc && this.raceControl.timeLeft <= 3 && !this._vscEnding) {
      this._vscEnding = true;
      this.onMessage('VSC ENDING', 'yellow');
      this._radio('VSC ending — get ready.', 'info', true);
    }
    this.raceControl.update(dt);
    this.vsc.active = this.raceControl.state === 'vsc';
    this.vsc.timeLeft = this.vsc.active ? this.raceControl.timeLeft : 0;
    if (wasVsc && !this.vsc.active) this._vscEnding = false;
    if (!this.vsc.active) return;
    // the player is expected to slow to the delta; sustained over-speed is a penalty
    const p = this.player;
    if (p && !p.finished && !p.dnf && !p.phys.corridor && !(p.pitState && !p.pitState.driven) && p.phys.v > 62) {
      this._vscViol += dt;
      if (this._vscViol > 1 && !this._vscWarned) {
        this._vscWarned = true;
        this.onMessage('VSC — SLOW DOWN', 'yellow');
        this._radio('VSC — slow down, you are over the delta.', 'warning', true);
      } else if (this._vscViol > 3 && !this._vscPenalised) {
        this._vscPenalised = true;
        p.penaltySeconds += 5;
        this.onMessage('VSC INFRINGEMENT — +5s PENALTY', 'red');
        this._radio('VSC infringement — five second penalty.', 'warning', true);
        // A penalty closes this sustained breach. Re-arm from zero so another
        // continuous three-second breach costs again instead of becoming a
        // one-shot latch (or charging every frame above the old accumulator).
        this._vscViol = 0;
        this._vscWarned = false;
        this._vscPenalised = false;
      }
    } else {
      this._vscViol = 0;
      this._vscWarned = false;
      this._vscPenalised = false;
    }
  }

  // ---- sector timing: boundaries at 1/3 and 2/3 of the sample ring ----
  _sectorTiming(e) {
    if (e.lap < 0 || e.phys.corridor || (e.pitState && !e.pitState.driven) || e.finished || e.dnf) return;
    const N = this.circuit.N;
    const idx = e.phys.sampleIdx;
    const t = this.raceTime - e.lapStart;
    if (e._secStage === 0) {
      if (idx >= N / 3 && idx < 2 * N / 3) {
        e._secSplit[0] = t;
        e.sectors[0] = t;
        e._secStage = 1;
      }
    } else if (e._secStage === 1 && idx >= 2 * N / 3) {
      e._secSplit[1] = t;
      e.sectors[1] = e._secSplit[0] != null ? t - e._secSplit[0] : null;
      e._secStage = 2;
    }
  }

  /** Close out the lap's third sector and roll live → last → best. */
  _completeSectors(e, lapTime) {
    const s1 = e._secSplit[0], s2 = e._secSplit[1];
    e.sectors[2] = (s2 != null && lapTime > s2) ? lapTime - s2 : null;
    e.lastSectors = [e.sectors[0], e.sectors[1], e.sectors[2]];
    for (let i = 0; i < 3; i++) {
      const v = e.lastSectors[i];
      if (v != null && v > 0 && (e.bestSectors[i] == null || v < e.bestSectors[i])) {
        e.bestSectors[i] = v;
      }
    }
    this._resetSectors(e);
  }

  /** Drop live sector state, re-deriving the stage from where the car is now. */
  _resetSectors(e) {
    const N = this.circuit.N, idx = e.phys.sampleIdx;
    e.sectors = [null, null, null];
    e._secSplit = [null, null];
    e._secStage = idx >= 2 * N / 3 ? 2 : idx >= N / 3 ? 1 : 0;
  }

  // ---- track limits: a sustained off-track excursion while carrying speed ----
  _trackLimits(e, dt) {
    const p = e.phys;
    // Armed BOX is still racing; only the corridor / legacy stop is exempt.
    if (e.finished || e.dnf || e.phys.corridor || (e.pitState && !e.pitState.driven)) return;
    if (p.offTrack) {
      // gaining an advantage, not crashing: still quick and not hitting anything
      if (p.v > 30 && !p.wallContact) {
        e._offAcc += dt;
        if (e._offAcc > 0.4 && !e._offLatched) {
          e._offLatched = true;
          this._trackLimitViolation(e);
        }
      }
    } else {
      e._offAcc = 0;
      e._offLatched = false;
    }
  }

  _trackLimitViolation(e) {
    e.trackLimits++;
    if (!e.isPlayer) {
      if (e.ai) e.ai.penaltyScrub(2.5);   // AI take a small pace scrub instead
      return;
    }
    if (e.trackLimits <= 3) {
      this._radio(`TRACK LIMITS — WARNING ${e.trackLimits}/3`, 'warning', true);
      if (e.trackLimits === 3) this.onMessage('TRACK LIMITS — FINAL WARNING', 'yellow');
    } else {
      e.penaltySeconds += 5;
      this._radio('TRACK LIMITS — +5s PENALTY', 'warning', true);
      this.onMessage('TRACK LIMITS — +5s PENALTY', 'red');
    }
  }

  // ---- front wing damage ----
  _maybeWingDamage(e, source = 'car') {
    if (e.wingDamage > 0 || e.dnf || e.finished || e.phys.corridor || (e.pitState && !e.pitState.driven)) return;
    // Wall and car incidents have independent debounce windows: a wall brush
    // must not suppress damage from a subsequent nose-to-tail impact (or vice
    // versa). `_contactCool` is retained only as harmless legacy state for old
    // snapshots and tooling.
    const cooldown = source === 'wall' ? '_wallDamageCool' : '_carDamageCool';
    if ((e[cooldown] || 0) > 0) return;
    e[cooldown] = 2;
    if (this.random() >= 0.25) return;
    e.wingDamage = 0.15;
    if (e.damage) e.damage.frontWing = Math.min(e.damage.frontWing, 0.72);
    if (e.isPlayer) {
      this.onMessage('FRONT WING DAMAGE — BOX TO REPAIR', 'red');
      this._radio('FRONT WING DAMAGE — BOX TO REPAIR', 'warning', true);
    } else {
      e.boxThisLap = true;   // AI come in next time by to replace the wing
    }
  }

  _handleWallImpact(e, intensity) {
    if (!(intensity > 0)) return;
    applyImpactDamage(e.damage, {
      severity: intensity,
      front: !!e.phys.wallImpactFront,
      side: (e.phys.lat < 0 ? -1 : 1) * (e.phys.wallImpactFront ? 0.2 : 0.85),
    }, this.random);
    if (e.isPlayer) {
      const candidate = {
        intensity,
        normalSpeed: e.phys.wallImpactNormalSpeed || Math.max(0, (intensity - 0.15) * 45),
        // heard by the player only: -1 left / +1 right, and positive lat is left
        side: e.phys.lat > 0 ? -1 : 1,
      };
      const current = this._wallEvent;
      if (!current || candidate.intensity > (current.intensity || 0) ||
          (candidate.intensity === (current.intensity || 0) &&
            candidate.normalSpeed > (current.normalSpeed || 0))) {
        this._wallEvent = candidate;
      }
    }
    if (intensity > 0.5 && e.phys.wallImpactFront && this.mode === 'race') {
      this._maybeWingDamage(e, 'wall');
    }
  }

  // ---- blue flags: backmarkers must let a lapping car through ----
  _blueFlags(dt) {
    const c = this.circuit, N = c.N, ds = c.ds;
    const avail = e => !e.dnf && !e.finished && !e.phys.corridor && !e.phys.disabled &&
      !(e.pitState && !e.pitState.driven);
    let playerBlue = false;
    for (const b of this.entries) {
      if (!avail(b)) { b._blueT = 0; b._blueFrom = null; continue; }
      let lapper = null, bestT = 1e9;
      for (const a of this.entries) {
        if (a === b || !avail(a)) continue;
        if (a.lap - b.lap < 1) continue;          // must be at least a lap ahead
        let ahead = b.phys.sampleIdx - a.phys.sampleIdx;   // a → b along the track
        if (ahead > N / 2) ahead -= N;
        if (ahead < -N / 2) ahead += N;
        const d = ahead * ds;
        if (d <= 0 || d > 300) continue;          // a has to be behind b, and close
        const t = d / Math.max(a.phys.v, 28);
        if (t < 3 && t < bestT) { bestT = t; lapper = a; }
      }
      if (lapper) {
        b._blueT = 4;
        if (b.isPlayer) {
          playerBlue = true;
          if (b._blueFrom !== lapper.driver.id) {
            b._blueFrom = lapper.driver.id;
            this.onMessage('BLUE FLAGS — LET THE LEADER THROUGH', 'yellow');
            this._radio('Blue flags — let the leader through.', 'warning', true);
          }
        } else if (b.ai) {
          // pull off the racing line toward the side we are already on
          b.ai.setYield((b.phys.trackLat >= 0 ? 1 : -1) * 2.5, 4);
          b._blueFrom = lapper.driver.id;
        }
      } else if (b._blueT > 0) {
        b._blueT -= dt;
        if (b._blueT <= 0) b._blueFrom = null;
      }
    }
    this.blueFlagFor = playerBlue && this.player ? this.player.driver.id : null;
  }

  // ---- engineer radio: contextual colour, at most one line per 12s ----
  _gapSeconds(ahead, e) {
    const c = this.circuit;
    const d = (ahead.lap - e.lap) * c.length + (ahead.phys.sampleIdx - e.phys.sampleIdx) * c.ds;
    if (d < 0) return null;
    return d / Math.max(e.phys.v, 28);
  }

  _engineerRadio(dt) {
    const p = this.player;
    if (!p || p.dnf) return;

    if (this.phase !== 'racing' || p.finished || p.phys.corridor || (p.pitState && !p.pitState.driven)) return;

    // final lap
    if (this.laps - p.lap === 1 && p.lap > 0 && !this._radioLastLap) {
      this._radioLastLap = true;
      this._radio('Last lap — bring it home', 'info', true);
      return;
    }
    // places gained
    if (this._lastPlayerPos == null) this._lastPlayerPos = p.position;
    if (p.position !== this._lastPlayerPos) {
      const gained = this._lastPlayerPos - p.position;
      this._lastPlayerPos = p.position;
      if (gained > 0 && this._radio(`P${p.position} — great move`, 'celebration')) return;
    }
    // tyre state, once per stint
    if (p.phys.wear > 0.6 && this._radioTyreStint !== p.pitStops) {
      if (this._radio('These tyres are done — box when ready', 'warning')) {
        this._radioTyreStint = p.pitStops;
        return;
      }
    }
    // gap to the car ahead when we are the quicker of the two
    this._gapCheck = (this._gapCheck ?? 0) - dt;
    if (this._gapCheck <= 0) {
      this._gapCheck = 4;
      const ahead = this.entries.find(e => !e.dnf && !e.phys.corridor && !(e.pitState && !e.pitState.driven) && e.position === p.position - 1);
      if (ahead && p.lastLap && ahead.lastLap && p.lastLap < ahead.lastLap) {
        const g = this._gapSeconds(ahead, p);
        if (g != null && g < 2.5) {
          this._radio(`Gap to ${ahead.driver.lastName} ${g.toFixed(1)}, you're quicker`, 'info');
        }
      }
    }
  }

  _onCross(e, dir = 1) {
    const c = this.circuit;
    if (dir < 0) { e.lap--; return; }   // reversed back over the line
    e.lap++;
    if (e.lap <= (e.maxLap ?? -1)) return; // re-crossing after a reverse: no double bookkeeping
    e.maxLap = e.lap;
    if (this.phase === 'lights') return;   // jump-start crossing: lap counted, no timing
    if (e.lap === 0) {
      e.lapStart = this.raceTime;
      this._resetSectors(e);
    } else {
      const lt = this.raceTime - e.lapStart;
      e.lapStart = this.raceTime;
      e.lastLap = lt;
      e.lapTimes.push(lt);
      if (!e.phys.corridor && !e._pitCrossPending) e.tyreAgeLaps++;
      e._pitCrossPending = false;
      this._completeSectors(e, lt);
      if (!e.bestLap || lt < e.bestLap) e.bestLap = lt;
      if (this.mode === 'race' && (!this.fastestLap || lt < this.fastestLap.time)) {
        const eventKey = `fastest:${e.driver.id}:${lt}`;
        this.fastestLap = { driverId: e.driver.id, time: lt, name: e.driver.lastName, eventKey };
        this.onMessage(`FASTEST LAP — ${e.driver.code} ${fmtTime(lt)}`, 'purple', { eventKey });
      }
    }
    if (this.mode !== 'race') return;

    this.conditions = this.getForecast(e.lap);
    if (e.strategy) {
      e.strategyDecision = e.strategy.decide({
        lap: e.lap,
        compound: e.strategyCompound || e.phys.compound,
        wear: e.phys.wear,
        tyreAgeLaps: e.tyreAgeLaps,
        fuel: e.phys.fuel,
        battery: e.phys.battery,
        damageSeverity: damageSeverity(e.damage),
        safetyCar: this.raceControl.state === 'safety-car',
        noOvertake: this.raceControl.noOvertake,
        attack: e.position > 1,
        defend: e.position <= 10,
      });
      if (!e.isPlayer && !e.pitState && e.strategyDecision.shouldPit) {
        e.boxThisLap = true;
        e.plannedNext = e.strategyDecision.nextCompound;
      } else if (e.isPlayer && e.strategyDecision.shouldPit) {
        this._radio(`Strategy recommends box: ${e.strategyDecision.reason.replace('-', ' ')}.`, 'warning');
      }
    }

    // A stop is armed at the timing line, then begins only at the physical pit
    // mouth near the end of that lap. This keeps strategy timing coupled to laps
    // without teleporting a car backwards from S/F to pit entry.
    if (!e.isPlayer && !e.pitState && (e.boxThisLap || e.lap === e.plannedPitLap ||
        (e.phys.wear > 0.72 && e.lap < this.laps - 2 && this.laps >= 8))
        && e.lap > 0 && e.lap < this.laps && !e.finished) e.boxThisLap = true;
    // forced strategy: AI second-guess if wear critical handled above
    if (!e.isPlayer && e.ai) e.ai.newLapNoise();

    // chequered flag
    if (e.lap >= this.laps && !e.finished) {
      // FIA 2026 B1.9.6(d): an unserved Stop-and-Go imposed too late to be
      // completed is converted to its 30-second classified-time equivalent.
      this._convertPendingStopAndGo(e, 'chequered flag');
      // An armed request is still ordinary on-track running. Once the car has
      // taken the flag there is no next mouth to reach, so do not leave a
      // non-physical pit state holding classification open.
      if (e.pitState?.driven && e.pitState.phase === 'armed') {
        e.pitState = null;
        e.boxThisLap = false;
        e.phys.pitLimiter = false;
      }
      e.finished = true;
      e.coolDown = 2.5;
      e.finishTime = this.raceTime;   // time penalties are applied at classification
      if (this.phase !== 'finished') {
        this.phase = 'finished';
        this.phaseT = 0;
        this._finishGrace = 4;
        this.onMessage(`${e.driver.code} WINS THE RACE`, 'yellow');
        this.winner = e;
      }
      if (e.isPlayer) { this._finishGrace = Math.min(this._finishGrace ?? 4, 2.5); }
    } else if (e.isPlayer && this.laps - e.lap <= 3 && this.laps - e.lap > 0 && e.lap > 0) {
      this.onMessage(this.laps - e.lap === 1 ? 'FINAL LAP' : `${this.laps - e.lap} LAPS TO GO`, '');
    }
  }

  _enterPit(e) {
    const c = this.circuit;
    const lane = c.pitLane;
    // Player: arm only. Transition into the corridor happens geometrically at the
    // pit-entry line on the track edge — never by index proximity alone.
    if (e.isPlayer) {
      if (e.pitState?.driven) return false;
      e.pitState = {
        phase: 'armed', driven: true, chosen: null, serviced: false,
        previousTrackIdx: e.phys.trackIdx ?? e.phys.sampleIdx,
        previousLat: e.phys.lat,
        speedingT: 0, speedingPenalised: false,
        exitLineLatched: false,
        enteredAt: null,
      };
      e.boxThisLap = true;
      return true;
    }

    // AI: same driven state machine as the player. No teleport into the lane.
    if (e.pitState?.driven) return false;
    const service = this._pitServicePlan(e);
    const box = lane.boxes.find(row => row.num === e.driver.num)
      || lane.boxes[Math.max(0, Math.min(lane.boxes.length - 1, (e.gridPos || 1) - 1))];
    const next = e.plannedNext || e.strategyDecision?.nextCompound ||
      defaultNext(e.phys.compound, this.conditions);
    const at = e.phys.trackIdx ?? e.phys.sampleIdx;
    e.pitState = {
      phase: 'armed', driven: true, chosen: next, serviced: false,
      // Seed one sample behind so a car already sitting on the mouth can still
      // commit on the next tick without needing a fresh longitudinal crossing.
      previousTrackIdx: (at - 1 + c.N) % c.N,
      previousLat: e.phys.lat,
      box, repair: service.repair, serviceSeconds: service.serviceSeconds,
      stopAndGo: service.stopAndGo,
      timer: service.serviceSeconds, wing: e.wingDamage > 0,
      speedingT: 0, speedingPenalised: false,
      exitLineLatched: false, reposition: false,
      enteredAt: null,
    };
    e.boxThisLap = true;
    e.plannedPitLap = -1;
    e.mesh.visible = true;
    if (e.ai) e.ai.entry = e;
    return true;
  }

  _pitServicePlan(e) {
    if (e.stopAndGoPenalty?.status === 'pending') {
      // FIA 2026 B1.6.2(b)(ii): unsafe release carries a Stop-and-Go. The car
      // must remain stationary for ten seconds and no work may be performed.
      return {
        repair: { repairs: [], seconds: 0 },
        serviceSeconds: STOP_AND_GO_SECONDS,
        stopAndGo: true,
      };
    }
    const repair = repairPlan(e.damage);
    if (e.wingDamage > 0 && !repair.repairs.some(item => item.part === 'frontWing')) {
      repair.repairs.unshift({ part: 'frontWing', seconds: 3, target: 1 });
      repair.seconds += 3;
    }
    // The stationary stop is the one stretch of a race where the player has no
    // control at all, so it is capped rather than left open-ended. Repairs and a
    // botched gun still cost time and still hurt, they just cannot leave anyone
    // sitting motionless past PIT_SERVICE_MAX. Driving the lane is unaffected —
    // that is the part the player is actually doing.
    const raw = 2.2 + this.random() * 2 + (this.random() < 0.06 ? 4 : 0) + repair.seconds;
    return { repair, serviceSeconds: Math.min(PIT_SERVICE_MAX, raw), stopAndGo: false };
  }

  _crossedPitIndex(previous, current, target) {
    const N = this.circuit.N;
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
    const delta = ((current - previous) % N + N) % N;
    if (delta <= 0 || delta > N / 2) return false;
    const toTarget = ((target - previous) % N + N) % N;
    return toTarget <= delta;
  }

  _updatePitApproach(e) {
    // AI arming: build the same driven pitState the player gets from BOX, so both
    // share _tryCommitPitEntry. Without this, boxThisLap alone never creates
    // pitState and the geometric commitment gate rejects every AI car forever.
    if (e.finished || e.dnf) return;
    if (e.pitState) return;
    // A sporting penalty is not an optional strategy call. Once the previous
    // stop has released, arm the next physical pit entry for either player or AI.
    if (e.stopAndGoPenalty?.status === 'pending') {
      e.boxThisLap = true;
      this._enterPit(e);
      return;
    }
    if (e.isPlayer) return;
    if (!e.boxThisLap || e.lap <= 0 || e.lap >= this.laps) return;
    this._enterPit(e);
  }

  /**
   * Commit into the corridor only when the car crosses the painted pit-entry
   * line at the track EDGE on the pit side. A car past the mouth on the racing
   * line, or merely near the entry sample index, must not be snapped in.
   */
  _tryCommitPitEntry(e) {
    const p = e.phys;
    const lane = this.circuit.pitLane;
    const ps = e.pitState;
    if (!ps?.driven || ps.phase !== 'armed' || p.corridor) return false;
    const side = lane.pitSide || this.circuit.group?.userData?.pitSide || 1;
    const current = p.trackIdx ?? p.sampleIdx;
    const previous = ps.previousTrackIdx;
    ps.previousTrackIdx = current;
    ps.previousLat = p.lat;

    // Entry is a DECISION, not a reflex. Holding the pit-side edge anywhere in
    // the approach zone latches the commitment; the car only transfers onto the
    // corridor once it actually reaches the mouth, so there is still no
    // teleport. Requiring the edge and the mouth in the same instant made this
    // a ~0.5 s window at racing speed — unhittable on a keyboard, and the
    // narrowness bought nothing: what keeps a car from being snapped in is the
    // lateral gate below, not the length of the window.
    const N = this.circuit.N;
    let fromEntry = ((current - lane.entryTrackIdx) % N + N) % N;
    if (fromEntry > N / 2) fromEntry -= N;
    const alongM = fromEntry * this.circuit.ds;
    const crossedMouth = this._crossedPitIndex(previous, current, lane.entryTrackIdx);

    // Commitment is being on the pit-side track EDGE — not a racing-line
    // proximity snap. The racing line (lat≈0) must always miss, which is what
    // the contract's +45 m / lat 0 case relies on.
    const hw = this.circuit.halfWidth;
    // Owned by js/pitLane.js so the enforced threshold and the HUD cue that
    // teaches it cannot drift apart.
    const edgeNeed = lane.entryEdgeNeed ?? Math.max(1.0, (lane.edgeOffset || hw) * 0.45);
    const approachM = lane.entryApproachM ?? 120;
    const overshootM = lane.entryOvershootM ?? 14;
    // An abort or a missed mouth closes the entry for the rest of THIS lap —
    // the radio already promises "stays armed for the next lap", and without
    // this the announced abort silently re-latched a few metres later.
    if (ps.entryClosedForLap === e.lap) return false;
    if (alongM >= -approachM && alongM <= overshootM && side * p.lat >= edgeNeed) {
      if (!ps.committed && e.isPlayer) this.onMessage('PIT ENTRY — COMMITTED', 'green');
      ps.committed = true;
    }
    // Changed their mind: drifting back to the racing line before the mouth
    // releases the latch, so moving over early is a decision, not a trap.
    // Re-committing before the mouth is allowed — both transitions announce
    // themselves. Only a MISSED mouth (below) closes the entry for the lap;
    // closing on abort locked out legitimate approaches whose own corridor
    // curvature dips the car toward centre mid-approach (suzuka, montreal,
    // lusail all do this on the contract's approach line).
    if (ps.committed && alongM < -2 && side * p.lat < edgeNeed * 0.35) {
      ps.committed = false;
      if (e.isPlayer) this.onMessage('PIT ENTRY — ABORTED', 'yellow');
      return false;
    }
    if (!ps.committed) {
      if (crossedMouth) {
        ps.entryClosedForLap = e.lap;
        if (e.isPlayer) {
          this.onMessage('BOX MISSED — ENTRY NOT REACHED', 'yellow');
          this._radio('You missed the entry — box request stays armed for the next lap.', 'warning', true);
        }
      }
      return false;
    }
    // Latched, but hold on the track until the paths actually meet at the mouth.
    if (alongM < -2 || alongM > overshootM) return false;

    const service = ps.repair ? {
      repair: ps.repair,
      serviceSeconds: ps.serviceSeconds,
      stopAndGo: !!ps.stopAndGo,
    }
      : this._pitServicePlan(e);
    const box = ps.box || lane.boxes.find(row => row.num === e.driver.num)
      || lane.boxes[Math.max(0, Math.min(lane.boxes.length - 1, (e.gridPos || 1) - 1))];
    Object.assign(ps, {
      phase: 'lane', box, repair: service.repair, serviceSeconds: service.serviceSeconds,
      stopAndGo: service.stopAndGo,
      timer: service.serviceSeconds, wing: e.wingDamage > 0,
      speedingT: 0, speedingPenalised: false, reposition: false,
      enteredAt: this.raceTime,
      // Wall-clock of the driven stop itself. raceTime only advances in
      // session.update(), so probes that step _updatePit alone still get a real loss.
      laneT: 0,
    });
    if (!ps.chosen) {
      ps.chosen = e.plannedNext || e.strategyDecision?.nextCompound ||
        defaultNext(p.compound, this.conditions);
    }
    // Join the open ribbon at the car's real pose. enterCorridor recomputes lane
    // lateral from that pose; snapping to the centreline here made a legal edge
    // entry jump more than two metres sideways in one render tick.
    const previousTrackIdx = p.trackIdx ?? p.sampleIdx;
    const mouthIdx = Math.max(0, Math.min(lane.N - 1, lane.nearestSample(p.pos, 0)));
    const s0 = lane.samples[mouthIdx];
    p.enterCorridor(lane, mouthIdx);
    let dd = s0.trackIdx - previousTrackIdx;
    if (dd > N / 2) dd -= N;
    if (dd < -N / 2) dd += N;
    if (dd !== 0) p.totalDist += dd * this.circuit.ds;
    e.boxThisLap = false;
    e.pitStops++;
    if (e.isPlayer) {
      this.onMessage(p.pitLimiter ? 'PIT LANE — LIMITER ON' : 'PIT LANE — ENGAGE LIMITER (L)', 'yellow');
    } else if (e.ai) {
      // AI always runs the limiter in the lane.
      p.pitLimiter = true;
    }
    return true;
  }

  _updatePit(e, dt) {
    const ps = e.pitState;
    const c = this.circuit;
    if (ps?.driven) {
      this._updateDrivenPit(e, dt);
      return;
    }
    // Backward-compatible force-completion shape used by old snapshots and
    // interpolation tooling. Runtime-created stops always carry phaseT and the
    // progressive entry/service/exit durations above.
    if (!Number.isFinite(ps.phaseT) || !Number.isFinite(ps.entrySeconds)) {
      ps.timer -= dt;
      if (ps.timer > 0) return;
      const chosen = physicalCompound(ps.chosen || defaultNext(e.phys.compound, this.conditions));
      e.phys.setTyre(chosen);
      e.strategyCompound = chosen;
      e.strategy?.confirmStop();
      const i = c.pitExitIdx;
      const s = c.samples[i];
      e.phys.placeAt(s.p.clone().addScaledVector(s.n, c.halfWidth * 0.5), Math.atan2(s.t.x, s.t.z), i);
      e.phys.v = 23;
      e.phys.gear = 3;
      e.phys.disabled = false;
      e.pitState = null;
      e.mesh.visible = true;
      e.tyreAgeLaps = 0;
      e.wingDamage = 0;
      if (e.damage) e.damage.frontWing = 1;
      e.phys.dirtyAir = 0;
      this._resetSectors(e);
      this.resetRenderState(e);
      if (CAR.setTyreCompound && e.carHandle) CAR.setTyreCompound(e.carHandle, chosen);
      return;
    }
    ps.timer = Math.max(0, ps.timer - dt);
    ps.phaseT = Math.max(0, ps.phaseT - dt);
    if (ps.phase === 'entry') {
      const t = 1 - ps.phaseT / ps.entrySeconds;
      this._placeInPitLane(e, ps.startIdx, ps.serviceIdx, t,
        22 * (0.7 + 0.3 * (1 - t)), 0, ps.boxLateral || 0);
      if (ps.phaseT <= 0) {
        ps.phase = 'stopped';
        ps.phaseT = ps.serviceSeconds;
        this._placeInPitLane(e, ps.serviceIdx, ps.serviceIdx, 1, 0,
          ps.boxLateral || 0, ps.boxLateral || 0);
      }
      return;
    }
    if (ps.phase === 'stopped') {
      e.phys.v = 0;
      if (ps.phaseT > 0) return;
      const chosen = physicalCompound(ps.chosen || defaultNext(e.phys.compound, this.conditions));
      e.phys.setTyre(chosen);
      applyRepairPlan(e.damage, ps.repair);
      ps.serviced = true;
      ps.phase = 'exit';
      ps.phaseT = ps.exitSeconds;
      ps.fittedCompound = chosen;
      e.tyreAgeLaps = 0;
      e.wingDamage = 0;             // new nose fitted
      e.phys.dirtyAir = 0;
      if (CAR.setTyreCompound && e.carHandle) CAR.setTyreCompound(e.carHandle, chosen);
      return;
    }
    if (ps.phase === 'exit') {
      const t = 1 - ps.phaseT / ps.exitSeconds;
      this._placeInPitLane(e, ps.serviceIdx, ps.exitIdx, t, 23, ps.boxLateral || 0, 0);
      if (ps.phaseT > 0) return;
      const fitted = ps.fittedCompound || e.phys.compound;
      e.strategyCompound = fitted;
      e.strategy?.confirmStop();
      e.pitState = null;
      e.phys.disabled = false;
      e.phys.exitCorridor(c.pitExitIdx);
      e.phys.v = 23;
      e.phys.gear = 3;
      this._resetSectors(e);
      this.resetRenderState(e);
    }
  }

  _updateDrivenPit(e, dt) {
    const ps = e.pitState;
    const p = e.phys;
    const lane = this.circuit.pitLane;
    if (ps.phase === 'released') {
      e.pitState = null;
      return;
    }
    if (ps.phase === 'armed') {
      this._tryCommitPitEntry(e);
      return;
    }

    ps.laneT = (ps.laneT || 0) + dt;
    this._updatePitSpeeding(e, dt);
    // A stop can only service once it owns a concrete box. Arming/speeding probes
    // may briefly carry a driven state without one.
    if (!ps.box || !Number.isInteger(ps.box.idx)) {
      if (!p.corridor) return;
      const fallback = lane.boxes.find(row => row.num === e.driver.num)
        || lane.boxes[Math.max(0, Math.min(lane.boxes.length - 1, (e.gridPos || 1) - 1))];
      ps.box = fallback;
    }
    const boxSample = lane.samples[ps.box.idx];
    const dx = p.pos.x - boxSample.p.x, dz = p.pos.z - boxSample.p.z;
    const longitudinal = dx * boxSample.t.x + dz * boxSample.t.z;
    const lateral = dx * boxSample.n.x + dz * boxSample.n.z - ps.box.lateral;
    ps.distanceToBox = -longitudinal;

    if (ps.phase === 'lane' && ps.distanceToBox < 45) ps.phase = 'approaching-box';
    if (ps.phase === 'lane' || ps.phase === 'approaching-box') {
      const inWindow = Math.abs(longitudinal) <= PIT_BOX_STOP_WINDOW_M && Math.abs(lateral) <= 1.2;
      if (inWindow && Math.abs(p.v) < 0.4) {
        ps.phase = 'stopped';
        ps.phaseT = ps.serviceSeconds;
        ps.timer = ps.serviceSeconds;
        ps.reposition = false;
        // FIA 2026 B1.6.2 defines release only after the rear axle passes the
        // stationary front-axle position. Preserve that mark before the car moves.
        ps.stationaryFrontAxleS = this._pitArcPosition(p) + VEHICLE_DEFAULTS.frontCg;
        ps.releaseChecked = false;
        p.v = 0;
        if (e.isPlayer) {
          this._playerPitOpen = !ps.stopAndGo;
          this._pitStopEvent = true;
          this.onMessage(ps.stopAndGo
            ? 'STOP-AND-GO — HOLD 10 SECONDS, NO WORK'
            : 'PIT STOP — SERVICE UNDERWAY', 'yellow');
        }
        return;
      }
      const reposition = Math.abs(p.v) < 0.4 && Math.abs(longitudinal) < 9 && !inWindow;
      ps.reposition = reposition;
      if (reposition && !ps.repositionWarned) {
        ps.repositionWarned = true;
        if (e.isPlayer) this.onMessage('REPOSITION — CREW CANNOT REACH THE CAR', 'yellow');
      } else if (!reposition) ps.repositionWarned = false;
      // Passing the box must degrade to a drive-through, never an infinite
      // open-path clamp. An AI stop remains requested so it can retry next lap.
      if (p.sampleIdx >= lane.N - 1) {
        if (!ps.serviced && !e.isPlayer) e.boxThisLap = true;
        p.exitCorridor(lane.exitTrackIdx);
        p.pitLimiter = false;
        if (e.isPlayer) this.onPitLimiter?.(false);
        ps.phase = 'released';
        if (e.isPlayer) this._playerPitOpen = false;
        if (Number.isFinite(ps.laneT) && ps.laneT > 0) e.lastPitLoss = ps.laneT;
        this._resetSectors(e);
        this.resetRenderState(e);
      }
      return;
    }

    if (ps.phase === 'stopped') {
      p.v = 0;
      ps.phaseT = Math.max(0, ps.phaseT - dt);
      ps.timer = ps.phaseT;
      if (ps.phaseT > 0) return;
      if (ps.stopAndGo) {
        // FIA 2026 B1.6.2(b)(ii): no tyre, repair or other service work is
        // permitted during a Stop-and-Go; only the ten-second hold is served.
        ps.serviced = true;
        ps.phase = 'serviced';
        ps.fittedCompound = p.compound;
        if (e.stopAndGoPenalty?.status === 'pending') {
          e.stopAndGoPenalty.status = 'served';
          e.stopAndGoPenalty.servedAtLap = e.lap;
          e.stopAndGoPenalty.servedAtTime = this.raceTime;
        }
        if (e.isPlayer) this.onMessage('STOP-AND-GO SERVED', 'green');
        return;
      }
      const chosen = physicalCompound(ps.chosen || defaultNext(p.compound, this.conditions));
      p.setTyre(chosen);
      applyRepairPlan(e.damage, ps.repair);
      ps.serviced = true;
      ps.phase = 'serviced';
      ps.fittedCompound = chosen;
      e.tyreAgeLaps = 0;
      e.wingDamage = 0;
      p.dirtyAir = 0;
      if (CAR.setTyreCompound && e.carHandle) CAR.setTyreCompound(e.carHandle, chosen);
      return;
    }

    if (ps.phase === 'serviced') ps.phase = 'exit-lane';
    if (ps.phase !== 'exit-lane') return;
    this._checkUnsafeRelease(e);
    this._updatePitExitLine(e);
    const end = lane.samples[lane.N - 1];
    const endAlong = (p.pos.x - end.p.x) * end.t.x + (p.pos.z - end.p.z) * end.t.z;
    if (p.sampleIdx < lane.N - 1 || endAlong < -1.2) return;
    const fitted = ps.fittedCompound || p.compound;
    const repaired = ps.wing;
    if (!ps.stopAndGo) {
      e.strategyCompound = fitted;
      e.strategy?.confirmStop();
    }
    p.exitCorridor(lane.exitTrackIdx);
    p.pitLimiter = false;
    if (e.isPlayer) this.onPitLimiter?.(false);
    ps.phase = 'released';
    if (e.isPlayer) this._playerPitOpen = false;
    // Record total pit loss for validation (lane + service wall-clock).
    if (Number.isFinite(ps.laneT) && ps.laneT > 0) e.lastPitLoss = ps.laneT;
    else if (Number.isFinite(ps.enteredAt)) e.lastPitLoss = Math.max(0, this.raceTime - ps.enteredAt);
    this._resetSectors(e);
    this.resetRenderState(e);
    if (e.isPlayer) {
      if (!ps.stopAndGo) {
        this.onMessage(`${COMPOUNDS[fitted].name} TYRES FITTED`, 'green');
        if (repaired) this._radio('New nose on, wing damage fixed — push now.', 'info', true);
      }
    }
  }

  _updatePitSpeeding(e, dt) {
    const ps = e.pitState, limit = this.circuit.pitLane.speedLimit;
    if (!ps || ps.speedingPenalised) return;
    // Only count sustained overspeed while the car is actually in the lane.
    // The limiter, when engaged, keeps v at the limit so this cannot fire.
    const speed = e.phys.v;
    const previousSpeed = ps.speedingLastV;
    ps.speedingLastV = speed;
    const over = !!(e.phys.corridor && speed > limit + 1e-3);
    if (!over) {
      ps.speedingT = 0;
      ps.speedingCorrectionOnsetUsed = false;
      ps.speedingCorrectionElapsed = null;
      ps.speedingCorrectionDeadline = null;
      return;
    }
    const deceleration = Number.isFinite(previousSpeed) && dt > 0
      ? (previousSpeed - speed) / dt
      : 0;
    const correctionEta = deceleration > 1e-6
      ? (speed - limit) / deceleration
      : Infinity;
    // Pause, but do not erase, the held-overspeed window while the car is
    // demonstrably converging on the limit. If correction stalls, accumulation
    // resumes from the existing offence time; merely having no pedal input is
    // never an exemption.
    // Deceleration takes one physics tick to reach its settled rate. Exempt one
    // meaningful onset tick for the entire continuous overspeed episode; a
    // flat/increasing tick cannot re-arm it. Pedal state is deliberately not
    // consulted, so identical speed traces are adjudicated identically.
    const correctionStarted = deceleration > 1e-6 &&
      !ps.speedingCorrectionOnsetUsed;
    if (correctionStarted) ps.speedingCorrectionOnsetUsed = true;
    const correctionCandidate = correctionStarted ||
      correctionEta <= PIT_SPEED_CORRECTION_HORIZON;
    if (correctionCandidate && !Number.isFinite(ps.speedingCorrectionElapsed)) {
      ps.speedingCorrectionElapsed = 0;
    }
    if (Number.isFinite(ps.speedingCorrectionElapsed)) {
      ps.speedingCorrectionElapsed += dt;
    }
    // Pin the first prompt projection as an absolute deadline. Recomputing a
    // fresh relative ETA every tick lets fading deceleration claim "two seconds
    // away" forever without arriving. The deadline may be beaten, never moved.
    if (!Number.isFinite(ps.speedingCorrectionDeadline) &&
        correctionEta <= PIT_SPEED_CORRECTION_HORIZON) {
      ps.speedingCorrectionDeadline = ps.speedingCorrectionElapsed + correctionEta;
    }
    const projectedArrival = ps.speedingCorrectionElapsed + correctionEta;
    const correctionOnSchedule = correctionEta <= PIT_SPEED_CORRECTION_HORIZON &&
      projectedArrival <= ps.speedingCorrectionDeadline + 1e-6;
    const correcting = correctionStarted || correctionOnSchedule;
    if (!correcting) {
      ps.speedingT = (ps.speedingT || 0) + dt;
    }
    // Spec: accumulated > 0.35 s of continuous held overspeed.
    if (!(ps.speedingT > 0.35)) return;
    ps.speedingPenalised = true;
    this._pitPenalty(e, 5, 'PIT LANE SPEEDING — +5s PENALTY',
      'Pit lane speeding — five second penalty.');
  }

  _updatePitExitLine(e) {
    const ps = e.pitState, p = e.phys, lane = this.circuit.pitLane;
    // This is a customary Race Director Event Notes restriction, not a rule in
    // the 2026 Sporting Regulations. Circuits may disable the house rule.
    if (!lane.exitLineEnforced) return;
    if (p.sampleIdx < lane.exitBlendStartIdx || p.sampleIdx >= lane.N - 1) return;
    const crossed = lane.pitSide * p.lat < -(lane.halfWidth - 0.5);
    if (!crossed) { ps.exitLineLatched = false; return; }
    if (ps.exitLineLatched) return;
    ps.exitLineLatched = true;
    e.pitExitLineOffences = (e.pitExitLineOffences || 0) + 1;
    if (e.pitExitLineOffences === 1) {
      this.onMessage('PIT EXIT LINE — WARNING', 'yellow');
      this._radio('Pit exit line — warning. Stay inside the solid white line.', 'warning', true);
    } else {
      this._pitPenalty(e, 5, 'PIT EXIT LINE — +5s PENALTY',
        'Repeated pit exit line infringement — five second penalty.');
    }
  }

  _pitPenalty(e, seconds, message, radio) {
    e.penaltySeconds += seconds;
    // Penalties still attach to the entry for classification, but only the
    // player's own infringements flash the HUD / engineer radio.
    if (e.isPlayer) {
      this.onMessage(message, 'red', { flash: true, eventKey: `pit:${e.driver.id}:${message}` });
      this._radio(radio, 'warning', true);
    }
  }

  _pitArcPosition(phys) {
    const lane = this.circuit.pitLane;
    if (phys?.corridor !== lane || !lane?.samples?.length) return NaN;
    const idx = Math.max(0, Math.min(lane.N - 1, Math.round(phys.sampleIdx) || 0));
    const sample = lane.samples[idx];
    const along = (phys.pos.x - sample.p.x) * sample.t.x +
      (phys.pos.z - sample.p.z) * sample.t.z;
    return sample.s + along;
  }

  _canServeStopAndGo(e) {
    if (this.mode !== 'race' || this.phase !== 'racing' || e.dnf || e.finished) return false;
    const completedLap = Math.max(0, Number.isFinite(e.lap) ? e.lap : 0);
    // FIA 2026 B1.9.6(d): a Stop-and-Go imposed during the last three laps is
    // converted to 30 seconds, rather than requiring a physical return stop.
    return this.laps - completedLap > 3;
  }

  _imposeUnsafeReleasePenalty(e) {
    if (e.stopAndGoPenalty?.status === 'pending') return;
    if (!this._canServeStopAndGo(e)) {
      e.stopAndGoPenalty = {
        type: 'stop-and-go', reason: 'unsafe-release', status: 'converted',
        equivalentSeconds: STOP_AND_GO_EQUIVALENT_SECONDS,
        imposedAtLap: e.lap, imposedAtTime: this.raceTime, conversionReason: 'too late',
      };
      // FIA 2026 B1.6.2(b)(ii) specifies Stop-and-Go for unsafe release;
      // B1.9.6(d) specifies +30 seconds when it cannot be served this late.
      this._pitPenalty(e, STOP_AND_GO_EQUIVALENT_SECONDS,
        'UNSAFE RELEASE — +30s PENALTY',
        'Unsafe release — Stop-and-Go converted to thirty seconds.');
      return;
    }
    e.stopAndGoPenalty = {
      type: 'stop-and-go', reason: 'unsafe-release', status: 'pending',
      holdSeconds: STOP_AND_GO_SECONDS,
      imposedAtLap: e.lap, imposedAtTime: this.raceTime,
    };
    e.boxThisLap = true;
    e.plannedPitLap = -1;
    if (e.isPlayer) {
      this.onMessage('UNSAFE RELEASE — STOP-AND-GO', 'red', {
        flash: true,
        eventKey: `pit:${e.driver.id}:unsafe-release-stop-and-go`,
      });
      this._radio('Unsafe release — Stop-and-Go. Box this lap and hold for ten seconds.',
        'warning', true);
    }
  }

  _convertPendingStopAndGo(e, reason) {
    const penalty = e?.stopAndGoPenalty;
    if (penalty?.status !== 'pending') return false;
    penalty.status = 'converted';
    penalty.equivalentSeconds = STOP_AND_GO_EQUIVALENT_SECONDS;
    penalty.conversionReason = reason;
    // FIA 2026 B1.9.6(d) gives a Stop-and-Go a +30-second classified-time
    // equivalent when it is not served before the session can accept it.
    this._pitPenalty(e, STOP_AND_GO_EQUIVALENT_SECONDS,
      'STOP-AND-GO UNSERVED — +30s',
      'Stop-and-Go could not be served — thirty seconds added.');
    e.boxThisLap = false;
    return true;
  }

  _checkUnsafeRelease(e) {
    const ps = e.pitState;
    const lane = this.circuit.pitLane;
    if (!ps?.driven || ps.releaseChecked || e.phys.corridor !== lane ||
        !Number.isFinite(ps.stationaryFrontAxleS)) return false;

    const centerS = this._pitArcPosition(e.phys);
    const rearAxleS = centerS - VEHICLE_DEFAULTS.rearCg;
    // FIA 2026 B1.6.2: release occurs only once the rear axle has passed the
    // position occupied by the front axle in the stationary pit-stop position.
    if (!(rearAxleS >= ps.stationaryFrontAxleS)) return false;
    ps.releaseChecked = true;

    const unsafe = this.entries.some(other => {
      if (other === e || other.dnf || other.finished || other.phys.disabled ||
          other.phys.corridor !== lane || !(other.phys.v > 1)) return false;
      const otherFrontAxleS = this._pitArcPosition(other.phys) + VEHICLE_DEFAULTS.frontCg;
      const gapBehind = rearAxleS - otherFrontAxleS;
      // A moving car whose front axle is already alongside, or will reach the
      // release mark in roughly one second, owns the fast-lane path.
      return gapBehind >= -VEHICLE_DEFAULTS.wheelbase &&
        gapBehind <= Math.max(8, other.phys.v * 1.1);
    });
    if (unsafe) this._imposeUnsafeReleasePenalty(e);
    return unsafe;
  }

  _placeInPitLane(e, fromIdx, toIdx, t, speed, fromLateral = 0, toLateral = 0) {
    const c = this.circuit;
    const lane = c.pitLane;
    const u = Math.max(0, Math.min(1, t));
    const idx = Math.max(0, Math.min(lane.N - 1,
      Math.round(fromIdx + (toIdx - fromIdx) * u)));
    const s = lane.samples[idx];
    const lateral = fromLateral + (toLateral - fromLateral) * u;
    const previousTrackIdx = e.phys.trackIdx ?? e.phys.sampleIdx;
    if (e.phys.corridor !== lane) e.phys.enterCorridor(lane, idx);
    let dd = s.trackIdx - previousTrackIdx;
    if (dd > c.N / 2) dd -= c.N;
    if (dd < -c.N / 2) dd += c.N;
    if (dd > 0) e.phys.totalDist += dd * c.ds;
    e.phys.pos.copy(s.p).addScaledVector(s.n, lateral);
    e.phys.heading = Math.atan2(s.t.x, s.t.z);
    e.phys.sampleIdx = idx;
    e.phys.trackIdx = s.trackIdx;
    e.phys.lat = lateral;
    e.phys.trackLat = c.lateralAt(e.phys.pos, s.trackIdx);
    e.phys.v = speed;
    e.phys.gear = speed > 1 ? 3 : 1;
    e.phys.offTrack = false;
    e.mesh.visible = true;
    if (previousTrackIdx - s.trackIdx > c.N / 2) e._pitCrossPending = true;
  }

  playerChooseTyre(key) {
    if (!this.player?.pitState || this.player.pitState.stopAndGo || !COMPOUNDS[key]) return false;
    this.player.pitState.chosen = key;
    this._playerPitOpen = false;
    return true;
  }
  playerRequestBox() {
    if (this.player && !this.player.finished && this.mode === 'race' && this.phase === 'racing') {
      if (this.player.pitState?.driven && this.player.pitState.phase !== 'armed') return false;
      if (this.player.pitState?.phase === 'armed') {
        if (this.player.stopAndGoPenalty?.status === 'pending') {
          this.onMessage('STOP-AND-GO — PIT ENTRY REQUIRED', 'red');
          return false;
        }
        this.player.pitState = null;
        this.player.boxThisLap = false;
        this.onMessage('STAYING OUT', '');
        return true;
      }
      this._enterPit(this.player);
      this.onMessage('BOX THIS LAP — CONFIRMED', '');
      return true;
    }
    return false;
  }

  _retire(e, cause = 'mechanical') {
    if (!e || e.dnf) return;
    // This simulator has no next-event grid-penalty carryover. Preserve the
    // requested FIA B1.9.6(d) severity by recording the +30 s equivalent when
    // a retirement makes a pending Stop-and-Go impossible to serve.
    this._convertPendingStopAndGo(e, 'retirement');
    e.dnf = true;
    e.failureCause = cause || 'mechanical';
    e.retirementTime = this.raceTime;
    e.retirementProgress = e.lap * this.circuit.length +
      (e.phys.trackIdx ?? e.phys.sampleIdx) * this.circuit.ds;
    e.phys.disabled = true;
    e.mesh.visible = false;
    if (e.ai) { e.ai.vscFactor = 1; e.ai.noOvertake = false; }
    this.onMessage(`${e.driver.code} RETIRES — ${partLabel(e.failureCause).toUpperCase()}`, 'yellow');
    // a car stopping on track often brings out the VSC, but only when there is
    // still enough of the race left to be worth neutralising
    const leadLap = this.entries.reduce((m, x) => Math.max(m, x.lap), 0);
    if (this.mode === 'race' && this.phase === 'racing' && !this.raceControl.active &&
        this.laps - leadLap > 2 && this.random() < 0.4) {
      this._startVSC(18 + this.random() * 12);
    } else if (this.mode === 'race' && this.phase === 'racing' && !this.raceControl.active &&
        this.laps - leadLap > 1) {
      const zone = Math.max(2, Math.round(80 / this.circuit.ds));
      const at = e.phys.trackIdx ?? e.phys.sampleIdx;
      this.requestRaceControl('local-yellow', {
        duration: 10 + this.random() * 6,
        reason: cause,
        zone: { start: at - zone, end: at + zone },
      });
    }
  }

  _collisions() {
    const es = this.entries;
    const bodies = es.map((entry) => syncContactBody(entry._contactBody || (entry._contactBody = {}), entry.phys));
    applyNetworkMass(es, bodies);
    const activeNow = new Set();
    const impactingBefore = this._impactingContacts || new Set();
    const impactingNow = new Set();
    const damagingBefore = this._damagingContacts || new Set();
    const damagingNow = new Set();
    const impacts = [];
    const baseVx = new Float64Array(es.length);
    const baseVz = new Float64Array(es.length);
    const deltaVx = new Float64Array(es.length);
    const deltaVz = new Float64Array(es.length);

    const worldVelocity = { x: 0, z: 0 };
    for (let i = 0; i < es.length; i++) {
      velocityOf(bodies[i], worldVelocity);
      baseVx[i] = worldVelocity.x;
      baseVz[i] = worldVelocity.z;
    }

    for (const e of es) {
      e.phys.carScrape = 0;
      e.phys.carScrapeSide = 0;
    }

    // Capture contact-entry kinematics before positional correction. Audio and
    // damage are based on relative velocity, never on overlap depth.
    for (let i = 0; i < es.length; i++) {
      const A = es[i];
      if (A.phys.disabled || A.dnf) continue;
      for (let j = i + 1; j < es.length; j++) {
        const B = es[j];
        if (B.phys.disabled || B.dnf) continue;
        // Same hold-zone ghosting rule as the position solver above.
        if (A.phys.corridor?.isProtectedIdx(A.phys.sampleIdx)
          || B.phys.corridor?.isProtectedIdx(B.phys.sampleIdx)) continue;
        const contact = orientedCarContact(bodies[i], bodies[j]);
        if (!contact) continue;
        const aId = String(A.driver?.id ?? i);
        const bId = String(B.driver?.id ?? j);
        const key = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
        activeNow.add(key);
        if (damagingBefore.has(key)) damagingNow.add(key);
        const rvx = baseVx[i] - baseVx[j];
        const rvz = baseVz[i] - baseVz[j];
        const closing = Math.max(0, -(rvx * contact.nx + rvz * contact.nz));
        const tx = -contact.nz;
        const tz = contact.nx;
        const tangentSpeed = rvx * tx + rvz * tz;
        const scrape = Math.max(0, Math.min(1, (Math.abs(tangentSpeed) - 0.5) / 14));
        A.phys.carScrape = Math.max(A.phys.carScrape, scrape);
        B.phys.carScrape = Math.max(B.phys.carScrape, scrape);
        if (scrape >= A.phys.carScrape) A.phys.carScrapeSide = contactSideFor(bodies[i], contact.nx, contact.nz, true);
        if (scrape >= B.phys.carScrape) B.phys.carScrapeSide = contactSideFor(bodies[j], contact.nx, contact.nz, false);
        if (impactingBefore.has(key) && closing > 0.15) impactingNow.add(key);
        impacts.push({ i, j, A, B, a: bodies[i], b: bodies[j], contact, closing, tangentSpeed, key });
      }
    }

    const corrX = new Float64Array(es.length);
    const corrZ = new Float64Array(es.length);

    // First remove the overlap represented by the captured contact normal. This
    // preserves the established pack behaviour and gives the impulse a valid
    // non-penetrating starting configuration.
    solveContactPositions(this, es, bodies, corrX, corrZ);

    // Low-restitution impulse plus capped tangential friction. Every pair reads
    // the same pre-solve velocity snapshot and accumulates a world-space delta;
    // applying once per car removes entry-order bias in three-car pileups.
    for (const impact of impacts) {
      const { i, j, A, B, a, b, contact, closing, tangentSpeed, key } = impact;
      if (closing <= 0.5) continue;
      const invSum = a.invMass + b.invMass;
      if (!(invSum > 0)) continue;   // both cars owned by other machines
      const normalImpulse = (1.04 * closing) / invSum;
      const tx = -contact.nz;
      const tz = contact.nx;
      const tangentImpulse = Math.max(-normalImpulse * 0.16,
        Math.min(normalImpulse * 0.16, -tangentSpeed / invSum));
      const impulseX = contact.nx * normalImpulse + tx * tangentImpulse;
      const impulseZ = contact.nz * normalImpulse + tz * tangentImpulse;
      deltaVx[i] += impulseX * a.invMass;
      deltaVz[i] += impulseZ * a.invMass;
      deltaVx[j] -= impulseX * b.invMass;
      deltaVz[j] -= impulseZ * b.invMass;
      const intensity = Math.max(0, Math.min(1, (closing - 0.5) / 18));
      // Keep sub-3 m/s rubs physical (separation, scrape, sound) but not
      // destructive. The old damage curve began at 0.5 m/s, so routine pack
      // contacts accumulated suspension loss until terminal failure even when
      // no individual collision was meaningful.
      const damageIntensity = Math.max(0, Math.min(1, (closing - 3) / 18));
      A.phys.impactKick = Math.max(A.phys.impactKick || 0, intensity * 0.75);
      B.phys.impactKick = Math.max(B.phys.impactKick || 0, intensity * 0.75);

      const newImpact = !impactingBefore.has(key);
      const aFront = contactLongitudinalFor(a, contact.nx, contact.nz, true) > 0.45;
      const bFront = contactLongitudinalFor(b, contact.nx, contact.nz, false) > 0.45;
      const aSide = contactSideFor(a, contact.nx, contact.nz, true);
      const bSide = contactSideFor(b, contact.nx, contact.nz, false);
      if (newImpact) {
        impactingNow.add(key);
        if (A.isPlayer || B.isPlayer) {
          const playerBody = A.isPlayer ? a : b;
          const candidate = {
            intensity,
            closingSpeed: closing,
            side: contactSideFor(playerBody, contact.nx, contact.nz, A.isPlayer),
          };
          const current = this._touchEvent;
          if (!current || candidate.intensity > (current.intensity || 0) ||
              (candidate.intensity === (current.intensity || 0) &&
                candidate.closingSpeed > (current.closingSpeed || 0))) {
            this._touchEvent = candidate;
          }
        }
        if (closing > 8) {
          // Front-wing damage belongs only to a nose-first participant. The
          // car being rear-ended, or either car in a sidepod rub, is not assigned
          // fictitious front-wing damage.
          if (aFront) this._maybeWingDamage(A, 'car');
          if (bFront) this._maybeWingDamage(B, 'car');
        }
      }

      // Damage has a separate once-per-contact latch. Feedback may legitimately
      // fire when a real impulse develops during an existing harmless overlap;
      // destructive damage may also start there, but it cannot re-arm on later
      // closing-speed oscillations until the bodies physically separate.
      const newDamageImpact = damageIntensity > 0 && !damagingBefore.has(key);
      if (newDamageImpact) {
        damagingNow.add(key);
        applyImpactDamage(A.damage, {
          severity: damageIntensity * 0.55, front: aFront, side: aSide * (aFront ? 0.2 : 1),
        }, this.random);
        applyImpactDamage(B.damage, {
          severity: damageIntensity * 0.55, front: bFront, side: bSide * (bFront ? 0.2 : 1),
        }, this.random);
      } else if (newImpact) {
        // Keep the deterministic race RNG stream stable when damage is
        // suppressed. The legacy path consumed these draws for every impact
        // edge; apply them to snapshots so later reliability/strategy draws do
        // not change merely because harmless contact stopped damaging the car.
        applyImpactDamage({ ...A.damage }, {
          severity: intensity * 0.55, front: aFront, side: aSide * (aFront ? 0.2 : 1),
        }, this.random);
        applyImpactDamage({ ...B.damage }, {
          severity: intensity * 0.55, front: bFront, side: bSide * (bFront ? 0.2 : 1),
        }, this.random);
      }
    }

    for (let i = 0; i < es.length; i++) {
      if (deltaVx[i] === 0 && deltaVz[i] === 0) continue;
      // applyContactVelocity accepts the legacy forward-vector plus a delta and
      // reapplies the body's existing lateral velocity internally. Supplying
      // the full world snapshot here would count that lateral term twice.
      applyContactVelocity(es[i].phys,
        bodies[i].fx * es[i].phys.v + deltaVx[i],
        bodies[i].fz * es[i].phys.v + deltaVz[i]);
    }

    // Apply at most one real wall impulse after contact has changed velocity and
    // heading. The geometry pass below then resolves bodies using this final
    // response; running the wall impulse after it can recreate deep overlap.
    for (const e of es) {
      if (e.netRemote) continue;
      const wallHit = e.phys.resolveWallCollision?.(true) || 0;
      if (wallHit) this._handleWallImpact?.(e, wallHit);
    }

    // Solve positions after velocity impulses have updated headings. Doing this
    // in the opposite order let a final yaw-aware wall projection move a newly
    // rotated car deep into its neighbour. Eight alternating Jacobi/contact and
    // wall passes converge small packs and wall squeezes without pair-order bias.
    solveContactPositions(this, es, bodies, corrX, corrZ);

    // Finish with geometry-only wall projection: never rotate a car after the
    // last body constraint pass.
    for (const e of es) if (!e.netRemote) e.phys.projectWallConstraint?.();
    this._activeContacts = activeNow;
    this._impactingContacts = impactingNow;
    this._damagingContacts = damagingNow;
  }

  _updatePositions() {
    const c = this.circuit;
    const live = this.entries.filter(e => !e.dnf);
    const inPit = e => isInPits(e) || !!e.netPit;
    const progOf = e => (e.lap) * c.length +
      (e.phys.trackIdx ?? e.phys.sampleIdx) * c.ds + (inPit(e) ? -2 : 0);
    live.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return progOf(b) - progOf(a);
    });
    live.forEach((e, i) => { e.position = i + 1; });
    this.entries.filter(e => e.dnf).forEach((e, i) => { e.position = live.length + 1 + i; });
    for (const e of this.entries) e.positionsGained = (e.gridPos ?? e.position) - e.position;
    const leader = live[0];
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      if (i === 0) { e.gapText = 'LEADER'; e.intervalText = ''; continue; }
      const ahead = live[i - 1];
      const di = progOf(ahead) - progOf(e);
      e.intervalText = '+' + (di / Math.max(e.phys.v, 28)).toFixed(1);
      if (inPit(e)) { e.gapText = 'PIT'; continue; }
      const dp = progOf(leader) - progOf(e);
      if (dp > c.length) e.gapText = `+${Math.floor(dp / c.length)}L`;
      else e.gapText = '+' + (dp / Math.max(e.phys.v, 28)).toFixed(1);
    }
  }

  _updateQuali() {
    const e = this.player;
    this.aiQualiTimes = this.entries
      .filter(entry => !entry.isPlayer && entry.bestLap > 0)
      .map(entry => ({ driverId: entry.driver.id, time: entry.bestLap, actual: true, laps: entry.lapTimes.length }));
    if (!e || this.qualiState === 'done') return;
    if (this.qualiState === 'awaiting-field') {
      const active = this.entries.filter(entry => !entry.phys.disabled);
      if (active.every(entry => entry.bestLap > 0)) this.qualiState = 'done';
      return;
    }
    // Once the player has been eliminated, the remaining AI still completes
    // Q2/Q3 through the normal CarPhysics + AIDriver path. focusEntry gives the
    // browser a live car to follow without changing player identity.
    if (e.phys.disabled) {
      this.qualiState = 'awaiting-field';
      return;
    }
    // detect SF crossing handled in _onCross via lap counter
    if (this.qualiState === 'outlap' && e.lap >= 0) {
      this.qualiState = 'flying';
      this.onMessage('FLYING LAP — GO!', 'green');
    } else if (this.qualiState === 'flying' && e.lap >= 1) {
      if (this.trial) {
        // time trial: keep lapping; bestLap accumulates
        if (e.lastLap && e.lapTimes.length && e.lapTimes[e.lapTimes.length - 1] === e.lastLap && this._lastAnnounced !== e.lapTimes.length) {
          this._lastAnnounced = e.lapTimes.length;
          this.onMessage(`LAP ${fmtTime(e.lastLap)}${e.lastLap === e.bestLap ? ' — PERSONAL BEST' : ''}`, e.lastLap === e.bestLap ? 'purple' : '');
        }
      } else {
        this.qualiTime = e.lastLap;
        const fieldComplete = this.entries
          .filter(entry => !entry.phys.disabled)
          .every(entry => entry.bestLap > 0);
        this.qualiState = fieldComplete ? 'done' : 'awaiting-field';
      }
    }
  }

  qualiClassification() {
    const rows = this.entries.map((entry) => ({
      driverId: entry.driver.id,
      time: entry.bestLap || (entry.isPlayer ? this.qualiTime : 0) || 9999,
      actual: !!entry.bestLap,
      laps: entry.lapTimes.length,
      eliminated: this.qualifying?.eliminated.includes(entry.driver.id) || false,
    }));
    rows.sort((a, b) => Number(a.eliminated) - Number(b.eliminated) ||
      a.time - b.time || a.driverId.localeCompare(b.driverId));
    return rows;
  }

  practiceClassification() { return this.qualiClassification(); }

  currentQualifyingClassification() {
    const eliminated = new Set(this.qualifying?.eliminated || []);
    return this.qualiClassification().filter(row => !eliminated.has(row.driverId));
  }

  /**
   * Assemble a real staged grid: Q3 order, then the Q2 eliminations, then the
   * Q1 eliminations. Each row retains the lap actually earned in that stage.
   */
  finalQualifyingClassification() {
    const stages = this.qualifying?.stageResults || {};
    const q1 = stages.Q1 || [];
    const q2 = stages.Q2 || [];
    const q3 = stages.Q3 || [];
    if (!q1.length || !q2.length || !q3.length) return this.qualiClassification();
    const q2Ids = new Set(q2.map(row => row.driverId));
    const q3Ids = new Set(q3.map(row => row.driverId));
    return [
      ...q3.map(row => ({ ...row, eliminatedStage: null })),
      ...q2.filter(row => !q3Ids.has(row.driverId))
        .map(row => ({ ...row, eliminatedStage: 'Q2' })),
      ...q1.filter(row => !q2Ids.has(row.driverId))
        .map(row => ({ ...row, eliminatedStage: 'Q1' })),
    ];
  }

  /** Advance an explicit Q1 → Q2 → Q3 format using only completed track laps. */
  advanceQualifyingStage() {
    if (this.mode !== 'quali' || this.trial || !this.qualifying) return null;
    const current = this.qualifying.stage;
    const next = current === 'Q1' ? 'Q2' : current === 'Q2' ? 'Q3' : 'done';
    const stageRows = this.currentQualifyingClassification();
    this.qualifying.stageResults[current] = stageRows.map(row => ({ ...row }));
    if (next === 'done') {
      this.qualifying.stage = 'done';
      this.qualiState = 'done';
      this.focusEntry = this.player;
      return {
        stage: 'done',
        survivors: stageRows.map(row => row.driverId),
        eliminated: [...this.qualifying.eliminated],
        classification: this.finalQualifyingClassification(),
        playerActive: stageRows.some(row => row.driverId === this.playerDriverId),
      };
    }
    const keep = next === 'Q2' ? 15 : 10;
    const survivors = new Set(stageRows.slice(0, keep).map(row => row.driverId));
    this.qualifying.eliminated.push(...stageRows.slice(keep).map(row => row.driverId)
      .filter(id => !this.qualifying.eliminated.includes(id)));
    const active = this.entries.filter(entry => survivors.has(entry.driver.id));
    active.forEach((entry, index) => {
      const idx = Math.round((index / Math.max(1, active.length)) * this.circuit.N) % this.circuit.N;
      const sample = this.circuit.samples[idx];
      entry.phys.placeAt(sample.p.clone(), Math.atan2(sample.t.x, sample.t.z), idx);
      entry.phys.v = 40;
      entry.phys.gear = 5;
      entry.phys.setTyre('S');
      if (CAR.setTyreCompound) CAR.setTyreCompound(entry.carHandle, 'S');
      entry.strategyCompound = 'S';
      entry.phys.disabled = false;
      entry.mesh.visible = true;
      entry.lap = -1;
      entry.maxLap = -1;
      entry.lapTimes = [];
      entry.lastLap = 0;
      entry.bestLap = 0;
      entry.tyreAgeLaps = 0;
      this._resetSectors(entry);
    });
    this.entries.filter(entry => !survivors.has(entry.driver.id)).forEach(entry => {
      entry.phys.disabled = true;
      entry.mesh.visible = false;
    });
    this.qualifying.stage = next;
    const playerActive = survivors.has(this.playerDriverId);
    this.focusEntry = playerActive ? this.player : (active[0] || this.player);
    this.qualiState = playerActive ? 'outlap' : 'awaiting-field';
    this.qualiTime = null;
    this.aiQualiTimes = [];
    this.resetRenderState();
    this.onMessage(`${next} STARTED`, 'green', { eventKey: `quali:${next}` });
    return {
      stage: next,
      survivors: [...survivors],
      eliminated: [...this.qualifying.eliminated],
      playerActive,
    };
  }

  _classify() {
    const c = this.circuit;
    // Defensive session-end backstop for unusual hard-cut / snapshot paths.
    for (const entry of this.entries) this._convertPendingStopAndGo(entry, 'session end');
    const progOf = e => e.lap * c.length + (e.phys.trackIdx ?? e.phys.sampleIdx) * c.ds;
    // time penalties are served here, so they can reorder the classification
    const ft = e => e.finishTime + (e.penaltySeconds || 0);
    const fin = this.entries.filter(e => e.finished).sort((a, b) => ft(a) - ft(b));
    const run = this.entries.filter(e => !e.finished && !e.dnf).sort((a, b) => progOf(b) - progOf(a));
    const dnf = this.entries.filter(e => e.dnf).sort((a, b) =>
      (b.retirementProgress ?? progOf(b)) - (a.retirementProgress ?? progOf(a)) ||
      (b.retirementTime ?? 0) - (a.retirementTime ?? 0) ||
      a.driver.id.localeCompare(b.driver.id));
    const order = [...fin, ...run, ...dnf];
    const winner = order[0];
    const refLap = winner.bestLap || (ft(winner) / Math.max(1, winner.lap)) || 90;
    // gaps must be monotonic down the classification: a running car's
    // progress-estimated gap can otherwise undercut a finisher's real gap
    let prevGapS = 0;
    this.results = order.map((e, i) => {
      let gapText;
      if (e.dnf) gapText = 'DNF';
      else if (i === 0) gapText = fmtTime(ft(e), true);
      else if (e.finished) {
        const gs = ft(e) - ft(winner);
        prevGapS = Math.max(prevGapS, gs);
        gapText = '+' + fmtTime(gs);
      } else {
        const dl = (progOf(winner) - progOf(e)) / c.length;
        if (dl >= 1) gapText = '+' + Math.floor(dl) + ' LAP' + (dl >= 2 ? 'S' : '');
        else {
          const gs = Math.max(0.001, dl * refLap, prevGapS + 0.4);
          prevGapS = gs;
          gapText = '+' + fmtTime(gs);
        }
      }
      return {
        pos: i + 1,
        gridPos: e.gridPos,
        driver: e.driver, team: e.team, isPlayer: e.isPlayer,
        dnf: e.dnf,
        laps: Math.max(0, e.lap),
        pits: e.pitStops,
        bestLap: e.bestLap,
        gapText,
        penaltySeconds: Number.isFinite(e.penaltySeconds) ? Math.max(0, e.penaltySeconds) : 0,
        points: (i < POINTS.length && !e.dnf) ? POINTS[i] : 0,
        fastestLap: this.fastestLap && this.fastestLap.driverId === e.driver.id,
        status: e.dnf ? 'DNF' : e.finished ? 'FINISHED' : 'CLASSIFIED',
        failureCause: e.dnf ? (e.failureCause || 'retired') : null,
      };
    });
    // post-flag verdict over the radio, using the final classification
    const pr = this.results.find(r => r.isPlayer);
    if (pr && !this._radioResult) {
      this._radioResult = true;
      const n = pr.pos;
      const verdict = pr.dnf ? 'Sorry about that — the car let us down.'
        : n === 1 ? 'Superb drive — that is the win!'
        : n <= 3 ? 'On the podium, brilliant job.'
        : n <= 10 ? 'Points on the board, well driven.'
        : 'Not our day — we go again next time.';
      this._radio(`P${n}. ${verdict}`, !pr.dnf && n <= 3 ? 'celebration' : 'info', true);
    }
  }

  // ---------- private multiplayer ----------

  /** Entry lookup by driver id, built once and reused by the network path. */
  _entryFor(driverId) {
    if (!this._entryByDriver) {
      this._entryByDriver = new Map(this.entries.map(e => [e.driver.id, e]));
    }
    return this._entryByDriver.get(driverId) || null;
  }

  /** Driver ids whose cars this machine owns and therefore publishes. */
  networkOwnedDrivers() {
    if (this.netRole === 'guest') return this.player ? [this.player.driver.id] : [];
    return this.entries.map(e => e.driver.id);
  }

  /**
   * Transforms to send to the peers this frame.
   *
   * A guest publishes only the car it is steering. The host publishes every
   * car it renders — its own, the AI, and the poses it is relaying on behalf of
   * other guests — so a three-way race stays a star and never needs a mesh.
   */
  networkCarStates() {
    const source = this.netRole === 'guest'
      ? (this.player && !this.player.netRemote ? [this.player] : [])
      : this.entries;
    const cars = [];
    for (const e of source) {
      const p = e.phys;
      cars.push({
        id: e.driver.id,
        x: p.pos.x,
        y: this._renderHeight(e),
        z: p.pos.z,
        heading: p.heading,
        v: p.v,
        gear: p.gear,
        rpmFrac: p.rpmFrac,
        throttle: p.throttle,
        lap: e.lap,
        sampleIdx: p.sampleIdx,
        wear: p.wear,
        // Named conditions, not a wire format: packing them is the network
        // layer's business, and this module has no opinion about it.
        flags: {
          finished: e.finished,
          dnf: e.dnf,
          pit: !!e.pitState,
          offTrack: p.offTrack,
          boost: p.boosting,
          braking: p.brake > 0.15,
        },
      });
    }
    return cars;
  }

  /**
   * Hand a network-driven car its interpolated pose for the coming tick.
   * Ignored for cars this machine owns, so a hostile or confused peer cannot
   * move the car its player is steering.
   */
  setNetworkPose(driverId, pose) {
    const e = this._entryFor(driverId);
    if (!e || !e.netRemote || e.dnf) return false;
    e.netPose = pose && pose.valid ? pose : e.netPose;
    return true;
  }

  /**
   * A player whose connection went away stops being a car on the circuit.
   *
   * Without this their last known pose would sit on the racing line forever:
   * a hazard for everyone still driving, and a phantom entry in the final
   * classification. Retiring them is both the honest result and the safe one.
   */
  retireNetworkDriver(driverId) {
    const e = this._entryFor(driverId);
    if (!e || !e.netRemote || e.dnf) return false;
    const c = this.circuit;
    e.dnf = true;
    e.netPose = null;
    e.netPit = false;
    e.failureCause = 'disconnected';
    e.retirementTime = this.raceTime;
    e.retirementProgress = e.lap * c.length + e.phys.sampleIdx * c.ds;
    e.phys.disabled = true;
    if (e.mesh) e.mesh.visible = false;
    return true;
  }

  /** Retire every network-driven car at once — used when the link drops. */
  retireAllNetworkDrivers() {
    let retired = 0;
    for (const e of this.entries) {
      if (e.netRemote && this.retireNetworkDriver(e.driver.id)) retired++;
    }
    return retired;
  }

  /** Adopt the host's authoritative phase. Guest only; no-op elsewhere. */
  applyNetworkPhase(update) {
    if (this.netRole !== 'guest' || !update) return false;
    const nextPhase = update.phase;
    const changed = nextPhase && nextPhase !== this.phase;
    if (changed) {
      const before = this.phase;
      this.phase = nextPhase;
      this.phaseT = 0;
      if (nextPhase === 'lights') this.lightsOn = 0;
      if (nextPhase === 'racing' && before !== 'racing') {
        // Local timing restarts from the host's green, so every lap time the
        // guest's own HUD shows is measured against the same moment.
        this.lightsOut = true;
        this.raceTime = 0;
        for (const e of this.entries) e.lapStart = 0;
      }
    }
    const lights = Math.max(0, Math.min(6, Math.round(update.lightsOn || 0)));
    if (lights > this.lightsOn) this.lightsOn = lights;
    return changed;
  }

  /**
   * Replace the local classification with the host's official one, mapping
   * driver ids back onto this machine's own driver and team records.
   */
  applyNetworkResults(rows, fastestLapDriverId = null) {
    if (this.mode !== 'race' || !Array.isArray(rows) || !rows.length) return false;
    const mapped = [];
    for (const row of [...rows].sort((a, b) => a.pos - b.pos)) {
      const e = this._entryFor(row.driverId);
      if (!e) continue;
      mapped.push({
        pos: mapped.length + 1,
        gridPos: row.gridPos || e.gridPos,
        driver: e.driver,
        team: e.team,
        isPlayer: e.isPlayer,
        dnf: row.dnf,
        laps: row.laps,
        pits: row.pits,
        bestLap: row.bestLap,
        gapText: row.gapText,
        penaltySeconds: row.penaltySeconds,
        points: row.points,
        fastestLap: row.fastestLap,
        status: row.status,
        failureCause: row.failureCause,
      });
    }
    if (!mapped.length) return false;
    this.netResults = mapped;
    this.results = mapped;
    if (fastestLapDriverId) {
      const e = this._entryFor(fastestLapDriverId);
      if (e) {
        this.fastestLap = {
          driverId: fastestLapDriverId,
          time: e.bestLap || 0,
          name: e.driver.lastName,
          eventKey: `fastest:${fastestLapDriverId}:net`,
        };
      }
    }
    if (this.phase !== 'finished') { this.phase = 'finished'; this.phaseT = 0; }
    return true;
  }

  /**
   * Advance a car whose pose belongs to another machine. No controller, no
   * physics integration: the transform is authoritative and everything derived
   * from it (track sample, lap, flags) is recomputed against the local circuit.
   */
  _stepNetworkEntry(e, dt) {
    // A retired car is out. Nothing arriving late over the wire — a queued
    // packet, a peer that reconnects — may put it back on the circuit.
    if (e.dnf) return;
    const pose = e.netPose;
    const c = this.circuit;
    const p = e.phys;
    if (pose && pose.valid) {
      p.pos.x = pose.x;
      p.pos.y = pose.y;
      p.pos.z = pose.z;
      p.heading = pose.heading;
      p.v = pose.v;
      p.gear = Math.max(1, Math.min(8, Math.round(pose.gear)));
      p.rpmFrac = pose.rpmFrac;
      p.throttle = pose.throttle;
      p.wear = pose.wear;
      p.sampleIdx = c.nearestSample(p.pos, p.sampleIdx);
      p.lat = c.lateralAt(p.pos, p.sampleIdx);
      e.netPit = !!pose.pit;
      p.brake = pose.braking ? 1 : 0;
      p.offTrack = !!pose.offTrack;
      p.boosting = !!pose.boost;
      p.disabled = !!pose.dnf;
      e.lap = pose.lap;
      e.maxLap = Math.max(e.maxLap ?? -1, pose.lap);
      e.finished = !!pose.finished;
      if (pose.dnf && !e.dnf) {
        e.dnf = true;
        e.retirementTime = this.raceTime;
        e.retirementProgress = e.lap * c.length + p.sampleIdx * c.ds;
      }
      if (e.mesh) e.mesh.visible = !pose.dnf;
    }
    this._advanceWheelSpin(e, dt);
  }

  _renderHeight(e) {
    const p = e.phys;
    const path = p.corridor || this.circuit;
    if (!path || !path.heightAt) return 0;
    const sm = path.samples[p.sampleIdx];
    if (!sm) return 0;
    const along = (p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z;
    return path.heightAt(p.sampleIdx + along / path.ds);
  }

  _captureRenderState(e, target) {
    const p = e.phys;
    target.x = p.pos.x;
    target.y = this._renderHeight(e);
    target.z = p.pos.z;
    target.heading = p.heading;
    target.v = p.v || 0;
    target.wheelSpin = e.wheelSpin || 0;
    target.steer = p.roadWheelAngle || 0;
    target.pitch = p.pitch || 0;
    target.roll = p.roll || 0;
    target.rideBump = p.rideBump || 0;
    return target;
  }

  _ensureRenderState(e) {
    if (e.renderPrev && e.renderCurr && e.renderPose) return;
    e.renderPrev = makeRenderSnapshot();
    e.renderCurr = makeRenderSnapshot();
    e.renderPose = makeRenderSnapshot();
    this._captureRenderState(e, e.renderCurr);
    copyRenderSnapshot(e.renderCurr, e.renderPrev);
    copyRenderSnapshot(e.renderCurr, e.renderPose);
  }

  _beginRenderTick() {
    for (const e of this.entries) {
      this._ensureRenderState(e);
      copyRenderSnapshot(e.renderCurr, e.renderPrev);
    }
  }

  _finishRenderTick() {
    for (const e of this.entries) {
      this._ensureRenderState(e);
      this._captureRenderState(e, e.renderCurr);
    }
  }

  _advanceWheelSpin(e, dt) {
    if (Number.isFinite(dt) && dt > 0 && e.wheelRadius > 0) {
      e.wheelSpin += (e.phys.v / e.wheelRadius) * dt;
    }
  }

  /** Collapse interpolation history to authoritative state after construction,
   *  timing resets and teleports. Pass one entry for a local snap (pit/recovery). */
  resetRenderState(entry = null) {
    if (this._renderDisposed) return;
    const entries = entry ? [entry] : this.entries;
    for (const e of entries) {
      this._ensureRenderState(e);
      this._captureRenderState(e, e.renderCurr);
      copyRenderSnapshot(e.renderCurr, e.renderPrev);
      copyRenderSnapshot(e.renderCurr, e.renderPose);
      this._applyRenderPose(e, e.renderPose);
    }
  }

  /** Apply a render-only pose between the previous and current fixed ticks. */
  render(alpha) {
    if (this._renderDisposed) return;
    for (const e of this.entries) {
      this._ensureRenderState(e);
      interpolateRenderSnapshot(e.renderPrev, e.renderCurr, alpha, e.renderPose);
      this._applyRenderPose(e, e.renderPose);
    }
  }

  _applyRenderPose(e, pose) {
    if (!e.mesh) return;
    e.renderY = pose.y;
    e.mesh.position.set(pose.x, pose.y, pose.z);
    e.mesh.rotation.y = pose.heading;

    // Counter-rotate the local lobe so its direction remains fixed in world space.
    if (e.shadowLobe) {
      const a = SUN_GROUND_AZI - pose.heading;
      e.shadowLobe.position.set(Math.sin(a) * SUN_SHADOW_OFF, 0.002,
        Math.cos(a) * SUN_SHADOW_OFF);
      e.shadowLobe.rotation.z = -a;
    }

    for (const k of ['fl', 'fr', 'rl', 'rr']) {
      const w = e.wheels && e.wheels[k];
      if (!w) continue;
      w.rotation.x = pose.wheelSpin;
      if (k === 'fl' || k === 'fr') w.rotation.y = pose.steer;
      const farWheel = e.carHandle?.farProxy?.wheels?.[k];
      if (farWheel) {
        farWheel.rotation.x = pose.wheelSpin;
        if (k === 'fl' || k === 'fr') farWheel.rotation.y = pose.steer;
      }
    }

    const body = e.carHandle && e.carHandle.body;
    if (body) {
      body.rotation.x = pose.pitch;
      body.rotation.z = pose.roll;
      body.position.y = pose.rideBump;
    }
    const farBody = e.carHandle?.farProxy?.body;
    if (farBody) {
      farBody.rotation.x = pose.pitch;
      farBody.rotation.z = pose.roll;
      farBody.position.y = pose.rideBump;
    }

    // Race-state visual hooks remain presentation-only. They read authoritative
    // controls but never write physics or interpolation snapshots.
    const p = e.phys;
    const ud = e.mesh.userData || {};
    const glow = brakeGlowIntensity(p.brakeTemp, p.brake, p.v);
    applyBrakeGlowState(ud.brakeGlows, glow);
    applyBrakeGlowState(e.carHandle?.farProxy?.brakeGlows, glow);
    const harvesting = (p.brake > 0.1 || p.throttle < 0.25) && p.v > 12;
    const rainVisible = !harvesting || (Math.floor(performance.now() / 110) % 2 === 0);
    if (ud.rainLight) ud.rainLight.visible = rainVisible;
    if (e.carHandle?.farProxy?.rainLight) e.carHandle.farProxy.rainLight.visible = rainVisible;
  }

  _setEntryCarLod(e, level) {
    const handle = e?.carHandle;
    if (!handle) return false;
    const next = e.isPlayer ? 'full' : (level === 'far' ? 'far' : 'full');
    const changed = e.lodLevel !== next;
    e.lodLevel = next;
    handle.lodLevel = next;
    const fullRoots = handle.fullDetailRoots
      || [handle.body, handle.wheels?.fl, handle.wheels?.fr, handle.wheels?.rl, handle.wheels?.rr];
    for (const root of fullRoots) if (root) root.visible = next === 'full';
    if (handle.farProxy) handle.farProxy.root.visible = next === 'far';
    if (e.contactShadow) e.contactShadow.visible = next === 'full';
    if (changed) this._carLodSwitches++;
    return changed;
  }

  /** Select AI detail against the already-settled render camera at 10 Hz. */
  updateCarLod(camera, nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (this._renderDisposed || !camera?.position) return false;
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const clockRebased = now < this._carLodLastAt;
    if (this._carLodInitialized && !clockRebased && now < this._carLodNextAt) {
      return false;
    }
    this._carLodInitialized = true;
    this._carLodLastAt = now;
    this._carLodNextAt = now + CAR_LOD_SPEC.cadenceMs;
    this._carLodUpdates++;
    const cp = camera.position;
    for (const e of this.entries) {
      const dx = e.mesh.position.x - cp.x;
      const dy = e.mesh.position.y - cp.y;
      const dz = e.mesh.position.z - cp.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this._setEntryCarLod(e,
        resolveCarLod(e.lodLevel, distance, e.isPlayer, this._carLodMode));
    }
    return true;
  }

  setCarLodMode(mode) {
    this._carLodMode = mode === 'forced-full' || mode === 'full'
      ? 'forced-full' : 'automatic';
    this._carLodNextAt = -Infinity;
    if (this._carLodMode === 'forced-full') {
      for (const e of this.entries) this._setEntryCarLod(e, 'full');
    }
    return this.carLodTelemetry;
  }

  get carLodTelemetry() {
    let full = 0, far = 0;
    for (const e of this.entries) e.lodLevel === 'far' ? far++ : full++;
    return {
      mode: this._carLodMode,
      initialized: this._carLodInitialized,
      cadenceHz: CAR_LOD_SPEC.cadenceHz,
      enterFarM: CAR_LOD_SPEC.enterFarM,
      returnFullM: CAR_LOD_SPEC.returnFullM,
      hysteresis: CAR_LOD_SPEC.hysteresis,
      updates: this._carLodUpdates,
      switches: this._carLodSwitches,
      full,
      far,
      playerPinnedFull: !this.player || this.player.lodLevel === 'full',
    };
  }

  // Compatibility for tools/direct callers that still request an immediate
  // authoritative mesh sync. Internal fixed ticks use snapshot capture instead.
  _syncMesh(e, dt = 0) {
    if (this._renderDisposed || !e) return;
    this._ensureRenderState(e);
    this._advanceWheelSpin(e, dt);
    this._captureRenderState(e, e.renderCurr);
    copyRenderSnapshot(e.renderCurr, e.renderPrev);
    copyRenderSnapshot(e.renderCurr, e.renderPose);
    this._applyRenderPose(e, e.renderPose);
  }

  _msgOnce(key, text, color) {
    this._onceKeys = this._onceKeys || {};
    const now = performance.now();
    if (!this._onceKeys[key] || now - this._onceKeys[key] > 5000) {
      this._onceKeys[key] = now;
      this.onMessage(text, color);
    }
  }

  setNametags(v) {
    this._tagsWanted = v;
    // hide instantly on toggle-off; toggle-on lets the per-frame screen-space
    // pass (updateNametags) reveal at most TAG_MAX_VISIBLE next frame
    if (!v) for (const e of this.entries) if (e.tag) e.tag.visible = false;
  }

  /**
   * Screen-space nametag pass: distance cull (TAG_RANGE), nearest-first cap
   * (TAG_MAX_VISIBLE), viewport clamp, overlap cull and car-occlusion guard —
   * see js/nametags.js. Runs once per rendered frame from main.js, after the
   * camera settles. Tags stay hidden before lights-out (grid/lights phases)
   * and in headless tools, which never call this.
   */
  updateNametags(camera, vw, vh) {
    const phaseOk = this.phase === 'racing' || this.phase === 'finished';
    const on = this._tagsWanted && phaseOk && !!this.player;
    const pp = on ? (this.player.renderPose || this.player.phys.pos) : null;
    const cands = [];
    for (const e of this.entries) {
      if (!e.tag) continue;
      if (!on || e.isPlayer) { e.tag.visible = false; continue; }
      const pose = e.renderPose || e.phys.pos;
      const dx = pose.x - pp.x, dz = pose.z - pp.z;
      cands.push({ tag: e.tag, x: pose.x, y: e.renderY || 0, z: pose.z, d2: dx * dx + dz * dz });
    }
    if (cands.length) layoutNametags(cands, camera, vw, vh);
  }

  dispose() {
    if (this._renderDisposed) return;
    this._renderDisposed = true;
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    for (const e of this.entries) {
      CAR.releaseCarMesh?.(e.carHandle);
      this.scene.remove(e.mesh);
      e.mesh.traverse(o => {
        // sprites share a module-level geometry inside three — never dispose it
        if (o.isSprite) {
          if (o.material && !o.material.userData.shared) {
            materials.add(o.material);
            if (o.material.map && !o.material.map.userData.shared) textures.add(o.material.map);
          }
          return;
        }
        // resources marked shared are reused across cars/sessions — keep them
        if (o.geometry && !o.geometry.userData.shared) geometries.add(o.geometry);
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.userData.shared) return;
          materials.add(m);
          if (m.map && !m.map.userData.shared) textures.add(m.map);
        });
      });
      e.renderPrev = null;
      e.renderCurr = null;
      e.renderPose = null;
    }
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
  }
}

const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, boost: false };

function defaultNext(cur, conditions = {}) {
  const weatherChoice = chooseWeatherTyre(conditions, cur);
  if (compoundFamily(weatherChoice) === 'wet' || compoundFamily(cur) === 'wet') return weatherChoice;
  return cur === 'S' ? 'M' : cur === 'M' ? 'H' : 'M';
}

function physicalCompound(key) { return COMPOUNDS[key] ? key : 'M'; }

function partLabel(value) {
  return String(value || 'mechanical')
    .replace(/-failure$/, '')
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function pitLaneLoss(circuit) {
  // Legacy helper for the force-completion branch only. Driven stops measure
  // real lane + service time instead of this estimate.
  return 8 + Math.min(6, circuit.length / 900);
}
