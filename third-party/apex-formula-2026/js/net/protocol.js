// protocol.js — wire format for private multiplayer races.
//
// Everything here is pure: no DOM, no timers, no transport. The module is
// imported unchanged by the browser runtime and by the deterministic Node
// probe in tools/validate-multiplayer.mjs.
//
// Peer messages arrive from another person's browser, so every decoder in this
// file treats its input as hostile. A malformed or malicious payload must
// produce `null` or a clamped finite value — never a NaN that would poison the
// physics state of the car it is applied to.

export const PROTOCOL_VERSION = 3;

/** Wire message kinds. Short strings: these ride in every packet. */
export const MSG = Object.freeze({
  HELLO: 'hi',       // guest -> host, first message on an open channel
  WELCOME: 'wel',    // host -> guest, accepted; carries the race configuration
  REJECT: 'rej',     // host -> guest, refused (version / full / duplicate)
  ROSTER: 'ros',     // host -> guest, lobby membership changed
  READY: 'rdy',      // guest -> host, ready flag toggled
  START: 'go',       // host -> guest, build the session and start
  STATE: 'st',       // both ways, car transforms
  PHASE: 'ph',       // host -> guest, authoritative race phase
  RESULT: 'res',     // host -> guest, official classification
  BYE: 'bye',        // either way, clean disconnect
  PING: 'p',
  PONG: 'q',
});

/** Reasons a host can refuse a joiner. */
export const REJECT_REASON = Object.freeze({
  VERSION: 'version',
  FULL: 'full',
  CLOSED: 'closed',
});

/** Maximum humans in one private race, host included. */
export const MAX_PLAYERS = 8;

/** Car transforms per second. 20 Hz + interpolation is smooth at racing speeds. */
export const STATE_HZ = 20;

/** Authoritative phase/roster resend rate, so a dropped packet self-heals. */
export const PHASE_HZ = 4;

// ---------------------------------------------------------------------------
// sanitisation
// ---------------------------------------------------------------------------

/** Finite number or the fallback. Rejects NaN, Infinity, strings and objects. */
export function finiteOr(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Finite number clamped into [lo, hi]; anything else becomes the fallback. */
export function clampFinite(value, lo, hi, fallback = lo) {
  const n = finiteOr(value, fallback);
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round to `places` decimals. Keeps packets small and diffs readable. */
export function quantize(value, places) {
  const scale = QUANT_SCALE[places] || 1;
  return Math.round(finiteOr(value, 0) * scale) / scale;
}

const QUANT_SCALE = [1, 10, 100, 1000, 10000];

/**
 * Trim untrusted text to a safe, printable, length-limited string. Peer names
 * are rendered into the lobby, so they never carry markup or control codes.
 */
export function sanitizeText(value, maxLength = 24) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'") continue;
    out += ch;
    if (out.length >= maxLength) break;
  }
  return out.trim();
}

