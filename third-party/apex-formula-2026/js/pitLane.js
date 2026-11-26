import * as THREE from 'three';
import { DRIVERS } from './data.js';
export { PIT_BOX_STOP_WINDOW_M, pitBoxDistanceText } from './format.js';

const UP = new THREE.Vector3(0, 1, 0);

// Spec E freezes the lane geometry relative to the barrier and garage face:
// centreline at wallOff+7.5, 12 m surface, remaining apron for the stop boxes.
const LANE_HALF_WIDTH = 6;
const LANE_WALL_MARGIN = 1.5;
const LANE_CENTER_FROM_WALL = 7.5;
const HOLD_MARGIN_M = 20;
const BLEND_M = 90;
const SPEED_LIMIT = 22.22;
const RENDER_CLEARANCE_M = 0.2;
const BOX_WIDTH = 4.4;
const BOX_OUTER_INSET = 0.4;
const PIT_WALL_MAX_SWEPT_DEPTH_M = 0.44;

const clamp01 = value => Math.max(0, Math.min(1, value));
const smoothstep = value => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function wrapDelta(d, n) {
  let x = d % n;
  if (x > n / 2) x -= n;
  if (x < -n / 2) x += n;
  return x;
}

/**
 * Build an OPEN pit-lane corridor for a circuit.
 *
 * Mouths are derived from the real pit-building placement so the held offset
 * fully covers the 120 m garage span. The entry mouth starts on the track edge
 * — entering is a commitment at the painted pit-entry line, not a proximity
 * snap from the racing line.
 */
