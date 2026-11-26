// backend.js — the optional public-services client.
//
// Everything this module reaches is additive. The game has never needed a
// server and still does not: with no backend configured, `available()` is false,
// no request is ever made, and the menus that depend on it simply do not appear.
// Offline play, LAN play, and a plain `git clone` of this repository behave
// exactly as they did before any of this existed.
//
// That is not a nicety — it is the contract. Every method here is written so a
// caller can treat failure as "the public features are unavailable right now"
// rather than as an error worth interrupting anyone over, because a racing game
// that cannot reach a leaderboard is still a racing game.
//
// Where the URL comes from, in order:
//   1. ?backend=<url>          per-load override, for testing a staging worker
//   2. localStorage            a URL the player set, or that a self-hoster set
//   3. <meta name="apex-backend"> whatever this deployment was built with
//
// An empty result at every level means "no backend", which is the default.

const STORAGE_KEY = 'apexf1_backend_v1';
const LEGACY_IDENTITY_KEY = 'apexf1_identity_v1';
const IDENTITY_KEY_PREFIX = 'apexf1_identity_v2:';

/** Requests give up quickly: a slow lobby must never stall the menu. */
const TIMEOUT_MS = 8000;

function readMeta() {
  if (typeof document === 'undefined') return '';
  const tag = document.querySelector('meta[name="apex-backend"]');
  return tag?.getAttribute('content')?.trim() || '';
}

function readStorage(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

/**
 * Only http(s) URLs are ever accepted.
 *
 * The value can come from a URL parameter, which means it can come from a link
 * someone was sent. Refusing anything but an absolute http(s) origin keeps a
 * crafted link from pointing the game's credentialed calls somewhere else.
 */
function sanitizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

/**
 * Values that mean "no backend, whatever this build was configured with".
 *
 * A deployment ships a lobby server in its meta tag, so without this there
 * would be no way to turn the public features back off on that build — not for
 * a player who does not want them, not for a LAN party on a deployed copy, and
 * not for the test that has to prove the game still runs with none.
 */
const DISABLED = new Set(['off', 'none', 'false', '0']);

/** The configured backend origin, or '' when there is none. */
export function backendUrl() {
  if (globalThis.APEX_LOCAL_ASSETS) return '';
  let override = '';
  try {
    override = new URLSearchParams(location.search).get('backend') || '';
  } catch { /* no location, e.g. under Node */ }
  if (DISABLED.has(override.trim().toLowerCase())) return '';

  const stored = readStorage(STORAGE_KEY);
  if (DISABLED.has(stored.trim().toLowerCase())) return '';

  return sanitizeUrl(override) || sanitizeUrl(stored) || sanitizeUrl(readMeta());
}

/** True when public rooms and the leaderboard can be offered at all. */
export function available() {
  return !!backendUrl();
}

/**
 * Point this browser at a backend.
 *
 * An empty string clears the override and falls back to whatever this build
 * shipped with; 'off' turns the public features off even on a build that ships
 * a lobby server.
 */
export function setBackendUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (DISABLED.has(value.toLowerCase())) { writeStorage(STORAGE_KEY, 'off'); return ''; }
  const url = sanitizeUrl(value);
  writeStorage(STORAGE_KEY, url);
  return url;
}

// ---------------------------------------------------------------------------
// stored identity
// ---------------------------------------------------------------------------

function identityKey(base = backendUrl()) {
  return base ? `${IDENTITY_KEY_PREFIX}${encodeURIComponent(base)}` : '';
}

function parseIdentity(raw) {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || typeof value.token !== 'string' || typeof value.handle !== 'string') return null;
    return value;
  } catch { return null; }
}

/** The handle and token this browser holds, or null. */
export function storedIdentity() {
  const base = backendUrl();
  const key = identityKey(base);
  if (!key) return null;
  const scoped = parseIdentity(readStorage(key));
  if (scoped) return scoped;

  // v1 held one global credential. Migrate it only onto the backend shipped by
  // this deployment; a query/storage override must never inherit that token.
  if (base !== sanitizeUrl(readMeta())) return null;
  const legacy = parseIdentity(readStorage(LEGACY_IDENTITY_KEY));
  if (!legacy) return null;
  if (!writeStorage(key, JSON.stringify(legacy))) return legacy;
  writeStorage(LEGACY_IDENTITY_KEY, '');
  return legacy;
}

