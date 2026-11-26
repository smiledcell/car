// transport.js — peer-to-peer plumbing for private races.
//
// There is no game server. Two browsers connect directly over WebRTC data
// channels, and the offer/answer handshake that would normally go through a
// signalling service travels through the players instead: the host copies an
// invite link, the guest pastes a reply code back. Nothing about the game is
// hosted anywhere.
//
// Two channels, deliberately:
//   ctrl  — reliable + ordered. Lobby, race start, phase, results.
//   state — unreliable + unordered. Car transforms at 20 Hz, where a late
//           packet is worthless and head-of-line blocking is the enemy.
//
// Both are `negotiated` with fixed ids so each side creates them itself and
// neither has to wait for an `ondatachannel` round trip.

import { deserialize, serialize } from './protocol.js';

/**
 * ICE servers used to discover a peer across the public internet.
 *
 * The game itself never talks to a network: assets, physics and every menu run
 * from the local origin. A STUN server is contacted only while a player is
 * actively opening or joining a private race, and only to learn their own
 * public address. Players who race on one LAN, or who prefer to run their own
 * infrastructure, can replace this list from Settings.
 */
export const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
]);

/** Candidate gathering cutoff. Whatever has been found by then is good enough. */
export const GATHER_TIMEOUT_MS = 4000;

const CTRL_CHANNEL_ID = 0;
const STATE_CHANNEL_ID = 1;

/** True when this runtime can open a peer connection at all. */
export function peerConnectionSupported() {
  return typeof globalThis.RTCPeerConnection === 'function';
}

function parseIceServers(value) {
  if (!Array.isArray(value)) return DEFAULT_ICE_SERVERS.map(server => ({ ...server }));
  const servers = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (/^(stun|turn)s?:/i.test(entry)) servers.push({ urls: entry });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.urls === 'string') {
      const server = { urls: entry.urls };
      if (typeof entry.username === 'string') server.username = entry.username;
      if (typeof entry.credential === 'string') server.credential = entry.credential;
      servers.push(server);
    }
  }
  return servers;
}

/**
 * Turn a user-typed STUN/TURN list (one entry per line) into an iceServers
 * array. An empty string means "LAN only" and yields no servers at all.
 */
