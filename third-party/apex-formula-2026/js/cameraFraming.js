// Deterministic chase-camera composition. Keeping the photographic intent in a
// dependency-free module lets verification inspect it without booting WebGL.
export const CAMERA_FRAMING = Object.freeze({
  // The nose is foreshortened from a chase view, so its visible longitudinal
  // silhouette is shorter than the car's regulation length.
  representativeProjectedLengthM: 3.4,
  representativeCarHeightM: 0.9,
  normalSpeedSamplesMps: Object.freeze([45, 65, 85]),
  targetViewportHeight: Object.freeze([0.15, 0.20]),
  speedEffectCapMps: 90,
  boostFovDegrees: 1,
  lookHeightM: 0.75,
  // Keep the chase camera attached primarily to the car. Looking mostly down
  // the future racing line made the chassis slide sideways in frame before it
  // actually rotated, exaggerating even modest physical sideslip.
  headingAimWeight: 0.72,
  aheadAimWeight: 0.28,
});

// `pull`, `rise`, and `fovSpeed` are deliberately restrained: the car should
// remain the visual anchor as speed builds instead of shrinking into the road.
export const CAMERA_PROFILES = Object.freeze({
  tight: Object.freeze({
    back: 6.6, pull: 0.004, height: 1.65, rise: 0.0014,
    look: 8, fov: 63, fovSpeed: 0.015,
  }),
  broadcast: Object.freeze({
    back: 7.05, pull: 0.003, height: 1.82, rise: 0.0015,
    look: 9.5, fov: 64, fovSpeed: 0.014,
  }),
  cinematic: Object.freeze({
    back: 7.45, pull: 0.0025, height: 2, rise: 0.0016,
    look: 11.5, fov: 65.5, fovSpeed: 0.013,
  }),
});

export function resolveChaseCamera(profileName, speedMps, boosting = false, output = {}) {
  const profile = CAMERA_PROFILES[profileName] || CAMERA_PROFILES.broadcast;
  const finiteSpeed = Number.isFinite(speedMps) ? speedMps : 0;
  const framingSpeed = Math.min(CAMERA_FRAMING.speedEffectCapMps, Math.max(0, finiteSpeed));
  output.back = profile.back + framingSpeed * profile.pull;
  output.height = profile.height + framingSpeed * profile.rise;
  output.look = profile.look;
  output.fov = profile.fov + framingSpeed * profile.fovSpeed +
    (boosting ? CAMERA_FRAMING.boostFovDegrees : 0);
  return output;
}

// A stable composition proxy: the fraction of viewport height occupied by the
// visible car silhouette after chase-view foreshortening. It intentionally
// omits suspension animation and track pitch so regressions are deterministic.
export function estimateCarViewportHeight(profileName, speedMps) {
  const framing = resolveChaseCamera(profileName, speedMps);
  const halfVerticalFov = framing.fov * Math.PI / 360;
  const aimY = CAMERA_FRAMING.lookHeightM - framing.height;
  const aimZ = framing.look + framing.back;
  const aimLength = Math.hypot(aimY, aimZ);
  const forwardY = aimY / aimLength;
  const forwardZ = aimZ / aimLength;
  const upY = forwardZ;
  const upZ = -forwardY;
  const projectedY = [];
  const halfLength = CAMERA_FRAMING.representativeProjectedLengthM / 2;
  for (const y of [0, CAMERA_FRAMING.representativeCarHeightM]) {
    for (const z of [-halfLength, halfLength]) {
      const relativeY = y - framing.height;
      const relativeZ = z + framing.back;
      const depth = relativeY * forwardY + relativeZ * forwardZ;
      const viewY = relativeY * upY + relativeZ * upZ;
      projectedY.push((viewY / depth) / Math.tan(halfVerticalFov));
    }
  }
  return (Math.max(...projectedY) - Math.min(...projectedY)) / 2;
}