export function storeIdentity(identity) {
  const key = identityKey();
  if (!key) return null;
  if (!identity) {
    writeStorage(key, '');
    if (backendUrl() === sanitizeUrl(readMeta())) writeStorage(LEGACY_IDENTITY_KEY, '');
    return null;
  }
  writeStorage(key, JSON.stringify(identity));
  return identity;
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/** Thrown for a request that reached the server and was refused. */
export class BackendError extends Error {
  constructor(message, { status = 0, reasons = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.reasons = reasons;
  }
}

async function request(path, {
  method = 'GET', body = null, token = null, roomLease = null, signal = null,
} = {}) {
  const base = backendUrl();
  if (!base) throw new BackendError('No lobby server is configured.', { status: 0 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (roomLease) headers['x-apex-room-lease'] = roomLease;
    const response = await fetch(`${base}${path}`, {
      method, headers, signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty or not json */ }
    if (!response.ok) {
      throw new BackendError(data?.error || `The lobby server returned ${response.status}.`, {
        status: response.status, reasons: data?.reasons || null,
      });
    }
    return data;
  } catch (error) {
    if (error instanceof BackendError) throw error;
    if (error?.name === 'AbortError') throw new BackendError('The lobby server did not respond.', { status: 0 });
    throw new BackendError('Could not reach the lobby server.', { status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

/** Is the configured backend actually there? Never throws. */
export async function health() {
  if (!available()) return null;
  try { return await request('/v1/health'); } catch { return null; }
}

/** Claim a new handle. Returns `{ handle, playerId, token, claimCode }`. */
export async function registerHandle(handle) {
  const identity = await request('/v1/identity', { method: 'POST', body: { handle } });
  storeIdentity({ handle: identity.handle, playerId: identity.playerId, token: identity.token });
  return identity;
}

/** Recover a handle on this device with the code issued at registration. */
export async function claimHandle(handle, claimCode) {
  const identity = await request('/v1/identity/claim', { method: 'POST', body: { handle, claimCode } });
  storeIdentity({ handle: identity.handle, playerId: identity.playerId, token: identity.token });
  return identity;
}

/** Open races anyone can join. Returns [] rather than throwing when offline. */
export async function listRooms(trackId = null) {
  if (!available()) return [];
  try {
    const data = await request(`/v1/rooms${trackId ? `?trackId=${encodeURIComponent(trackId)}` : ''}`);
    return Array.isArray(data?.rooms) ? data.rooms : [];
  } catch { return []; }
}

/** One room for a player who has nobody to race. Null when there is none. */
export async function quickMatch(trackId = null) {
  if (!available()) return null;
  try {
    const data = await request(`/v1/rooms/quickmatch${trackId ? `?trackId=${encodeURIComponent(trackId)}` : ''}`);
    return data?.room || null;
  } catch { return null; }
}

/** Publish or renew a room's presence. The host calls this on a timer. */
export async function publishRoom(room, hostLease = '') {
  const identity = storedIdentity();
  if (!identity) throw new BackendError('Set up a handle before opening a public race.', { status: 401 });
  return request('/v1/rooms', {
    method: 'POST', body: room, token: identity.token, roomLease: hostLease,
  });
}

/** Take a room off the public list. Best-effort: a closed tab cannot call it. */
export async function withdrawRoom(roomId, hostLease = '') {
  if (!available()) return;
  const identity = storedIdentity();
  if (!identity || !hostLease) return;
  try {
    await request(`/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE', token: identity.token, roomLease: hostLease,
    });
  }
  catch { /* the lease will expire on its own */ }
}

/**
 * Open the signalling socket for a room.
 *
 * This carries only the WebRTC introduction. Once the peer connection is up the
 * socket has no further purpose and the caller closes it — the race itself never
 * touches the server.
 */
export function openSignalling(roomId, { role, name, driverId, hostLease = '' }) {
  const base = backendUrl();
  if (!base) throw new BackendError('No lobby server is configured.');
  const url = new URL(`${base}/v1/rooms/${encodeURIComponent(roomId)}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  if (name) url.searchParams.set('name', name);
  if (driverId) url.searchParams.set('driverId', driverId);
  if (role === 'host') {
    if (!hostLease) throw new BackendError('The public race host lease is missing.', { status: 403 });
    return new WebSocket(url.toString(), ['apex-room-host', hostLease]);
  }
  return new WebSocket(url.toString());
}

/** A page of a circuit's board, plus this player's standing when they have one. */
export async function leaderboard(trackId, { limit = 100, offset = 0 } = {}) {
  if (!available()) return { entries: [], you: null, total: 0 };
  const identity = storedIdentity();
  try {
    return await request(
      `/v1/leaderboard/${encodeURIComponent(trackId)}?limit=${limit}&offset=${offset}`,
      { token: identity?.token || null },
    );
  } catch {
    return { entries: [], you: null, total: 0, unavailable: true };
  }
}

/**
 * Submit a lap.
 *
 * Throws rather than swallowing, because this one is initiated by the player and
 * a silent failure would leave them wondering where their time went. A rejected
 * lap arrives as a BackendError carrying the validator's reasons.
 */
export async function submitLap(trackId, ghost) {
  const identity = storedIdentity();
  if (!identity) throw new BackendError('Set up a handle before submitting a lap.', { status: 401 });
  return request(`/v1/leaderboard/${encodeURIComponent(trackId)}`, {
    method: 'POST', body: { ghost }, token: identity.token,
  });
}

/** A rival's ghost, so their time can be raced rather than only read. */
export async function rivalGhost(trackId, playerId) {
  if (!available()) return null;
  try {
    const data = await request(
      `/v1/leaderboard/${encodeURIComponent(trackId)}/ghost/${encodeURIComponent(playerId)}`);
    return data?.ghost || null;
  } catch { return null; }
}
