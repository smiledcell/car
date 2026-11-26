// Pure steering shaping, wheel calibration, and Gamepad API translation.
// The maths stays browser-free so the same profiles can be replayed in tests.

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const WHEEL_CONFIG_VERSION = 2;
export const WHEEL_STORAGE_KEY = `apexf1_wheel_controls_v${WHEEL_CONFIG_VERSION}`;
export const FORMULA_CAR_LOCK_TO_LOCK_DEGREES = 360;
export const PEDAL_AXIS_TRUST_THRESHOLD = 0.12;

export const WHEEL_BUTTON_ACTIONS = Object.freeze([
  // Gas and brake as BUTTONS, so the wheel can steer while fingers drive.
  // Bound buttons act as full-on digital pedals, exactly like the arrow keys;
  // when real pedals are also present the stronger input wins, so a bound
  // button never fights a pressed pedal and either can be used mid-race.
  Object.freeze({ key: 'throttleButton', label: 'Gas (button)' }),
  Object.freeze({ key: 'brakeButton', label: 'Brake (button)' }),
  Object.freeze({ key: 'shiftUp', label: 'Shift up' }),
  Object.freeze({ key: 'shiftDown', label: 'Shift down' }),
  Object.freeze({ key: 'boost', label: 'Boost / override' }),
  Object.freeze({ key: 'ersMode', label: 'ERS mode' }),
  Object.freeze({ key: 'pitLimiter', label: 'Pit limiter' }),
  Object.freeze({ key: 'camera', label: 'Camera' }),
  Object.freeze({ key: 'pause', label: 'Pause' }),
  Object.freeze({ key: 'boxRequest', label: 'Box / pit request' }),
]);

export const H_PATTERN_ACTIONS = Object.freeze([
  Object.freeze({ key: 'gear1', label: 'Gear 1' }),
  Object.freeze({ key: 'gear2', label: 'Gear 2' }),
  Object.freeze({ key: 'gear3', label: 'Gear 3' }),
  Object.freeze({ key: 'gear4', label: 'Gear 4' }),
  Object.freeze({ key: 'gear5', label: 'Gear 5' }),
  Object.freeze({ key: 'gear6', label: 'Gear 6' }),
]);

const DEFAULT_BUTTONS = Object.freeze({
  throttleButton: null, brakeButton: null,
  shiftUp: 5, shiftDown: 4, boost: 0, ersMode: 1,
  pitLimiter: 9, camera: 2, pause: 10, boxRequest: 3,
  gear1: null, gear2: null, gear3: null, gear4: null, gear5: null, gear6: null,
});

// G29 shifter positions 12-17 are LIKELY in browser index space. The addendum
// verifies that those same indices are descriptor gaps on G923/G PRO, so only
// the G29 profile receives this user-correctable seed.
const G29_BUTTONS = Object.freeze({
  ...DEFAULT_BUTTONS,
  gear1: 12, gear2: 13, gear3: 14, gear4: 15, gear5: 16, gear6: 17,
});

const axis = (index, centre, inverted, deadzone) =>
  Object.freeze({ axis: index, min: -1, max: 1, centre, inverted, deadzone });

const calibrationOnlyAxes = Object.freeze({
  steering: axis(null, 0, true, 0.02),
  throttle: axis(null, 1, true, 0.04),
  brake: axis(null, 1, true, 0.04),
  clutch: axis(null, 1, true, 0.04),
});

const xinputStandardAxes = Object.freeze({
  ...calibrationOnlyAxes,
  steering: axis(0, 0, true, 0.02),
});

// Logitech's HID pedals are released at +1 and fully applied at -1. Positive
// simulation steer means left (matching the keyboard), so steering is inverted
// from the W3C sign convention deliberately.
const logitechAxes = (clutch, throttle, brake) => Object.freeze({
  steering: axis(0, 0, true, 0.02),
  throttle: axis(throttle, 1, true, 0.04),
  brake: axis(brake, 1, true, 0.04),
  clutch: axis(clutch, 1, true, 0.04),
});

const layout = (key, axes, axesLength, hatAxes, confidence) => Object.freeze({
  key, axes, axesLength, hatAxes: Object.freeze(hatAxes), confidence,
});

// Each row is a browser/OS mapping row from RESEARCH-ADDENDUM.md section 2.1.
// Calibration remains authoritative; LIKELY seeds are visibly labelled in the
// controls UI, and UNVERIFIED environments leave pedals unassigned.
export const LOGITECH_G29_G923_PS_LAYOUTS = Object.freeze({
  chromiumWindows: layout('chromium-windows', logitechAxes(1, 2, 5), 10, [9], 'VERIFIED'),
  chromiumMacos: layout('chromium-macos', logitechAxes(1, 2, 5), 10, [9], 'VERIFIED'),
  firefoxWindows: layout('firefox-windows', logitechAxes(1, 2, 5), 10, [9], 'VERIFIED'),
  linux: layout('linux-compacted', logitechAxes(1, 2, 3), 6, [4, 5], 'VERIFIED'),
  firefoxMacos: layout('firefox-macos-discovery-order', calibrationOnlyAxes, null, [], 'VERIFIED (mechanism; indices require calibration)'),
  safariMacos: layout('safari-macos', logitechAxes(3, 1, 2), 4, [], 'LIKELY'),
  unknown: layout('unknown-calibration-required', calibrationOnlyAxes, null, [], 'UNVERIFIED'),
});

