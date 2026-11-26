// Shared display formatting kept independent from the race simulation so the
// menu and HUD do not pull the full gameplay graph into the initial boot.
export function fmtTime(t, hours = false) {
  if (!t && t !== 0) return '—';
  if (t >= 9000) return 'NO TIME';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (hours && m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  }
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export const PIT_BOX_STOP_WINDOW_M = 1.6;

export function pitBoxDistanceText(pitState) {
  if (pitState?.reposition) return 'REPOSITION';
  if (pitState?.phase === 'stopped') {
    const remaining = Number.isFinite(pitState.phaseT) ? Math.max(0, pitState.phaseT) : 0;
    return `SERVICE ${remaining.toFixed(1)} S`;
  }
  const distance = pitState?.distanceToBox;
  if (!Number.isFinite(distance)) return null;
  if (distance >= 0) return `BOX ${distance.toFixed(1)} M`;
  if (distance >= -PIT_BOX_STOP_WINDOW_M) return 'IN BOX — STOP';
  return 'BOX PASSED';
}
