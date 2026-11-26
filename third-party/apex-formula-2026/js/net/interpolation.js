// interpolation.js — turn a jittery stream of remote car transforms into a
// smooth pose for every rendered frame.
//
// The two browsers never share a clock, so nothing here reads the sender's
// timestamps for timing. Each sample is stamped with the *local* time it
// arrived and replayed on a fixed delay behind local time. That is the classic
// entity-interpolation trade: one buffer-length of latency in exchange for
// motion that never stutters and never needs clock synchronisation.
//
// Pure module: local time is always passed in, never read from a clock.

import { CAR_FLAG, clampFinite, finiteOr } from './protocol.js';

/** Replay delay, seconds. One and a half 20 Hz packets absorbs normal jitter. */
export const DEFAULT_INTERP_DELAY = 0.075;

/** Never dead-reckon further than this past the newest sample. */
export const MAX_EXTRAPOLATION = 0.25;

/** Drop a peer's car after this long with no packet at all. */
export const STALE_AFTER = 3.0;

/** Shortest signed angular distance from `from` to `to`, in radians. */
export function shortestAngle(from, to) {
  let delta = (finiteOr(to, 0) - finiteOr(from, 0)) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Angle-aware linear blend. */
export function lerpAngle(from, to, alpha) {
  return finiteOr(from, 0) + shortestAngle(from, to) * clampFinite(alpha, 0, 1, 0);
}

function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

/**
 * A ring of recent transforms for one remote car.
 *
 * Usage per frame:
 *   track.push(localTimeSeconds, decodedCarState)   // on every packet
 *   const pose = track.sample(localTimeSeconds)     // once per rendered frame
 */
export class RemoteCarTrack {
  constructor({ delay = DEFAULT_INTERP_DELAY, capacity = 24 } = {}) {
    this.delay = clampFinite(delay, 0, 1, DEFAULT_INTERP_DELAY);
    this.capacity = Math.max(4, Math.round(capacity));
    this.samples = [];
    this.lastArrival = -Infinity;
    // One stable pose object per car: sampled every frame, never reallocated.
    // The named booleans are decoded here so the race session can consume a
    // pose without knowing anything about the wire format.
    this.out = {
      x: 0, y: 0, z: 0, heading: 0, v: 0, gear: 1, rpmFrac: 0.2, throttle: 0,
      lap: -1, sampleIdx: 0, flags: 0, wear: 0,
      finished: false, dnf: false, pit: false, offTrack: false, boost: false, braking: false,
      extrapolated: false, valid: false,
    };
  }

  /** Newest transform accepted, or null before the first packet. */
  get latest() {
    return this.samples.length ? this.samples[this.samples.length - 1].car : null;
  }

  get hasData() { return this.samples.length > 0; }

  /**
   * Record a decoded car state that arrived at local time `at`.
   * Out-of-order arrivals are dropped: a stale packet must never rewind a car.
   */
  push(at, car) {
    if (!car) return false;
    const arrival = finiteOr(at, 0);
    if (this.samples.length && arrival < this.samples[this.samples.length - 1].at) return false;
    this.samples.push({ at: arrival, car });
    this.lastArrival = arrival;
    while (this.samples.length > this.capacity) this.samples.shift();
    return true;
  }

  /** True when no packet has arrived recently enough to trust. */
  isStale(now, after = STALE_AFTER) {
    if (!this.samples.length) return true;
    return finiteOr(now, 0) - this.lastArrival > after;
  }

  /**
   * Pose for the given local time. Returns a stable object owned by this track
   * (never allocated per frame) with `valid:false` before the first packet.
   */
  sample(now) {
    const out = this.out;
    if (!this.samples.length) { out.valid = false; return out; }
    const target = finiteOr(now, 0) - this.delay;

    // Retire samples older than the one immediately before `target`, keeping at
    // least two so a paused sender still renders its last known pose.
    while (this.samples.length > 2 && this.samples[1].at <= target) this.samples.shift();

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];

    if (target <= first.at) {
      this._copy(first.car, 0, first.car, out);
      out.extrapolated = false;
      out.valid = true;
      return out;
    }

    // Find the bracketing pair.
    let a = first;
    let b = last;
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].at >= target) { a = this.samples[i - 1]; b = this.samples[i]; break; }
      a = this.samples[i];
      b = this.samples[i];
    }

    if (a === b || b.at <= a.at) {
      // Ahead of the newest sample: dead-reckon along the car's own heading for
      // a bounded window, then hold. A held pose reads as a brief stutter; an
      // unbounded one sends the car through the scenery.
      const ahead = clampFinite(target - last.at, 0, MAX_EXTRAPOLATION, 0);
      const car = last.car;
      this._copy(car, 0, car, out);
      out.x = car.x + Math.sin(car.heading) * car.v * ahead;
      out.z = car.z + Math.cos(car.heading) * car.v * ahead;
      out.extrapolated = ahead > 0;
      out.valid = true;
      return out;
    }

    const alpha = clampFinite((target - a.at) / (b.at - a.at), 0, 1, 0);
    this._copy(a.car, alpha, b.car, out);
    out.extrapolated = false;
    out.valid = true;
    return out;
  }

  _copy(a, alpha, b, out) {
    out.x = lerp(a.x, b.x, alpha);
    out.y = lerp(a.y, b.y, alpha);
    out.z = lerp(a.z, b.z, alpha);
    out.heading = lerpAngle(a.heading, b.heading, alpha);
    out.v = lerp(a.v, b.v, alpha);
    out.rpmFrac = lerp(a.rpmFrac, b.rpmFrac, alpha);
    out.throttle = lerp(a.throttle, b.throttle, alpha);
    out.wear = lerp(a.wear, b.wear, alpha);
    // Discrete fields snap to the newer sample: a half-interpolated gear or lap
    // number is meaningless and would flicker the HUD.
    const target = alpha >= 0.5 ? b : a;
    out.gear = target.gear;
    out.lap = target.lap;
    out.sampleIdx = target.sampleIdx;
    const bits = target.flags;
    out.flags = bits;
    out.finished = (bits & CAR_FLAG.FINISHED) !== 0;
    out.dnf = (bits & CAR_FLAG.DNF) !== 0;
    out.pit = (bits & CAR_FLAG.PIT) !== 0;
    out.offTrack = (bits & CAR_FLAG.OFF_TRACK) !== 0;
    out.boost = (bits & CAR_FLAG.BOOST) !== 0;
    out.braking = (bits & CAR_FLAG.BRAKING) !== 0;
    return out;
  }
}

/**
 * All remote cars in one race, keyed by driver id.
 *
 * The host feeds this with AI + other humans; a guest feeds it with everything
 * that is not its own car.
 */
export class RemoteCarSet {
  constructor({ delay = DEFAULT_INTERP_DELAY } = {}) {
    this.delay = delay;
    this.tracks = new Map();
  }

  track(driverId) {
    let track = this.tracks.get(driverId);
    if (!track) {
      track = new RemoteCarTrack({ delay: this.delay });
      this.tracks.set(driverId, track);
    }
    return track;
  }

  /** Ingest a decoded STATE batch that arrived at local time `at`. */
  ingest(at, cars) {
    if (!Array.isArray(cars)) return 0;
    let accepted = 0;
    for (const car of cars) {
      if (!car || !car.id) continue;
      if (this.track(car.id).push(at, car)) accepted++;
    }
    return accepted;
  }

  /** Pose for one car, or null when that car has never reported. */
  sample(driverId, now) {
    const track = this.tracks.get(driverId);
    if (!track || !track.hasData) return null;
    return track.sample(now);
  }

  forget(driverId) { this.tracks.delete(driverId); }

  clear() { this.tracks.clear(); }
}