export const LOGITECH_G923_XBOX_LAYOUTS = Object.freeze({
  windowsMacos: layout('windows-macos-native', logitechAxes(5, 1, 2), null, [], 'LIKELY'),
  unknown: layout('unknown-calibration-required', calibrationOnlyAxes, null, [], 'UNVERIFIED'),
});

// The G920 (046d:c262) is NOT the G29: it is the Xbox-mode wheel and orders its
// pedals Y=throttle, Z=brake, Rz=clutch — the hid-logitech-hidpp order, not
// lg4ff's Y=clutch/Z=throttle/Rz=brake. Verified on the owner's wheel
// (Chromium/macOS): the accelerator swept axis 1 full-travel, the stiff brake
// moved axis 2, and axis 5 never moved. Seeding it with the G29 layout put the
// gas pedal on the clutch, which is why the first seed felt dead.
export const LOGITECH_G920_LAYOUTS = Object.freeze({
  chromiumWindows: layout('g920-chromium-windows', logitechAxes(5, 1, 2), 10, [9], 'LIKELY'),
  chromiumMacos: layout('g920-chromium-macos', logitechAxes(5, 1, 2), 10, [9], 'VERIFIED (owner hardware)'),
  firefoxWindows: layout('g920-firefox-windows', logitechAxes(5, 1, 2), 10, [9], 'LIKELY'),
  unknown: layout('unknown-calibration-required', calibrationOnlyAxes, null, [], 'UNVERIFIED'),
});

function g920Layout(environment) {
  return LOGITECH_G920_LAYOUTS[environmentLayoutKey(environment)]
    || LOGITECH_G920_LAYOUTS.unknown;
}

function environmentLayoutKey(environment = {}) {
  const platform = environment.platform;
  const engine = environment.engine;
  if (platform === 'linux') return 'linux';
  if (platform === 'windows' && engine === 'firefox') return 'firefoxWindows';
  if (platform === 'windows' && engine === 'chromium') return 'chromiumWindows';
  if (platform === 'macos' && engine === 'firefox') return 'firefoxMacos';
  if (platform === 'macos' && engine === 'safari') return 'safariMacos';
  if (platform === 'macos' && engine === 'chromium') return 'chromiumMacos';
  return 'unknown';
}

export function detectWheelEnvironment(navigatorLike = globalThis.navigator) {
  const platformText = String(navigatorLike?.userAgentData?.platform || navigatorLike?.platform || navigatorLike?.userAgent || '');
  const userAgent = String(navigatorLike?.userAgent || '');
  const platform = /linux/i.test(platformText) ? 'linux'
    : /win/i.test(platformText) ? 'windows'
      : /mac|iphone|ipad/i.test(platformText) ? 'macos' : 'unknown';
  const engine = /firefox/i.test(userAgent) ? 'firefox'
    : /(?:chrome|chromium|crios|edg)/i.test(userAgent) ? 'chromium'
      : /safari/i.test(userAgent) ? 'safari' : 'unknown';
  return Object.freeze({ platform, engine });
}

function g29Layout(environment) {
  return LOGITECH_G29_G923_PS_LAYOUTS[environmentLayoutKey(environment)]
    || LOGITECH_G29_G923_PS_LAYOUTS.unknown;
}

function g923XboxLayout(environment) {
  return environment?.platform === 'windows' || environment?.platform === 'macos'
    ? LOGITECH_G923_XBOX_LAYOUTS.windowsMacos
    : LOGITECH_G923_XBOX_LAYOUTS.unknown;
}

const calibrationOnlyLayout = layout(
  'calibration-required', calibrationOnlyAxes, null, [], 'UNVERIFIED',
);