export function parseIceServerText(text) {
  if (typeof text !== 'string') return DEFAULT_ICE_SERVERS.map(server => ({ ...server }));
  const trimmed = text.trim();
  if (!trimmed) return [];
  return parseIceServers(trimmed.split(/[\n,]+/).map(line => line.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// transport surface
// ---------------------------------------------------------------------------

/**
 * Common listener bookkeeping. A transport delivers already-parsed messages;
 * callers never see the wire format.
 */
class BaseTransport {
  constructor() {
    this._message = new Set();
    this._open = new Set();
    this._close = new Set();
    this.closed = false;
    this._announcedOpen = false;
    this.stats = { sent: 0, received: 0, dropped: 0 };
  }

  onMessage(fn) { this._message.add(fn); return () => this._message.delete(fn); }
  onOpen(fn) { this._open.add(fn); return () => this._open.delete(fn); }
  onClose(fn) { this._close.add(fn); return () => this._close.delete(fn); }

  _emitMessage(msg) {
    this.stats.received++;
    for (const fn of this._message) {
      try { fn(msg); } catch (error) { reportListenerError(error); }
    }
  }

  _emitOpen() {
    // Two channels come up independently; "open" is a one-time edge.
    if (this._announcedOpen) return;
    this._announcedOpen = true;
    for (const fn of this._open) {
      try { fn(); } catch (error) { reportListenerError(error); }
    }
  }

  _emitClose(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this._close) {
      try { fn(reason); } catch (error) { reportListenerError(error); }
    }
  }
}

function reportListenerError(error) {
  if (typeof console !== 'undefined' && console.error) console.error('[multiplayer]', error);
}

/**
 * A live WebRTC link to one peer.
 *
 * `send(msg)` goes over the reliable channel; `sendState(msg)` over the
 * unreliable one, falling back to reliable while the fast channel is still
 * coming up.
 */
export class PeerTransport extends BaseTransport {
  constructor(connection, ctrl, state) {
    super();
    this.connection = connection;
    this.ctrl = ctrl;
    this.state = state;
    this._wireChannel(ctrl);
    this._wireChannel(state);
    connection.addEventListener?.('connectionstatechange', () => {
      const status = connection.connectionState;
      if (status === 'failed' || status === 'closed' || status === 'disconnected') {
        this._emitClose(status);
      }
    });
  }

  get open() { return !this.closed && this.ctrl && this.ctrl.readyState === 'open'; }

  _wireChannel(channel) {
    if (!channel) return;
    channel.addEventListener('open', () => { if (this.open) this._emitOpen(); });
    channel.addEventListener('close', () => this._emitClose('channel-closed'));
    channel.addEventListener('message', (event) => {
      const msg = deserialize(typeof event.data === 'string' ? event.data : '');
      if (!msg) { this.stats.dropped++; return; }
      this._emitMessage(msg);
    });
  }

  send(msg) {
    if (!this.open) return false;
    const text = serialize(msg);
    if (!text) return false;
    try { this.ctrl.send(text); this.stats.sent++; return true; } catch { return false; }
  }

  sendState(msg) {
    if (this.closed) return false;
    const text = serialize(msg);
    if (!text) return false;
    const channel = this.state && this.state.readyState === 'open' ? this.state : this.ctrl;
    if (!channel || channel.readyState !== 'open') return false;
    // A backed-up channel means the link cannot keep up. Dropping the newest
    // transform is correct: interpolation covers the gap, a growing queue does
    // not, and every queued packet is stale by the time it lands.
    if (channel.bufferedAmount > 262144) { this.stats.dropped++; return false; }
    try { channel.send(text); this.stats.sent++; return true; } catch { return false; }
  }

  close(reason = 'local') {
    try { this.ctrl?.close(); } catch { /* already gone */ }
    try { this.state?.close(); } catch { /* already gone */ }
    try { this.connection?.close(); } catch { /* already gone */ }
    this._emitClose(reason);
  }
}

/**
 * An in-process transport pair. Used by the deterministic probe and by the
 * browser test harness so the whole netcode path can run without WebRTC.
 */
export class LoopbackTransport extends BaseTransport {
  constructor(name = 'loopback') {
    super();
    this.name = name;
    this.peer = null;
    this.latency = 0;
    this.queue = [];
    this.open = true;
  }

  /** Deliver messages only when `pump(now)` is called, keeping tests seeded. */
  send(msg) {
    if (this.closed || !this.peer) return false;
    const text = serialize(msg);
    if (!text) return false;
    this.stats.sent++;
    this.peer.queue.push({ at: this.latency, text });
    return true;
  }

  sendState(msg) { return this.send(msg); }

  /** Flush queued frames whose delay has elapsed. `dt` is seconds. */
  pump(dt = 0) {
    if (this.closed) return 0;
    let delivered = 0;
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) {
      item.at -= dt;
      if (item.at > 0) { this.queue.push(item); continue; }
      const msg = deserialize(item.text);
      if (!msg) { this.stats.dropped++; continue; }
      this._emitMessage(msg);
      delivered++;
    }
    return delivered;
  }

  close(reason = 'local') {
    const peer = this.peer;
    this.peer = null;
    this.open = false;
    this._emitClose(reason);
    if (peer && !peer.closed) peer.close('peer-closed');
  }
}

/** Two transports wired to each other, with an optional one-way delay. */
export function createLoopbackPair({ latency = 0 } = {}) {
  const host = new LoopbackTransport('host');
  const guest = new LoopbackTransport('guest');
  host.peer = guest;
  guest.peer = host;
  host.latency = latency;
  guest.latency = latency;
  return { host, guest };
}

// ---------------------------------------------------------------------------
// WebRTC handshake
// ---------------------------------------------------------------------------

function createChannels(connection) {
  const ctrl = connection.createDataChannel('ctrl', {
    negotiated: true, id: CTRL_CHANNEL_ID, ordered: true,
  });
  const state = connection.createDataChannel('state', {
    negotiated: true, id: STATE_CHANNEL_ID, ordered: false, maxRetransmits: 0,
  });
  return { ctrl, state };
}

/**
 * Resolve once candidate gathering finishes, or after `timeoutMs`.
 *
 * Without a signalling channel there is no trickle ICE: the local description
 * has to carry every candidate it is ever going to have. Waiting forever is
 * worse than waiting a few seconds, because one unreachable TURN server would
 * otherwise hang the invite screen.
 */
function waitForIceGathering(connection, timeoutMs) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve('complete');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.removeEventListener?.('icegatheringstatechange', onChange);
      resolve(reason);
    };
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') finish('complete');
    };
    const timer = setTimeout(() => finish('timeout'), Math.max(250, timeoutMs));
    connection.addEventListener?.('icegatheringstatechange', onChange);
  });
}