/** Identifiers move between peers as map keys; keep them to a known alphabet. */
export function sanitizeId(value, maxLength = 32) {
  if (typeof value !== 'string') return '';
  const match = value.match(/[A-Za-z0-9_-]+/g);
  if (!match) return '';
  return match.join('').slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// car state
// ---------------------------------------------------------------------------

/**
 * Boolean car conditions travel as one integer instead of six JSON keys.
 * Twenty-two cars at 20 Hz makes every saved byte worth having.
 */
export const CAR_FLAG = Object.freeze({
  FINISHED: 1 << 0,
  DNF: 1 << 1,
  PIT: 1 << 2,
  OFF_TRACK: 1 << 3,
  BOOST: 1 << 4,
  BRAKING: 1 << 5,
});

// Field order for the packed array form. Changing this is a protocol break, so
// PROTOCOL_VERSION must move with it.
const CAR_FIELDS = [
  ['id', null],
  ['x', 3], ['y', 3], ['z', 3],
  ['heading', 4],
  ['v', 2],
  ['gear', 0],
  ['rpmFrac', 3],
  ['throttle', 2],
  ['lap', 0],
  ['sampleIdx', 0],
  ['flags', 0],
  ['wear', 3],
];

/**
 * Pack one car into a compact array. `id` stays a string (the driver id) so a
 * roster change can never silently re-point a transform at the wrong car.
 */
export function encodeCarState(car) {
  const out = new Array(CAR_FIELDS.length);
  for (let i = 0; i < CAR_FIELDS.length; i++) {
    const [key, places] = CAR_FIELDS[i];
    if (places === null) { out[i] = sanitizeId(car[key]); continue; }
    out[i] = places === 0 ? Math.round(finiteOr(car[key], 0)) : quantize(car[key], places);
  }
  return out;
}

/** Inverse of encodeCarState. Returns null when the payload is unusable. */
export function decodeCarState(packed) {
  if (!Array.isArray(packed) || packed.length < CAR_FIELDS.length) return null;
  const id = sanitizeId(packed[0]);
  if (!id) return null;
  const car = { id };
  for (let i = 1; i < CAR_FIELDS.length; i++) {
    const [key] = CAR_FIELDS[i];
    car[key] = finiteOr(packed[i], 0);
  }
  // A peer cannot teleport a car outside the plausible world box or spin its
  // wheels at an impossible rate: those values feed audio, LOD and physics.
  car.x = clampFinite(car.x, -20000, 20000, 0);
  car.y = clampFinite(car.y, -1000, 1000, 0);
  car.z = clampFinite(car.z, -20000, 20000, 0);
  car.heading = clampFinite(car.heading, -100, 100, 0);
  car.v = clampFinite(car.v, -200, 200, 0);
  car.gear = Math.round(clampFinite(car.gear, 0, 8, 1));
  car.rpmFrac = clampFinite(car.rpmFrac, 0, 1.2, 0.2);
  car.throttle = clampFinite(car.throttle, 0, 1, 0);
  car.lap = Math.round(clampFinite(car.lap, -1, 999, -1));
  car.sampleIdx = Math.round(clampFinite(car.sampleIdx, 0, 1e7, 0));
  car.flags = Math.round(clampFinite(car.flags, 0, 0xffff, 0));
  car.wear = clampFinite(car.wear, 0, 1, 0);
  return car;
}

/** Build the flags integer from a live race entry's booleans. */
export function packCarFlags({ finished, dnf, pit, offTrack, boost, braking } = {}) {
  let flags = 0;
  if (finished) flags |= CAR_FLAG.FINISHED;
  if (dnf) flags |= CAR_FLAG.DNF;
  if (pit) flags |= CAR_FLAG.PIT;
  if (offTrack) flags |= CAR_FLAG.OFF_TRACK;
  if (boost) flags |= CAR_FLAG.BOOST;
  if (braking) flags |= CAR_FLAG.BRAKING;
  return flags;
}

/** Read a flags integer back into named booleans. */
export function unpackCarFlags(flags) {
  const bits = Math.round(clampFinite(flags, 0, 0xffff, 0));
  return {
    finished: (bits & CAR_FLAG.FINISHED) !== 0,
    dnf: (bits & CAR_FLAG.DNF) !== 0,
    pit: (bits & CAR_FLAG.PIT) !== 0,
    offTrack: (bits & CAR_FLAG.OFF_TRACK) !== 0,
    boost: (bits & CAR_FLAG.BOOST) !== 0,
    braking: (bits & CAR_FLAG.BRAKING) !== 0,
  };
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** A transform batch. `t` is the sender's own simulation clock, in seconds. */
export function encodeStateMessage(t, cars) {
  return { k: MSG.STATE, t: quantize(t, 3), c: cars.map(encodeCarState) };
}

export function decodeStateMessage(msg) {
  if (!msg || msg.k !== MSG.STATE || !Array.isArray(msg.c)) return null;
  const cars = [];
  for (const packed of msg.c) {
    const car = decodeCarState(packed);
    if (car) cars.push(car);
  }
  return { t: clampFinite(msg.t, 0, 1e7, 0), cars };
}

/** Authoritative race phase, resent at PHASE_HZ so packet loss self-heals. */
export function encodePhaseMessage({ phase, lightsOn, raceTime, laps }) {
  return {
    k: MSG.PHASE,
    p: sanitizeId(phase, 12),
    l: Math.round(clampFinite(lightsOn, 0, 6, 0)),
    t: quantize(raceTime, 2),
    n: Math.round(clampFinite(laps, 1, 200, 1)),
  };
}

const PHASES = new Set(['formation', 'grid', 'lights', 'racing', 'finished']);

export function decodePhaseMessage(msg) {
  if (!msg || msg.k !== MSG.PHASE) return null;
  const phase = sanitizeId(msg.p, 12);
  if (!PHASES.has(phase)) return null;
  return {
    phase,
    lightsOn: Math.round(clampFinite(msg.l, 0, 6, 0)),
    raceTime: clampFinite(msg.t, 0, 1e7, 0),
    laps: Math.round(clampFinite(msg.n, 1, 200, 1)),
  };
}

/**
 * The race configuration every peer must agree on exactly. Both sides build
 * their RaceSession from this object, so a mismatch here is a desync.
 */
export function encodeRaceConfig(config = {}) {
  return {
    track: sanitizeId(config.trackId, 24),
    laps: Math.round(clampFinite(config.laps, 1, 200, 5)),
    diff: Math.round(clampFinite(config.difficulty, 0, 2, 1)),
    seed: Math.round(clampFinite(config.seed, 0, 0xffffffff, 0)),
    grid: Array.isArray(config.gridOrder)
      ? config.gridOrder.map(id => sanitizeId(id)).filter(Boolean)
      : [],
    ai: config.aiOpponents === false ? 0 : 1,
  };
}

export function decodeRaceConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const trackId = sanitizeId(raw.track, 24);
  const gridOrder = Array.isArray(raw.grid)
    ? raw.grid.map(id => sanitizeId(id)).filter(Boolean)
    : [];
  // The grid is empty while the lobby is still filling; it is only mandatory
  // once the host actually sends everyone to the start.
  if (!trackId) return null;
  return {
    trackId,
    laps: Math.round(clampFinite(raw.laps, 1, 200, 5)),
    difficulty: Math.round(clampFinite(raw.diff, 0, 2, 1)),
    seed: Math.round(clampFinite(raw.seed, 0, 0xffffffff, 0)),
    gridOrder,
    aiOpponents: raw.ai !== 0,
  };
}

/** One lobby member as it appears in a roster broadcast. */
export function encodePeerInfo(peer = {}) {
  return {
    id: sanitizeId(peer.id),
    d: sanitizeId(peer.driverId),
    n: sanitizeText(peer.name),
    r: peer.ready ? 1 : 0,
    h: peer.host ? 1 : 0,
  };
}

export function decodePeerInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeId(raw.id);
  const driverId = sanitizeId(raw.d);
  if (!id || !driverId) return null;
  return { id, driverId, name: sanitizeText(raw.n), ready: raw.r === 1, host: raw.h === 1 };
}