// USB product ids are included because Chromium may expose only VID/PID. A
// profile selects a browser/OS layout seed; the saved calibration owns the
// final indices. c266 (PlayStation) and c26e (Xbox/PC) intentionally differ.
export const WHEEL_DEVICE_MAPPINGS = Object.freeze({
  g29: Object.freeze({
    key: 'g29', label: 'Logitech G29', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/\bg29\b/i, /046d[-_: ]?c24f/i]), resolveLayout: g29Layout,
    buttons: G29_BUTTONS, buttonConfidence: 'LIKELY',
  }),
  g920: Object.freeze({
    key: 'g920', label: 'Logitech G920', defaultRotation: 900, pedalLayout: 'separate',
    // The rest signature (10 axes, pedals +1 on 1/2/5) matches the G29, but the
    // pedal ORDER does not — see LOGITECH_G920_LAYOUTS. Calibration overrides.
    patterns: Object.freeze([/\bg920\b/i, /046d[-_: ]?c262/i]), resolveLayout: g920Layout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'UNVERIFIED',
  }),
  g923Ps: Object.freeze({
    key: 'g923-ps', label: 'Logitech G923 (PlayStation)', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/046d[-_: ]?c266/i, /\bg923\b.{0,40}(?:playstation|ps[345])/i]), resolveLayout: g29Layout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'VERIFIED gaps; controls require binding',
  }),
  g923Xbox: Object.freeze({
    key: 'g923-xbox', label: 'Logitech G923 (Xbox/PC)', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/046d[-_: ]?c26e/i, /\bg923\b.{0,40}(?:xbox|pc edition)/i]), resolveLayout: g923XboxLayout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'VERIFIED gaps; controls require binding',
  }),
  g923Unknown: Object.freeze({
    key: 'g923-unknown', label: 'Logitech G923 (edition unknown)', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/\bg923\b/i]), resolveLayout: () => calibrationOnlyLayout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'UNVERIFIED',
  }),
  gpro: Object.freeze({
    key: 'gpro', label: 'Logitech G PRO Racing Wheel', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/\b(?:g\s*)?pro\s+racing\s+wheel\b/i, /046d[-_: ]?c2(?:72|68)/i]), resolveLayout: () => calibrationOnlyLayout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'VERIFIED gaps; controls require binding',
  }),
  dfgt: Object.freeze({
    key: 'dfgt', label: 'Logitech Driving Force GT', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([/driving\s+force\s+gt/i, /\bdfgt\b/i, /046d[-_: ]?c29a/i]),
    resolveLayout: () => calibrationOnlyLayout, buttons: DEFAULT_BUTTONS, buttonConfidence: 'UNVERIFIED',
  }),
  xinputWheel: Object.freeze({
    key: 'xinput-wheel', label: 'XInput standard wheel', defaultRotation: 900, pedalLayout: 'triggers',
    patterns: Object.freeze([/XInput STANDARD WHEEL/i]),
    resolveLayout: () => layout('xinput-standard', xinputStandardAxes, 4, [], 'VERIFIED (mechanism)'),
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'VERIFIED standard mapping', xinputStandard: true,
  }),
  generic: Object.freeze({
    key: 'generic', label: 'Generic racing wheel', defaultRotation: 900, pedalLayout: 'separate',
    patterns: Object.freeze([]), resolveLayout: () => calibrationOnlyLayout,
    buttons: DEFAULT_BUTTONS, buttonConfidence: 'UNVERIFIED',
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function profileKey(device) {
  if (device.key !== 'generic') return device.key;
  const suffix = String(device.id || 'wheel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return `generic:${suffix || 'wheel'}`;
}

export function detectWheelDevice(id = '', environment = detectWheelEnvironment()) {
  const text = String(id);
  for (const key of ['xinputWheel', 'g29', 'g920', 'g923Ps', 'g923Xbox', 'g923Unknown', 'gpro', 'dfgt']) {
    const mapping = WHEEL_DEVICE_MAPPINGS[key];
    if (mapping.patterns.some(pattern => pattern.test(text))) {
      const resolvedLayout = mapping.resolveLayout(environment);
      return {
        ...mapping,
        ...resolvedLayout,
        key: mapping.key,
        layoutKey: resolvedLayout.key,
        id: text,
        profileKey: `${mapping.key}:${resolvedLayout.key}`,
        isWheel: true,
      };
    }
  }
  const looksLikeWheel = /(racing|steering|driving\s+force).{0,20}wheel|wheel.{0,20}(racing|controller)|logitech.{0,30}(wheel|driving\s+force)/i.test(text);
  if (!looksLikeWheel) return null;
  const mapping = WHEEL_DEVICE_MAPPINGS.generic;
  const resolvedLayout = mapping.resolveLayout(environment);
  const device = {
    ...mapping,
    ...resolvedLayout,
    key: mapping.key,
    layoutKey: resolvedLayout.key,
    id: text,
    isWheel: true,
  };
  device.profileKey = profileKey(device);
  return device;
}

export function findWheelGamepad(gamepads = [], environment = detectWheelEnvironment()) {
  for (const gamepad of gamepads || []) {
    if (!gamepad || gamepad.connected === false) continue;
    const device = detectWheelDevice(gamepad.id, environment);
    if (device) return { gamepad, device };
  }
  return null;
}

export function createDefaultWheelConfig(device = WHEEL_DEVICE_MAPPINGS.generic) {
  const resolved = device.key ? device : WHEEL_DEVICE_MAPPINGS.generic;
  return {
    version: WHEEL_CONFIG_VERSION,
    profileKey: resolved.profileKey || profileKey(resolved),
    deviceId: resolved.id || '',
    mappingKey: resolved.key || 'generic',
    layoutKey: resolved.layoutKey || 'calibration-required',
    mappingConfidence: resolved.confidence || 'UNVERIFIED',
    pedalLayout: resolved.pedalLayout || 'separate',
    rotation: resolved.defaultRotation || 900,
    // The car's virtual lock-to-lock. 360 matches a real Formula rack; smaller
    // is a quicker rack — the honest lever for "the wheel isn't sensitive
    // enough", because rotation must stay the hardware's real range for the
    // soft-lock model to mean anything. Real cars run quicker racks at street
    // circuits for exactly this reason.
    carLock: FORMULA_CAR_LOCK_TO_LOCK_DEGREES,
    rumbleStrength: 0.65,
    axes: clone(resolved.axes || calibrationOnlyAxes),
    buttons: { ...(resolved.buttons || DEFAULT_BUTTONS) },
  };
}

function cleanAxis(input, fallback) {
  const source = input || fallback;
  const candidate = source.axis === null ? null : source.axis;
  const index = Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
  const min = finite(source.min, fallback.min);
  const max = finite(source.max, fallback.max);
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return {
    axis: index,
    min: lo,
    max: hi,
    centre: clamp(finite(source.centre, fallback.centre), lo, hi),
    inverted: source.inverted === true,
    deadzone: clamp(finite(source.deadzone, fallback.deadzone), 0, 0.25),
  };
}

export function sanitizeWheelConfig(value, device = WHEEL_DEVICE_MAPPINGS.generic) {
  const defaults = createDefaultWheelConfig(device);
  const source = value && typeof value === 'object' ? value : {};
  const axes = {};
  for (const key of ['steering', 'throttle', 'brake', 'clutch']) {
    axes[key] = cleanAxis(source.axes?.[key], defaults.axes[key]);
  }
  const buttons = { ...defaults.buttons };
  for (const action of [...WHEEL_BUTTON_ACTIONS, ...H_PATTERN_ACTIONS]) {
    const binding = source.buttons?.[action.key];
    buttons[action.key] = binding === undefined
      ? defaults.buttons[action.key]
      : Number.isInteger(binding) && binding >= 0 ? binding : null;
  }
  return {
    ...defaults,
    profileKey: defaults.profileKey,
    deviceId: String(source.deviceId || defaults.deviceId),
    layoutKey: defaults.layoutKey,
    mappingConfidence: defaults.mappingConfidence,
    pedalLayout: defaults.mappingKey === 'xinput-wheel'
      ? 'triggers'
      : axes.throttle.axis != null && axes.throttle.axis === axes.brake.axis ? 'combined' : 'separate',
    rotation: clamp(finite(source.rotation, defaults.rotation), 40, 1440),
    carLock: clamp(finite(source.carLock, defaults.carLock), 120, 720),
    rumbleStrength: clamp(finite(source.rumbleStrength, defaults.rumbleStrength), 0, 1),
    axes,
    buttons,
  };
}

function readStore(storage) {
  if (!storage || typeof storage.getItem !== 'function') return { version: WHEEL_CONFIG_VERSION, profiles: {} };
  try {
    const saved = JSON.parse(storage.getItem(WHEEL_STORAGE_KEY) || 'null');
    if (saved?.version === WHEEL_CONFIG_VERSION && saved.profiles && typeof saved.profiles === 'object') return saved;
  } catch {}
  return { version: WHEEL_CONFIG_VERSION, profiles: {} };
}

export function loadWheelConfig(storage, device) {
  const defaults = createDefaultWheelConfig(device);
  return sanitizeWheelConfig(readStore(storage).profiles[defaults.profileKey], device);
}

export function saveWheelConfig(storage, config) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    const store = readStore(storage);
    store.profiles[config.profileKey] = config;
    storage.setItem(WHEEL_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch { return false; }
}

export function resetWheelConfig(storage, device) {
  const defaults = createDefaultWheelConfig(device);
  if (storage && typeof storage.setItem === 'function') {
    try {
      const store = readStore(storage);
      delete store.profiles[defaults.profileKey];
      storage.setItem(WHEEL_STORAGE_KEY, JSON.stringify(store));
    } catch {}
  }
  return defaults;
}

export function applyAxisCurve(value, deadzone = 0, gamma = 1) {
  const signed = clamp(finite(value), -1, 1);
  const magnitude = Math.abs(signed);
  const dz = clamp(finite(deadzone), 0, 0.95);
  if (magnitude <= dz) return 0;
  const scaled = (magnitude - dz) / (1 - dz);
  return Math.sign(signed) * Math.pow(scaled, clamp(finite(gamma, 1), 0.1, 5));
}

export function normalizeCenteredAxis(raw, calibration, gamma = 1) {
  if (!calibration || calibration.axis == null) return 0;
  const value = clamp(finite(raw, calibration.centre), calibration.min, calibration.max);
  const centre = clamp(calibration.centre, calibration.min, calibration.max);
  const span = value < centre ? centre - calibration.min : calibration.max - centre;
  let normalized = span > 1e-6 ? (value - centre) / span : 0;
  if (calibration.inverted) normalized *= -1;
  return applyAxisCurve(normalized, calibration.deadzone, gamma);
}

export function normalizePedalAxis(raw, calibration, axisState = null) {
  if (!calibration || calibration.axis == null) return 0;
  const sample = finite(raw, calibration.centre);
  // Chromium reports an untouched Logitech pedal as exactly zero until that
  // axis has crossed its reset band. Zero is also a real mid-travel value, so
  // only a per-session latch can distinguish the cold-start mask safely.
  if (axisState && !axisState.trusted) {
    if (Math.abs(sample) > PEDAL_AXIS_TRUST_THRESHOLD) axisState.trusted = true;
    else return 0;
  }
  const rest = calibration.centre;
  const pressed = calibration.inverted ? calibration.min : calibration.max;
  const span = pressed - rest;
  if (Math.abs(span) < 1e-6) return 0;
  const travel = clamp((sample - rest) / span, 0, 1);
  const dz = clamp(finite(calibration.deadzone, 0.04), 0, 0.45);
  if (travel <= dz) return 0;
  if (travel >= 1 - dz) return 1;
  return (travel - dz) / (1 - dz * 2);
}

function sampleAt(values, index, fallback = 0) {
  return index == null ? fallback : finite(values?.[index], fallback);
}

function widestAxis(a, b) {
  let best = null, span = 0;
  const count = Math.max(a?.length || 0, b?.length || 0);
  for (let i = 0; i < count; i++) {
    const delta = Math.abs(sampleAt(a, i) - sampleAt(b, i));
    if (delta > span) { best = i; span = delta; }
  }
  return span >= 0.08 ? best : null;
}

export function calibrateSteeringAxis(centreValues, leftValues, rightValues, deadzone = 0.02) {
  const index = widestAxis(leftValues, rightValues);
  if (index == null) return null;
  const centre = sampleAt(centreValues, index);
  const left = sampleAt(leftValues, index), right = sampleAt(rightValues, index);
  return {
    axis: index,
    min: Math.min(left, right, centre),
    max: Math.max(left, right, centre),
    centre,
    // The simulation's positive steer direction is left, matching the keyboard.
    inverted: left < right,
    deadzone: clamp(finite(deadzone, 0.02), 0, 0.25),
  };
}

export function calibratePedalAxis(restValues, pressedValues, deadzone = 0.04) {
  const index = widestAxis(restValues, pressedValues);
  if (index == null) return null;
  const rest = sampleAt(restValues, index), pressed = sampleAt(pressedValues, index);
  return {
    axis: index,
    min: Math.min(rest, pressed),
    max: Math.max(rest, pressed),
    centre: rest,
    inverted: pressed < rest,
    deadzone: clamp(finite(deadzone, 0.04), 0, 0.25),
  };
}

function buttonHeld(gamepad, index) {
  if (index == null) return false;
  const button = gamepad?.buttons?.[index];
  return !!button && (button.pressed || button.value > 0.5);
}

function pedalStateFor(states, axisIndex) {
  if (axisIndex == null) return null;
  if (!states) return { trusted: false };
  if (!states.has(axisIndex)) states.set(axisIndex, { trusted: false });
  return states.get(axisIndex);
}

export function mapWheelSteeringToCarLock(
  steerNormalized,
  wheelLockToLock = 900,
  carLockToLock = FORMULA_CAR_LOCK_TO_LOCK_DEGREES,
) {
  const wheelRange = clamp(finite(wheelLockToLock, 900), 40, 1440);
  const carRange = clamp(finite(carLockToLock, FORMULA_CAR_LOCK_TO_LOCK_DEGREES), 40, 1440);
  return clamp(finite(steerNormalized) * (wheelRange / carRange), -1, 1);
}

export function readWheelInput(
  gamepad,
  config,
  pedalAxisStates = null,
  carLockToLock = FORMULA_CAR_LOCK_TO_LOCK_DEGREES,
) {
  if (!gamepad || !config) return null;
  const rawSteer = sampleAt(gamepad.axes, config.axes.steering.axis, config.axes.steering.centre);
  const baseSteer = normalizeCenteredAxis(rawSteer, config.axes.steering);
  const actions = {};
  for (const action of [...WHEEL_BUTTON_ACTIONS, ...H_PATTERN_ACTIONS]) {
    actions[action.key] = buttonHeld(gamepad, config.buttons[action.key]);
  }
  let gear = null;
  for (let value = 1; value <= 6; value++) {
    if (actions[`gear${value}`]) { gear = value; break; }
  }
  const xinputStandard = config.mappingKey === 'xinput-wheel';
  const throttle = xinputStandard
    ? clamp(finite(gamepad.buttons?.[7]?.value), 0, 1)
    : normalizePedalAxis(
      sampleAt(gamepad.axes, config.axes.throttle.axis, config.axes.throttle.centre),
      config.axes.throttle,
      pedalStateFor(pedalAxisStates, config.axes.throttle.axis),
    );
  const brake = xinputStandard
    ? clamp(finite(gamepad.buttons?.[6]?.value), 0, 1)
    : normalizePedalAxis(
      sampleAt(gamepad.axes, config.axes.brake.axis, config.axes.brake.centre),
      config.axes.brake,
      pedalStateFor(pedalAxisStates, config.axes.brake.axis),
    );
  return {
    steer: mapWheelSteeringToCarLock(baseSteer, config.rotation,
      finite(config.carLock, carLockToLock)),
    throttle: Math.max(throttle, actions.throttleButton ? 1 : 0),
    brake: Math.max(brake, actions.brakeButton ? 1 : 0),
    clutch: xinputStandard ? 0 : normalizePedalAxis(
      sampleAt(gamepad.axes, config.axes.clutch.axis, config.axes.clutch.centre),
      config.axes.clutch,
      pedalStateFor(pedalAxisStates, config.axes.clutch.axis),
    ),
    gear,
    actions,
    gamepad,
  };
}

export function wheelInputIsNeutral(input) {
  if (!input) return true;
  return Math.abs(input.steer) <= 0.06 && input.throttle <= 0.03 && input.brake <= 0.03 &&
    input.clutch <= 0.03 && !Object.values(input.actions).some(Boolean);
}

export function deriveRumbleEffect(telemetry = {}, strength = 0.65) {
  const gain = clamp(finite(strength, 0.65), 0, 1);
  const kerb = clamp(finite(telemetry.kerb), 0, 1);
  const lockup = clamp(finite(telemetry.lockup), 0, 1);
  const wheelspin = clamp(finite(telemetry.wheelspin), 0, 1);
  const contact = clamp(finite(telemetry.contact), 0, 1);
  return {
    strongMagnitude: clamp((contact * 0.95 + lockup * 0.48 + kerb * 0.16) * gain, 0, 1),
    weakMagnitude: clamp((contact * 0.55 + kerb * 0.72 + wheelspin * 0.62 + lockup * 0.28) * gain, 0, 1),
  };
}

export function getGamepadRumbleCapability(gamepad) {
  const actuator = gamepad?.vibrationActuator;
  const canPlayDualRumble = !!actuator && typeof actuator.playEffect === 'function'
    && (!actuator.effects || actuator.effects.includes?.('dual-rumble'));
  if (canPlayDualRumble) {
    return Object.freeze({ supported: true, api: 'dual-rumble', reason: 'Browser actuator available' });
  }
  const pulseActuator = gamepad?.hapticActuators?.[0];
  if (pulseActuator && typeof pulseActuator.pulse === 'function') {
    return Object.freeze({ supported: true, api: 'pulse', reason: 'Firefox pulse actuator available' });
  }
  return Object.freeze({
    supported: false,
    api: null,
    reason: 'This browser reports no compatible rumble actuator for this device',
  });
}

export class WheelInputManager {
  constructor(
    storage = null,
    environment = detectWheelEnvironment(),
    carLockToLock = FORMULA_CAR_LOCK_TO_LOCK_DEGREES,
  ) {
    if (storage) this.storage = storage;
    else {
      try { this.storage = globalThis.localStorage; }
      catch { this.storage = null; }
    }
    this.device = null;
    this.environment = environment;
    this.carLockToLock = carLockToLock;
    this.config = null;
    this.gamepad = null;
    this.input = null;
    this._pressed = {};
    this._lastRumbleAt = -Infinity;
    this._contact = 0;
    this._pedalAxisStates = new Map();
  }

  refresh(gamepads = globalThis.navigator?.getGamepads?.() || []) {
    const found = findWheelGamepad(gamepads, this.environment);
    const previousIndex = this.gamepad?.index;
    if (!found) {
      const disconnected = !!this.gamepad;
      this.stopRumble();
      this.gamepad = null;
      this.input = null;
      this._pressed = {};
      this._pedalAxisStates.clear();
      return { connected: false, disconnected };
    }
    const changed = !this.device || this.device.profileKey !== found.device.profileKey || previousIndex !== found.gamepad.index;
    const migrated = previousIndex != null && previousIndex !== found.gamepad.index;
    this.gamepad = found.gamepad;
    if (changed) {
      this.device = found.device;
      this.config = loadWheelConfig(this.storage, found.device);
      this._pressed = {};
      this._pedalAxisStates.clear();
    }
    return { connected: true, connectedNow: changed, migrated, device: this.device, gamepad: this.gamepad };
  }

  poll(gamepads = globalThis.navigator?.getGamepads?.() || []) {
    const status = this.refresh(gamepads);
    if (!status.connected) return { ...status, input: null, pressedActions: [] };
    this.input = readWheelInput(
      this.gamepad,
      this.config,
      this._pedalAxisStates,
      this.carLockToLock,
    );
    const pressedActions = [];
    for (const [action, held] of Object.entries(this.input.actions)) {
      if (held && !this._pressed[action] && !status.connectedNow) pressedActions.push(action);
      this._pressed[action] = held;
    }
    return { ...status, input: this.input, pressedActions };
  }

  updateConfig(change) {
    if (!this.config || !this.device) return null;
    const next = typeof change === 'function' ? change(clone(this.config)) : { ...this.config, ...change };
    this.config = sanitizeWheelConfig(next, this.device);
    this._pedalAxisStates.clear();
    saveWheelConfig(this.storage, this.config);
    return this.config;
  }

  resetConfig() {
    if (!this.device) return null;
    this.config = resetWheelConfig(this.storage, this.device);
    this._pedalAxisStates.clear();
    return this.config;
  }

  rumbleCapability() {
    return getGamepadRumbleCapability(this.gamepad);
  }

  pulseContact(severity) {
    this._contact = Math.max(this._contact, clamp(finite(severity), 0, 1));
  }

  updateRumble(telemetry = {}, now = globalThis.performance?.now?.() || 0) {
    const capability = this.rumbleCapability();
    const strength = this.config?.rumbleStrength || 0;
    if (!capability.supported || strength <= 0) {
      this._contact = 0;
      return false;
    }
    if (now - this._lastRumbleAt < 55) return false;
    const effect = deriveRumbleEffect({ ...telemetry, contact: Math.max(finite(telemetry.contact), this._contact) }, strength);
    this._contact *= 0.58;
    this._lastRumbleAt = now;
    if (effect.strongMagnitude < 0.01 && effect.weakMagnitude < 0.01) return false;
    try {
      const result = capability.api === 'dual-rumble'
        ? this.gamepad.vibrationActuator.playEffect('dual-rumble', { duration: 80, startDelay: 0, ...effect })
        : this.gamepad.hapticActuators[0].pulse(Math.max(effect.strongMagnitude, effect.weakMagnitude), 80);
      result?.catch?.(() => {});
      return true;
    } catch { return false; }
  }

  stopRumble() {
    const actuator = this.gamepad?.vibrationActuator;
    try {
      const result = actuator?.reset?.();
      result?.catch?.(() => {});
    } catch {}
    this._contact = 0;
    this._lastRumbleAt = -Infinity;
  }
}

// Which tyres are at their limit under braking or power. Slip ratio alone
// cannot say: an undriven, unbraked wheel keeps a stale value, so a wheel only
// counts while its contact patch is saturated along the car (force against the
// tyre model's own `_forceScratch.limit`; without one nothing is flagged).
// `lock` and `spin` are 0..1 for rumble: ABS or traction control holding a
// tyre at the limit is a light pulse, a locked or spinning wheel a hard one.
// `mask` flags wheels FL FR RL RR for the HUD: bits 0-3 locked, 4-7 spinning.
export function tyreLimitState(wheels, brake, throttle, out = {}) {
  let lock = 0;
  let spin = 0;
  let mask = 0;
  for (let i = 0; i < 4; i++) {
    const wheel = wheels?.[i];
    const limit = finite(wheel?._forceScratch?.limit);
    if (!(limit > 1)) continue;
    const along = finite(wheel.fx) / limit;
    if (Math.hypot(along, finite(wheel.fy) / limit) < 0.8) continue;
    const slip = finite(wheel.slipRatio);
    if (brake > 0.1 && along < -0.55 && slip < 0) {
      lock = Math.max(lock, -slip);
      if (slip < -0.3) mask |= 1 << i;
    } else if (throttle > 0.2 && along > 0.55 && slip > 0) {
      spin = Math.max(spin, slip);
      if (slip > 0.22) mask |= 16 << i;
    }
  }
  out.lock = clamp((lock - 0.02) / 0.25, 0, 1);
  out.spin = clamp((spin - 0.02) / 0.25, 0, 1);
  out.mask = mask;
  return out;
}

// Rumble for ordinary (non-wheel) gamepads. It reuses the wheel mix above, so a
// kerb, a locked brake, wheelspin and contact read the same on either device,
// and it is throttled the same way: one short effect at most every 55 ms.
export class GamepadRumble {
  constructor() {
    this._gamepad = null;
    this._lastAt = -Infinity;
    this._contact = 0;
  }

  pulseContact(severity) {
    this._contact = Math.max(this._contact, clamp(finite(severity), 0, 1));
  }

  update(gamepad, telemetry = {}, strength = 0.65, now = globalThis.performance?.now?.() || 0) {
    if (now - this._lastAt < 55) return false;
    this._lastAt = now;
    const capability = getGamepadRumbleCapability(gamepad);
    const gain = clamp(finite(strength, 0.65), 0, 1);
    if (!capability.supported || gain <= 0) {
      this._contact = 0;
      return false;
    }
    this._gamepad = gamepad;
    const effect = deriveRumbleEffect({ ...telemetry, contact: Math.max(finite(telemetry.contact), this._contact) }, gain);
    this._contact *= 0.58;
    if (effect.strongMagnitude < 0.01 && effect.weakMagnitude < 0.01) return false;
    try {
      let result;
      if (capability.api === 'dual-rumble') {
        const actuator = gamepad.vibrationActuator;
        // Impulse triggers, where the browser exposes them, carry the two
        // signals the driver modulates with those same fingers.
        const triggers = !!actuator.effects?.includes?.('trigger-rumble');
        if (triggers) {
          effect.leftTrigger = clamp(finite(telemetry.lockup), 0, 1) * gain;
          effect.rightTrigger = clamp(finite(telemetry.wheelspin), 0, 1) * gain;
        }
        result = actuator.playEffect(triggers ? 'trigger-rumble' : 'dual-rumble',
          { duration: 80, startDelay: 0, ...effect });
      } else {
        result = gamepad.hapticActuators[0].pulse(Math.max(effect.strongMagnitude, effect.weakMagnitude), 80);
      }
      result?.catch?.(() => {});
      return true;
    } catch { return false; }
  }

  stop() {
    try {
      const result = this._gamepad?.vibrationActuator?.reset?.();
      result?.catch?.(() => {});
    } catch {}
    this._contact = 0;
    this._lastAt = -Infinity;
  }
}

// Pure steering-input shaping shared by the live game and deterministic tests.

export const STEERING_PROFILES = Object.freeze({
  // Calm slows initial turn-in but recentres promptly. The old calm return was
  // slower than balanced, so a supposedly safer profile held lock after the
  // key was released and encouraged correction oscillation.
  calm: Object.freeze({ inputRate: 0.78, returnRate: 1.18, filter: 0.88 }),
  balanced: Object.freeze({ inputRate: 1, returnRate: 1, filter: 1 }),
  direct: Object.freeze({ inputRate: 1.22, returnRate: 1.18, filter: 1.14 }),
});

// Binary keys must not request a full Formula steering rack at 180-300 km/h.
// Low-speed authority is retained for hairpins and recovery, while the high-
// speed envelope maps a held arrow to a physically usable road-wheel angle.
export function digitalSteeringLimit(speed) {
  const velocity = Math.abs(Number.isFinite(speed) ? speed : 0);
  return clamp(1.15 - velocity * 0.0105, 0.42, 1);
}

export function steeringProfile(value) {
  return STEERING_PROFILES[value] || STEERING_PROFILES.balanced;
}

// A wheel already reports the driver's requested position. Filtering it with
// the keyboard ramp creates lag and makes counter-steering arrive too late.
export function analogSteeringInput(target) {
  return clamp(Number.isFinite(target) ? target : 0, -1, 1);
}

export function advanceSteeringInput(current, target, speed, dt, digital = false, profile = null) {
  const from = clamp(Number.isFinite(current) ? current : 0, -1, 1);
  const to = clamp(Number.isFinite(target) ? target : 0, -1, 1);
  // Fixed simulation ticks are normally 1/60s, but tests and recovery paths may
  // intentionally sample a full second. Preserve the established analog snap in
  // that case instead of imposing a second hidden long-frame clamp here.
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 1);
  const rawVelocity = Number.isFinite(speed) ? speed : 0;
  // Digital direction is symmetric in forward/reverse. Analog retains the
  // established signed-speed curve exactly (the playable reverse range is only
  // -4m/s, where the denominator remains safely positive).
  const velocity = digital ? Math.abs(rawVelocity) : rawVelocity;

  let rate;
  if (to !== 0) {
    rate = digital
      ? 6.8 / (1 + velocity * 0.01)
      : 3.4 / (1 + velocity * 0.02);
    // Binary keys need a decisive crossover through chicanes and corrections;
    // analog sticks retain their established response curve.
    if (digital && from * to < 0) rate *= 1.25;
  } else {
    rate = digital
      ? 9 / (1 + velocity * 0.006)
      : 6 / (1 + velocity * 0.01);
  }

  // Optional keyboard tuning is deliberately multiplicative so callers and
  // deterministic validators that omit it retain the established response.
  if (digital && profile) {
    const cfg = typeof profile === 'string' ? steeringProfile(profile) : profile;
    rate *= to !== 0 ? (cfg.inputRate || 1) : (cfg.returnRate || 1);
    // `filter` is a bounded final-stage response control: lower values smooth
    // noisy key taps, higher values make the same fixed-step curve more direct.
    rate *= clamp(Number.isFinite(cfg.filter) ? cfg.filter : 1, 0.65, 1.35);
  }

  const next = from + (to - from) * Math.min(1, rate * step);
  return Math.abs(next) < 1e-5 ? 0 : clamp(next, -1, 1);
}