// ---- camera feel -------------------------------------------------------------
// Presentation-only maths for the live camera. It reads simulation outputs and
// returns numbers: nothing writes car state, and the "noise" is a hash of the
// camera's own clock, so no random stream is ever consumed.
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// Per-mode arrays follow the C cycle: chase, cockpit, T-cam, nose.
export const CAMERA_FEEL = Object.freeze({
  speedFovDegrees: Object.freeze([9.5, 0, 6, 6]),   // added at full speed sensation
  speedPullM: 0.7,           // chase distance added flat out
  yawRate: 6,                // 1/s: how quickly the chase rig swings behind the car
  slipFollow: 0.6,           // share of sideslip the rig aims along in a slide
  accelPullM: 0.06,          // m of chase lag per m/s^2 of acceleration
  brakePushM: 0.021,         // m of chase push-in per m/s^2 of braking
  lateralShiftM: 0.016,      // m the rig is thrown outward per m/s^2
  rollRad: 0.0018,           // chase bank into the corner per m/s^2
  maxRollRad: 0.058,         // about 3.3 degrees
  // Held look (Z / X, right stick): yaw swept per mode. Look-behind is a cut.
  lookSideRad: Object.freeze([Math.PI / 2, 1.05, 1.4, 1.4]),
});

// Rigid onboard mounts in car space: metres ahead of the car origin, height
// above the road, how far ahead the camera aims, and the aim height. The
// cockpit takes its eye height and field of view from the player's settings.
export const ONBOARD_MOUNTS = Object.freeze([
  null,
  Object.freeze({ ahead: 0.43, look: 22, lookHeight: 0.74, boostFov: 1 }),
  Object.freeze({ ahead: -0.75, height: 1.62, look: 14, lookHeight: 1.05, fov: 72, fovSpeed: 0.045, boostFov: 2 }),
  Object.freeze({ ahead: 2.3, height: 0.6, look: 18, lookHeight: 0.5, fov: 75, fovSpeed: 0.035, boostFov: 2 }),
]);

/** Frame-rate independent blend factor for an exponential approach: 1 - e^(-rate*dt). */
export function damp(rate, dt) {
  return 1 - Math.exp(-rate * Math.max(0, Number.isFinite(dt) ? dt : 0));
}

/**
 * Camera Motion setting (off / subtle / full) combined with the OS
 * reduced-motion preference. `motion` scales every dynamic offset and the
 * speed FOV; reduced motion keeps a little load feedback but no shake at all.
 */
export function resolveCameraMotion(setting, reducedMotion = false, output = {}) {
  let motion = setting === 'off' ? 0 : setting === 'subtle' ? 0.5 : 1;
  let shakeGain = motion;
  if (reducedMotion) {
    motion = Math.min(motion, 0.35);
    shakeGain = 0;
  }
  output.motion = motion;
  output.shakeGain = shakeGain;
  return output;
}

/** 0..1 sense of speed: nothing through the pit lane, saturating flat out. */
export function speedSensation(speedMps, boosting = false) {
  const speed = Math.abs(Number.isFinite(speedMps) ? speedMps : 0);
  const t = clamp((speed - 14) / 78, 0, 1);
  return Math.min(1, t * t * (3 - 2 * t) + (boosting ? 0.1 : 0));
}

function lattice(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 2147483648 - 1;
}

/** Smooth (C1) value noise in [-1, 1]. `channel` selects an independent stream. */
export function smoothNoise(t, channel = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const a = lattice(i + channel * 7919);
  const b = lattice(i + 1 + channel * 7919);
  return a + (b - a) * f * f * (3 - 2 * f);
}

/** Two octaves: a slow body sway carrying a finer road buzz. */
export function shakeNoise(t, channel = 0) {
  return (smoothNoise(t, channel) + 0.5 * smoothNoise(t * 2.17 + 31.4, channel + 3)) / 1.5;
}

/**
 * Shake amplitude in metres. Inputs are 0..1: speed sensation, kerb strike,
 * off-track running and the decaying impact envelope.
 */
export function shakeAmplitude(speedFx, kerb, offTrack, impact) {
  return speedFx * speedFx * 0.02 + kerb * 0.04 + offTrack * 0.06 + impact * 0.16;
}

export const CAMERA_FRAMING_METRICS = Object.freeze(Object.fromEntries(
  Object.keys(CAMERA_PROFILES).map((profileName) => [profileName, Object.freeze({
    projectedCarViewportHeight: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(estimateCarViewportHeight(profileName, speed).toFixed(4)))),
    distanceM: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(resolveChaseCamera(profileName, speed).back.toFixed(3)))),
    fovDegrees: Object.freeze(CAMERA_FRAMING.normalSpeedSamplesMps.map((speed) =>
      Number(resolveChaseCamera(profileName, speed).fov.toFixed(3)))),
  })]),
));