/**
 * Official classification rows. Only the host ever produces these, and it
 * carries enough detail that a guest renders exactly the same results sheet
 * rather than a locally re-derived approximation of it.
 */
export function encodeResultRows(rows = []) {
  return rows.slice(0, 64).map(row => ({
    d: sanitizeId(row.driverId ?? row.driver?.id),
    p: Math.round(clampFinite(row.pos ?? row.position, 1, 99, 1)),
    gp: Math.round(clampFinite(row.gridPos, 1, 99, 1)),
    dnf: row.dnf ? 1 : 0,
    lap: Math.round(clampFinite(row.laps, 0, 999, 0)),
    pit: Math.round(clampFinite(row.pits, 0, 99, 0)),
    b: quantize(row.bestLap, 3),
    g: sanitizeText(row.gapText, 16),
    pen: quantize(row.penaltySeconds, 2),
    pts: Math.round(clampFinite(row.points, 0, 99, 0)),
    fl: row.fastestLap ? 1 : 0,
    st: sanitizeText(row.status, 16),
    fc: sanitizeText(row.failureCause, 24),
  }));
}

export function decodeResultRows(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const item of raw.slice(0, 64)) {
    const driverId = sanitizeId(item?.d);
    if (!driverId) continue;
    rows.push({
      driverId,
      pos: Math.round(clampFinite(item.p, 1, 99, 1)),
      gridPos: Math.round(clampFinite(item.gp, 1, 99, 1)),
      dnf: item.dnf === 1,
      laps: Math.round(clampFinite(item.lap, 0, 999, 0)),
      pits: Math.round(clampFinite(item.pit, 0, 99, 0)),
      bestLap: clampFinite(item.b, 0, 1e6, 0),
      gapText: sanitizeText(item.g, 16),
      penaltySeconds: clampFinite(item.pen, 0, 1e4, 0),
      points: Math.round(clampFinite(item.pts, 0, 99, 0)),
      fastestLap: item.fl === 1,
      status: sanitizeText(item.st, 16) || (item.dnf === 1 ? 'DNF' : 'CLASSIFIED'),
      failureCause: sanitizeText(item.fc, 24) || null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/** Serialise a message for the wire. Returns '' when the value is not encodable. */
export function serialize(msg) {
  try {
    const text = JSON.stringify(msg);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * Parse a wire frame. Anything that is not a JSON object with a known `k`
 * becomes null, so a hostile peer cannot reach the router with junk.
 */
export function deserialize(text) {
  if (typeof text !== 'string' || text.length > 262144) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.k !== 'string') return null;
  return value;
}