function newConnection(iceServers) {
  if (!peerConnectionSupported()) {
    throw new Error('This browser cannot open a direct connection to another player.');
  }
  return new globalThis.RTCPeerConnection({ iceServers: parseIceServers(iceServers) });
}

/**
 * Host side. Produces the SDP that goes into the invite link, then waits for
 * the guest's reply.
 *
 * Returns `{ transport, sdp, accept, close }`. `accept(answerSdp)` completes
 * the handshake; `transport.onOpen` fires when the link is live.
 */
export async function createHostConnection({ iceServers, gatherTimeoutMs = GATHER_TIMEOUT_MS } = {}) {
  const connection = newConnection(iceServers);
  const { ctrl, state } = createChannels(connection);
  const transport = new PeerTransport(connection, ctrl, state);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  const gathering = await waitForIceGathering(connection, gatherTimeoutMs);
  const sdp = connection.localDescription?.sdp || offer.sdp || '';
  let accepted = false;
  return {
    transport,
    sdp,
    gathering,
    async accept(answerSdp) {
      if (accepted) throw new Error('This invite has already been used.');
      if (typeof answerSdp !== 'string' || !answerSdp.includes('v=0')) {
        throw new Error('That reply code is not a valid connection answer.');
      }
      accepted = true;
      await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      return transport;
    },
    close(reason) { transport.close(reason); },
  };
}

/**
 * Guest side. Consumes the host's offer and produces the reply code the guest
 * sends back.
 */
export async function createGuestConnection({ offerSdp, iceServers, gatherTimeoutMs = GATHER_TIMEOUT_MS } = {}) {
  if (typeof offerSdp !== 'string' || !offerSdp.includes('v=0')) {
    throw new Error('That invite does not contain a valid connection offer.');
  }
  const connection = newConnection(iceServers);
  const { ctrl, state } = createChannels(connection);
  const transport = new PeerTransport(connection, ctrl, state);
  await connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  const gathering = await waitForIceGathering(connection, gatherTimeoutMs);
  return {
    transport,
    sdp: connection.localDescription?.sdp || answer.sdp || '',
    gathering,
    close(reason) { transport.close(reason); },
  };
}

/** Resolve when a transport reports open, or reject after `timeoutMs`. */
export function waitForOpen(transport, timeoutMs = 20000) {
  if (transport.open) return Promise.resolve(transport);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      offOpen(); offClose();
      reject(new Error('The other player did not connect in time.'));
    }, timeoutMs);
    const offOpen = transport.onOpen(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); offOpen(); offClose();
      resolve(transport);
    });
    const offClose = transport.onClose(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); offOpen(); offClose();
      reject(new Error('The connection closed before the race could start.'));
    });
  });
}