export function buildPitLane(ctx) {
  const {
    samples: trackSamples, N: trackN, ds: trackDs, halfWidth: trackHalfWidth,
    wallOff: trackWallOff, pitBuildingPlacement, pitBuilding,
    gridCount, idxAt, stepOf, heightAt: trackHeightAt,
    // Event-Notes-style house rule. The 2026 Sporting Regulations do not
    // contain the former pit-exit-line rule, so circuits may opt out explicitly.
    pitExitLineEnforced = true,
  } = ctx;
  if (!pitBuildingPlacement) throw new Error('Pit lane requires a placed pit building');

  const halfWidth = LANE_HALF_WIDTH;
  const wallOff = halfWidth + LANE_WALL_MARGIN;
  const pitSide = pitBuildingPlacement.side < 0 ? -1 : 1;
  const buildingSample = trackSamples[pitBuildingPlacement.i];
  const buildingOffset = Math.abs(
    (pitBuildingPlacement.p.x - buildingSample.p.x) * buildingSample.n.x +
    (pitBuildingPlacement.p.z - buildingSample.p.z) * buildingSample.n.z);
  const innerFaceOffset = buildingOffset - pitBuilding.depth / 2;
  // Spec E: fixed geometry in the barrier-to-building gap, not a free centre.
  const laneOffset = trackWallOff + LANE_CENTER_FROM_WALL;
  const edgeOffset = trackHalfWidth;
  // Approach window race.js enforces; owned here beside the threshold so the
  // enforced pair cannot drift from the HUD cue or from each other.
  const entryApproachM = 120;
  const entryOvershootM = 14;
  const renderHalfWidthFor = offset => Math.max(0,
    Math.min(halfWidth, Math.abs(offset) - trackHalfWidth - RENDER_CLEARANCE_M));
  const holdHalfM = pitBuilding.length / 2 + HOLD_MARGIN_M;
  const blendM = BLEND_M;
  // Entry mouth is the classic approach ~200 m before S/F (contract + painted
  // pit-entry line). Exit is derived from the building so the hold covers the
  // 120 m garage span with margin, then blends out.
  let entryTrackIdx = idxAt(-stepOf(200));
  // Forward distance from entry to the building. If the building is actually
  // upstream of the classic entry (modular wrap almost a full lap), the
  // placement is wrong — pull entry back so the hold still covers the garages
  // instead of collapsing the corridor to ~2*blend of nonsense.
  let buildingFromEntry = ((pitBuildingPlacement.i - entryTrackIdx + trackN) % trackN);
  if (buildingFromEntry > trackN / 2) {
    entryTrackIdx = idxAt(pitBuildingPlacement.i - stepOf(holdHalfM + blendM));
    buildingFromEntry = ((pitBuildingPlacement.i - entryTrackIdx + trackN) % trackN);
  }
  const needAfterEntry = buildingFromEntry + stepOf(holdHalfM + blendM);
  const minAfterEntry = stepOf(2 * blendM + 2 * holdHalfM);
  const exitTrackIdx = idxAt(entryTrackIdx + Math.max(needAfterEntry, minAfterEntry));
  // How far toward the pit-side edge a driver must be for the entry to latch.
  // Owned here so race.js (which enforces it) and hud.js (which draws the cue)
  // cannot drift apart. Two constraints: a fraction of the road so a narrow
  // street circuit is not harder than a wide one — and, measured on 10 of 24
  // circuits, the gate must clear the RACING LINE's own pit-ward excursion
  // through the window, or an armed driver latches by steering nothing
  // (monaco/miami/madrid/yasmarina exceeded the bare 45% rule at the mouth
  // itself). Capped a car's width inside the edge so it stays reachable.
  let linePitwardMax = 0;
  if (ctx.line) {
    const from = idxAt(entryTrackIdx - stepOf(entryApproachM));
    const span = stepOf(entryApproachM + entryOvershootM);
    for (let k = 0; k <= span; k++) {
      const i = idxAt(from + k);
      const s = trackSamples[i];
      const lat = pitSide * ((ctx.line[i].p.x - s.p.x) * s.n.x +
        (ctx.line[i].p.z - s.p.z) * s.n.z);
      if (lat > linePitwardMax) linePitwardMax = lat;
    }
  }
  // The threshold clears the racing line's excursion where that fits below the
  // contract's classic approach line (halfWidth - 1.5) with clearance. On the
  // few circuits where the line swings wider than the cap allows, a RESIDUAL
  // remains: an armed driver on the line can still latch there. The probe
  // records that residual per circuit so it cannot silently grow; closing it
  // fully needs hold-to-commit (latch only after N metres on the edge), which
  // destabilised AI and contract entries when rushed and is deferred.
  const entryEdgeNeed = Math.max(Math.max(1.0, edgeOffset * 0.45),
    Math.min(linePitwardMax + 0.8, edgeOffset - 2.0));
  const count = ((exitTrackIdx - entryTrackIdx + trackN) % trackN) + 1;
  const totalM = Math.max(trackDs, (count - 1) * trackDs);
  const raw = new Array(count);

  for (let k = 0; k < count; k++) {
    const trackIdx = idxAt(entryTrackIdx + k);
    const along = k * trackDs;
    // Mouth starts on the track edge and only reaches the garage lane after the
    // entry blend. Exit returns toward the track edge before the final rejoin.
    let lateralMag;
    if (along < blendM) {
      const u = smoothstep(along / blendM);
      lateralMag = edgeOffset + (laneOffset - edgeOffset) * u;
    } else if (along > totalM - blendM) {
      // u=1 at the hold side, u=0 at the exit mouth. Pure smoothstep hold->edge
      // keeps the lateral rate C1-continuous (no nested tip that creates a kick).
      const u = smoothstep((totalM - along) / blendM);
      lateralMag = edgeOffset + (laneOffset - edgeOffset) * u;
    } else {
      lateralMag = laneOffset;
    }
    const offset = pitSide * lateralMag;
    const source = trackSamples[trackIdx];
    raw[k] = {
      p: source.p.clone().addScaledVector(source.n, offset),
      t: new THREE.Vector3(),
      n: new THREE.Vector3(),
      curv: 0,
      trackIdx,
      s: 0,
      offset,
      renderHalfWidth: renderHalfWidthFor(offset),
    };
  }

  let length = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) length += raw[i].p.distanceTo(raw[i - 1].p);
    raw[i].s = length;
  }
  // An offset curve stretches the outside of a bend. Sampling it only at the
  // main road's stations leaves a wide chord on the most curved pit straight
  // (Yas Marina is the limiting layout), so resample the derived open polyline
  // at one uniform physical cadence before physics or rendering sees it.
  const source = raw.slice();
  const uniformCount = Math.max(2, Math.ceil(length / trackDs) + 1);
  const uniform = new Array(uniformCount);
  let segment = 0;
  for (let i = 0; i < uniformCount; i++) {
    const targetS = i === uniformCount - 1 ? length : i * length / (uniformCount - 1);
    while (segment < source.length - 2 && source[segment + 1].s < targetS) segment++;
    const a = source[segment], b = source[Math.min(source.length - 1, segment + 1)];
    const span = Math.max(1e-9, b.s - a.s);
    const u = clamp01((targetS - a.s) / span);
    // Keep the shadow projection on the main circuit, not on the stretched
    // offset arc — race positions read trackIdx the entire stop.
    const trackAlong = a.trackIdx + wrapDelta(b.trackIdx - a.trackIdx, trackN) * u;
    const trackIdx = idxAt(Math.round(trackAlong));
    const offset = a.offset + (b.offset - a.offset) * u;
    uniform[i] = {
      p: a.p.clone().lerp(b.p, u),
      t: new THREE.Vector3(),
      n: new THREE.Vector3(),
      curv: 0,
      trackIdx,
      s: targetS,
      offset,
      renderHalfWidth: renderHalfWidthFor(offset),
    };
  }
  raw.length = 0;
  raw.push(...uniform);
  const ds = length / Math.max(1, raw.length - 1);
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[Math.max(0, i - 1)].p;
    const next = raw[Math.min(raw.length - 1, i + 1)].p;
    raw[i].t.subVectors(next, prev).normalize();
    if (raw[i].t.lengthSq() < 1e-8) raw[i].t.copy(trackSamples[raw[i].trackIdx].t);
    raw[i].n.crossVectors(UP, raw[i].t).normalize();
  }
  for (let i = 1; i < raw.length - 1; i++) {
    const a = raw[i - 1].p, b = raw[i].p, c = raw[i + 1].p;
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (area2 < 1e-6) continue;
    const radius = (ab * bc * ca) / (2 * area2);
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    raw[i].curv = (cross > 0 ? -1 : 1) / radius;
  }
  for (const sample of raw) {
    const track = trackSamples[sample.trackIdx];
    const signedTrackLat = pitSide * ((sample.p.x - track.p.x) * track.n.x +
      (sample.p.z - track.p.z) * track.n.z);
    // Uniform resampling can chord a curved mouth a few centimetres inside the
    // source edge. Correct only the render anchor; the physics path stays put.
    const renderShift = Math.max(0, trackHalfWidth + 0.02 - signedTrackLat);
    sample.renderP = sample.p.clone().addScaledVector(track.n, pitSide * renderShift);
  }

  const globalNearest = (pos) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < raw.length; i++) {
      const dx = pos.x - raw[i].p.x, dz = pos.z - raw[i].p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  // Open path: clamp at both mouths. Never wrap sample 0 to sample N-1.
  const nearestSample = (pos, hint) => {
    if (hint == null || !Number.isFinite(hint)) return globalNearest(pos);
    const anchor = Math.max(0, Math.min(raw.length - 1, Math.round(hint)));
    let best = anchor, bestD = Infinity;
    const from = Math.max(0, anchor - 30), to = Math.min(raw.length - 1, anchor + 60);
    for (let i = from; i <= to; i++) {
      const dx = pos.x - raw[i].p.x, dz = pos.z - raw[i].p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD > 90 * 90 ? globalNearest(pos) : best;
  };
  const lateralAt = (pos, i) => {
    const sample = raw[Math.max(0, Math.min(raw.length - 1, Math.round(i) || 0))];
    return (pos.x - sample.p.x) * sample.n.x + (pos.z - sample.p.z) * sample.n.z;
  };
  const heightAt = (i) => {
    const at = Math.max(0, Math.min(raw.length - 1, Number(i) || 0));
    const i0 = Math.floor(at), i1 = Math.min(raw.length - 1, i0 + 1);
    const a = trackHeightAt(raw[i0].trackIdx), b = trackHeightAt(raw[i1].trackIdx);
    return a + (b - a) * (at - i0);
  };

  const buildingFz = pitBuildingPlacement.fz.clone().normalize();
  const buildingFx = new THREE.Vector3().crossVectors(UP, buildingFz).normalize();
  const holdStart = Math.max(0, raw.findIndex(sample => sample.s >= blendM));
  let holdEnd = raw.findIndex(sample => sample.s >= length - blendM);
  if (holdEnd < 0) holdEnd = raw.length - 1;
  const trackWallOffsets = new Float64Array(raw.length).fill(wallOff);
  const garageWallOffsets = new Float64Array(raw.length).fill(wallOff);
  const garageFace = pitBuildingPlacement.p.clone().addScaledVector(buildingFz,
    pitBuilding.depth / 2);
  for (let i = 0; i < raw.length; i++) {
    const sample = raw[i];
    if (i < holdStart || i >= holdEnd) {
      // In the blends the corridor overlaps the racing surface. Retract its
      // track-side boundary to the main circuit's far barrier; Infinity would
      // leave a corridor car unconstrained because circuit walls are inactive
      // while this open path owns physics.
      trackWallOffsets[i] = Math.max(wallOff, Math.abs(sample.offset) + trackWallOff);
    }
    const garageAlong = (sample.p.x - pitBuildingPlacement.p.x) * buildingFx.x +
      (sample.p.z - pitBuildingPlacement.p.z) * buildingFx.z;
    if (Math.abs(garageAlong) <= pitBuilding.length / 2 + 1.5) {
      const gx = garageFace.x + buildingFx.x * garageAlong;
      const gz = garageFace.z + buildingFx.z * garageAlong;
      garageWallOffsets[i] = Math.max(wallOff,
        Math.abs((gx - sample.p.x) * sample.n.x + (gz - sample.p.z) * sample.n.z));
    }
  }
  const wallOffAt = (lat, i) => {
    const idx = Math.max(0, Math.min(raw.length - 1, Math.round(i) || 0));
    if (lat * pitSide > 0) return garageWallOffsets[idx];
    if (lat * pitSide < 0) return trackWallOffsets[idx];
    return Math.min(trackWallOffsets[idx], garageWallOffsets[idx]);
  };
  // Spec E: boxes sit on the apron edge of the lane (outer edge of the 12 m
  // surface), not in the middle of the driving line.
  const boxLateral = pitSide * (halfWidth - BOX_OUTER_INSET - BOX_WIDTH / 2);
  const boxes = [];
  const pitch = pitBuilding.length / Math.max(gridCount + 2, 24);
  const targetForSlot = slot => pitBuildingPlacement.p.clone().addScaledVector(buildingFx,
    -pitSide * (slot - (gridCount - 1) / 2) * pitch);
  const nearestHoldSample = target => {
    let best = holdStart, bestD = Infinity;
    for (let i = holdStart; i <= holdEnd; i++) {
      const dx = target.x - raw[i].p.x, dz = target.z - raw[i].p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  // Quantise the pitch once, then walk the lane sample grid. Independent
  // nearest-point snaps can occasionally choose a two-sample gap on a curve,
  // overlapping adjacent 6.6 m stop boxes and narrowing the matching garages.
  const stride = Math.max(1, Math.round(pitch / ds));
  const firstSnap = nearestHoldSample(targetForSlot(0));
  const lastSnap = nearestHoldSample(targetForSlot(gridCount - 1));
  const direction = Math.sign(lastSnap - firstSnap) || 1;
  const run = (gridCount - 1) * stride;
  const firstIdx = direction > 0
    ? Math.max(holdStart, Math.min(firstSnap, holdEnd - run))
    : Math.min(holdEnd, Math.max(firstSnap, holdStart + run));
  for (let slot = 0; slot < gridCount; slot++) {
    const idx = firstIdx + direction * slot * stride;
    const driver = DRIVERS[slot];
    boxes.push({
      idx, lateral: boxLateral, slot: slot + 1,
      num: driver?.num ?? slot + 1,
      teamId: driver?.team ?? null,
    });
  }

  const entryBlendEndIdx = holdStart;
  const exitBlendStartIdx = holdEnd;
  const renderFullStartIdx = raw.findIndex(sample => sample.renderHalfWidth >= halfWidth - 1e-6);
  let renderFullEndIdx = raw.length - 1;
  while (renderFullEndIdx >= 0 && raw[renderFullEndIdx].renderHalfWidth < halfWidth - 1e-6) {
    renderFullEndIdx--;
  }
  // Render-full is a road-width concern. The wall has its own deeper swept
  // profile, so keep it out of the racing surface using a dedicated span.
  const wallClearanceOffset = trackHalfWidth + wallOff +
    PIT_WALL_MAX_SWEPT_DEPTH_M + RENDER_CLEARANCE_M;
  const wallFullStartIdx = raw.findIndex(sample => Math.abs(sample.offset) >= wallClearanceOffset);
  let wallFullEndIdx = raw.length - 1;
  while (wallFullEndIdx >= 0 && Math.abs(raw[wallFullEndIdx].offset) < wallClearanceOffset) {
    wallFullEndIdx--;
  }
  if (wallFullStartIdx < 0 || wallFullEndIdx <= wallFullStartIdx) {
    throw new Error('Pit lane cannot place a road-clear pit-wall span');
  }

  return {
    samples: raw,
    N: raw.length,
    ds,
    length,
    halfWidth,
    wallOff,
    wallOffAt,
    trackWallOffsets,
    garageWallOffsets,
    trackSideWallOff: Math.min(...trackWallOffsets),
    garageSideWallOff: Math.max(...garageWallOffsets),
    open: true,
    entryTrackIdx,
    exitTrackIdx,
    boxes,
    boxWidth: BOX_WIDTH,
    speedLimit: SPEED_LIMIT,
    exitLineEnforced: pitExitLineEnforced !== false,
    nearestSample,
    lateralAt,
    heightAt,
    pitSide,
    laneOffset,
    edgeOffset,
    entryEdgeNeed,
    entryApproachM,
    entryOvershootM,
    blendM,
    entryBlendEndIdx,
    // True where the pit wall separates lane from track and the boxes pack
    // cars side by side — the stretch where racing collisions and AI traffic
    // awareness deliberately ignore corridor cars. The entry/exit blends are
    // excluded: there the corridor overlaps the racing surface and a merging
    // car must be solid and visible.
    isProtectedIdx(idx) {
      return idx >= entryBlendEndIdx && idx < exitBlendStartIdx;
    },
    exitBlendStartIdx,
    renderFullStartIdx,
    renderFullEndIdx,
    wallFullStartIdx,
    wallFullEndIdx,
    building: {
      p: pitBuildingPlacement.p.clone(),
      fx: buildingFx,
      fz: buildingFz,
      trackIdx: pitBuildingPlacement.i,
      pitSide,
      offset: buildingOffset,
      innerFaceOffset,
      halfLength: pitBuilding.length / 2,
      halfDepth: pitBuilding.depth / 2,
    },
    trackHalfWidth,
    trackWallOff,
  };
}
