// session.js — lobby and in-race coordination for a private multiplayer race.
//
// Topology is a star with the host at the centre: guests only ever talk to the
// host, and the host relays. That keeps the handshake to one invite per guest
// and makes exactly one machine responsible for the things a race cannot
// disagree about.
//
// Authority split:
//   host   — roster, grid order, race phase, AI cars, official classification.
//   both   — its own car, simulated locally with full physics so the player
//            who is steering never waits for the network.
//
// Every other car is a network-driven pose (see interpolation.js). This module
// owns no rendering and no clock: `tick(now)` supplies time, so the whole
// state machine replays deterministically in the Node probe.

import { RemoteCarSet } from './interpolation.js';
import {
  MAX_PLAYERS,
  MSG,
  PHASE_HZ,
  PROTOCOL_VERSION,
  REJECT_REASON,
  STATE_HZ,
  decodePeerInfo,
  decodePhaseMessage,
  decodeRaceConfig,
  decodeResultRows,
  decodeStateMessage,
  encodePeerInfo,
  encodePhaseMessage,
  encodeRaceConfig,
  encodeResultRows,
  encodeStateMessage,
  sanitizeId,
  sanitizeText,
} from './protocol.js';

/** Lifecycle of a private race, from both sides. */
export const NET_STATE = Object.freeze({
  LOBBY: 'lobby',
  STARTING: 'starting',
  RACING: 'racing',
  FINISHED: 'finished',
  CLOSED: 'closed',
});

export const NET_EVENT = Object.freeze({
  ROSTER: 'roster',
  JOINED: 'joined',
  LEFT: 'left',
  START: 'start',
  PHASE: 'phase',
  RESULT: 'result',
  ERROR: 'error',
  CLOSED: 'closed',
});

const STATE_INTERVAL = 1 / STATE_HZ;
const PHASE_INTERVAL = 1 / PHASE_HZ;

/**
 * One private race, seen from this machine.
 *
 * opts:
 *   role            'host' | 'guest'
 *   localName       display name for the lobby
 *   driverId        the car this machine drives
 *   driverPool      every selectable driver id (host uses it to resolve clashes)
 *   raceConfig      { trackId, laps, difficulty, seed, gridOrder, aiOpponents }
 *   onEvent(type, payload)
 */
export class MultiplayerSession {
  constructor(opts = {}) {
    this.role = opts.role === 'host' ? 'host' : 'guest';
    this.isHost = this.role === 'host';
    this.localName = sanitizeText(opts.localName || (this.isHost ? 'HOST' : 'GUEST'));
    this.localDriverId = sanitizeId(opts.driverId);
    this.localPeerId = this.isHost ? 'h0' : '';
    this.driverPool = Array.isArray(opts.driverPool) ? opts.driverPool.map(id => sanitizeId(id)).filter(Boolean) : [];
    this.raceConfig = opts.raceConfig ? { ...opts.raceConfig } : null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.maxPlayers = Math.max(2, Math.min(MAX_PLAYERS, opts.maxPlayers || MAX_PLAYERS));

    this.state = NET_STATE.LOBBY;
    this.localReady = this.isHost;
    this.remote = new RemoteCarSet({ delay: opts.interpolationDelay });

    /** Host: one entry per connected guest. Guest: at most the host link. */
    this.peers = new Map();
    this.links = new Set();
    this._nextPeerId = 1;
    this._now = 0;
    this._lastStateAt = -Infinity;
    this._lastPhaseAt = -Infinity;
    this._lastPhase = null;
    this._results = null;
    this._detachers = new Map();
  }

  // -------------------------------------------------------------------------
  // roster
  // -------------------------------------------------------------------------

  /** Everyone in the race, this machine included, in join order. */
  roster() {
    const rows = [{
      id: this.localPeerId || 'me',
      driverId: this.localDriverId,
      name: this.localName,
      ready: this.localReady,
      host: this.isHost,
      local: true,
      connected: true,
    }];
    for (const peer of this.peers.values()) {
      rows.push({
        id: peer.id,
        driverId: peer.driverId,
        name: peer.name,
        ready: peer.ready,
        host: peer.host,
        local: false,
        connected: peer.connected !== false,
      });
    }
    return rows;
  }

  /** Driver ids controlled by a human other than this machine. */
  remoteDriverIds() {
    const ids = [];
    for (const peer of this.peers.values()) if (peer.driverId) ids.push(peer.driverId);
    return ids;
  }

  /** Every human driver id in the race, this machine first. */
  humanDriverIds() {
    return [this.localDriverId, ...this.remoteDriverIds()].filter(Boolean);
  }

  get playerCount() { return 1 + this.peers.size; }

  get everyoneReady() {
    if (!this.localReady) return false;
    for (const peer of this.peers.values()) if (!peer.ready) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // links
  // -------------------------------------------------------------------------

  /**
   * Adopt an open transport.
   *
   * Host: one call per guest that completes the handshake.
   * Guest: one call, for the link to the host. The guest introduces itself
   * immediately; the host answers with WELCOME or REJECT.
   */
  attach(transport) {
    if (!transport || this.state === NET_STATE.CLOSED) return false;
    this.links.add(transport);
    const detach = [
      transport.onMessage((msg) => this._onMessage(transport, msg)),
      transport.onClose((reason) => this._onLinkClosed(transport, reason)),
    ];
    if (!this.isHost) {
      // The guest introduces itself the moment the link is usable. On a real
      // WebRTC transport that is after the host pastes the reply code, so the
      // greeting has to wait for `open` rather than fire into a dead channel.
      const hello = () => transport.send({
        k: MSG.HELLO,
        v: PROTOCOL_VERSION,
        d: this.localDriverId,
        n: this.localName,
      });
      if (transport.open) hello();
      else detach.push(transport.onOpen(hello));
    }
    this._detachers.set(transport, detach);
    return true;
  }

  _onLinkClosed(transport, reason) {
    const detach = this._detachers.get(transport);
    if (detach) { for (const off of detach) off(); this._detachers.delete(transport); }
    this.links.delete(transport);
    if (this.isHost) {
      for (const [id, peer] of this.peers) {
        if (peer.transport !== transport) continue;
        this.peers.delete(id);
        this.remote.forget(peer.driverId);
        this.onEvent(NET_EVENT.LEFT, { peer, reason });
        this._broadcastRoster();
        this.onEvent(NET_EVENT.ROSTER, { roster: this.roster() });
      }
      return;
    }
    // A guest with no host has no race.
    this.state = NET_STATE.CLOSED;
    this.onEvent(NET_EVENT.CLOSED, { reason: reason || 'host-disconnected' });
  }

  // -------------------------------------------------------------------------
  // message routing
  // -------------------------------------------------------------------------

  _onMessage(transport, msg) {
    switch (msg.k) {
      case MSG.HELLO: return this._onHello(transport, msg);
      case MSG.WELCOME: return this._onWelcome(msg);
      case MSG.REJECT: return this._onReject(msg);
      case MSG.ROSTER: return this._onRoster(msg);
      case MSG.READY: return this._onReady(transport, msg);
      case MSG.START: return this._onStart(msg);
      case MSG.STATE: return this._onState(transport, msg);
      case MSG.PHASE: return this._onPhase(msg);
      case MSG.RESULT: return this._onResult(msg);
      case MSG.BYE: return this._onBye(transport, msg);
      case MSG.PING: return void transport.send({ k: MSG.PONG, t: msg.t });
      default: return undefined;
    }
  }

  // ---- host handlers ----

  _onHello(transport, msg) {
    if (!this.isHost) return;
    if (msg.v !== PROTOCOL_VERSION) {
      transport.send({ k: MSG.REJECT, why: REJECT_REASON.VERSION, v: PROTOCOL_VERSION });
      return;
    }
    if (this.state !== NET_STATE.LOBBY) {
      transport.send({ k: MSG.REJECT, why: REJECT_REASON.CLOSED });
      return;
    }
    if (this.playerCount >= this.maxPlayers) {
      transport.send({ k: MSG.REJECT, why: REJECT_REASON.FULL });
      return;
    }
    // An existing peer re-announcing itself must not become a second entry.
    for (const peer of this.peers.values()) {
      if (peer.transport === transport) { this.peers.delete(peer.id); break; }
    }
    const id = `p${this._nextPeerId++}`;
    const driverId = this._assignDriver(sanitizeId(msg.d));
    const peer = {
      id,
      transport,
      driverId,
      name: sanitizeText(msg.n) || `PLAYER ${this.playerCount + 1}`,
      ready: false,
      host: false,
      connected: true,
    };
    this.peers.set(id, peer);
    transport.send({
      k: MSG.WELCOME,
      v: PROTOCOL_VERSION,
      you: encodePeerInfo(peer),
      cfg: this.raceConfig ? encodeRaceConfig(this.raceConfig) : null,
      ros: this.roster().map(encodePeerInfo),
    });
    this._broadcastRoster();
    this.onEvent(NET_EVENT.JOINED, { peer });
    this.onEvent(NET_EVENT.ROSTER, { roster: this.roster() });
  }

  /**
   * Give a joining player the car they asked for when it is free, and the next
   * free one otherwise. Two people cannot share a car: the whole race indexes
   * cars by driver id.
   */
  _assignDriver(requested) {
    const taken = new Set(this.humanDriverIds());
    if (requested && !taken.has(requested)) return requested;
    for (const id of this.driverPool) if (!taken.has(id)) return id;
    return requested || '';
  }

  _onReady(transport, msg) {
    if (!this.isHost) return;
    for (const peer of this.peers.values()) {
      if (peer.transport !== transport) continue;
      peer.ready = msg.r === 1;
      this._broadcastRoster();
      this.onEvent(NET_EVENT.ROSTER, { roster: this.roster() });
      return;
    }
  }

  // ---- guest handlers ----

  _onWelcome(msg) {
    if (this.isHost) return;
    const you = decodePeerInfo(msg.you);
    if (you) {
      this.localPeerId = you.id;
      if (you.driverId && you.driverId !== this.localDriverId) this.localDriverId = you.driverId;
    }
    const config = decodeRaceConfig(msg.cfg);
    if (config) this.raceConfig = config;
    this._applyRoster(msg.ros);
    this.onEvent(NET_EVENT.ROSTER, { roster: this.roster(), welcomed: true });
  }

  _onReject(msg) {
    const why = sanitizeId(msg.why, 16);
    const message = why === REJECT_REASON.VERSION
      ? 'That invite was made with a different version of the game. Both players need the same build.'
      : why === REJECT_REASON.FULL
        ? 'That race is full.'
        : 'That race is no longer accepting players.';
    this.state = NET_STATE.CLOSED;
    this.onEvent(NET_EVENT.ERROR, { reason: why, message });
    this.onEvent(NET_EVENT.CLOSED, { reason: why });
  }

  _onRoster(msg) {
    if (this.isHost) return;
    this._applyRoster(msg.ros);
    this.onEvent(NET_EVENT.ROSTER, { roster: this.roster() });
  }

  _applyRoster(rows) {
    if (!Array.isArray(rows)) return;
    const link = this.links.values().next().value || null;
    const next = new Map();
    for (const raw of rows) {
      const info = decodePeerInfo(raw);
      if (!info || info.id === this.localPeerId) continue;
      next.set(info.id, {
        id: info.id,
        transport: link,
        driverId: info.driverId,
        name: info.name,
        ready: info.ready,
        host: info.host,
        connected: true,
      });
    }
    for (const id of this.peers.keys()) if (!next.has(id)) {
      const gone = this.peers.get(id);
      if (gone?.driverId) this.remote.forget(gone.driverId);
    }
    this.peers = next;
  }

  _onStart(msg) {
    if (this.isHost) return;
    const config = decodeRaceConfig(msg.cfg);
    if (!config || !config.gridOrder.length) {
      this.onEvent(NET_EVENT.ERROR, { message: 'The host sent a race setup this build cannot read.' });
      return;
    }
    this.raceConfig = config;
    this.state = NET_STATE.RACING;
    this.remote.clear();
    this.onEvent(NET_EVENT.START, { config, roster: this.roster() });
  }

  _onPhase(msg) {
    if (this.isHost) return;
    const phase = decodePhaseMessage(msg);
    if (!phase) return;
    this._lastPhase = phase;
    this.onEvent(NET_EVENT.PHASE, phase);
  }

  _onResult(msg) {
    if (this.isHost) return;
    const rows = decodeResultRows(msg.rows);
    if (!rows.length) return;
    this._results = rows;
    this.state = NET_STATE.FINISHED;
    this.onEvent(NET_EVENT.RESULT, { rows, fastestLap: sanitizeId(msg.fl) || null });
  }

  // ---- both ----

  _onState(transport, msg) {
    const batch = decodeStateMessage(msg);
    if (!batch) return;
    const now = this._now;
    if (this.isHost) {
      // A guest may only move its own car. Accepting anything else would let one
      // player drag every other car around the circuit.
      const owner = this._peerFor(transport);
      if (!owner) return;
      const mine = batch.cars.filter(car => car.id === owner.driverId);
      this.remote.ingest(now, mine);
      return;
    }
    // From the host, everything except this machine's own car is authoritative.
    this.remote.ingest(now, batch.cars.filter(car => car.id !== this.localDriverId));
  }

  _onBye(transport) {
    if (this.isHost) { this._onLinkClosed(transport, 'peer-left'); return; }
    this.state = NET_STATE.CLOSED;
    this.onEvent(NET_EVENT.CLOSED, { reason: 'host-left' });
  }

  _peerFor(transport) {
    for (const peer of this.peers.values()) if (peer.transport === transport) return peer;
    return null;
  }

  // -------------------------------------------------------------------------
  // outbound
  // -------------------------------------------------------------------------

  _broadcastRoster() {
    if (!this.isHost) return;
    const rows = this.roster().map(encodePeerInfo);
    for (const peer of this.peers.values()) peer.transport?.send({ k: MSG.ROSTER, ros: rows });
  }

  /** Guest: announce readiness. Host: readiness is implicit. */
  setReady(ready) {
    this.localReady = !!ready;
    if (this.isHost) { this.onEvent(NET_EVENT.ROSTER, { roster: this.roster() }); return; }
    for (const link of this.links) link.send({ k: MSG.READY, r: this.localReady ? 1 : 0 });
  }

  /** Host: replace the agreed race settings and tell everyone. */
  configureRace(config) {
    this.raceConfig = config ? { ...config } : null;
    if (!this.isHost || !this.raceConfig) return;
    const rows = this.roster().map(encodePeerInfo);
    const cfg = encodeRaceConfig(this.raceConfig);
    for (const peer of this.peers.values()) peer.transport?.send({ k: MSG.WELCOME, v: PROTOCOL_VERSION, you: encodePeerInfo(peer), cfg, ros: rows });
  }

  /** Host: lock the lobby and send everyone to the grid. */
  startRace(config = this.raceConfig) {
    if (!this.isHost) return null;
    if (!config) return null;
    this.raceConfig = { ...config };
    this.state = NET_STATE.RACING;
    this.remote.clear();
    const payload = { k: MSG.START, cfg: encodeRaceConfig(this.raceConfig) };
    for (const peer of this.peers.values()) peer.transport?.send(payload);
    this.onEvent(NET_EVENT.START, { config: this.raceConfig, roster: this.roster() });
    return this.raceConfig;
  }

  /**
   * Push this machine's car transforms. The host sends every car it owns
   * (its own plus the AI plus the poses it relays for other guests); a guest
   * sends only the car it is driving.
   *
   * Rate-limited to STATE_HZ; call it every frame.
   */
  publishState(now, cars) {
    this._now = now;
    if (this.state !== NET_STATE.RACING || !cars || !cars.length) return false;
    if (now - this._lastStateAt < STATE_INTERVAL) return false;
    this._lastStateAt = now;
    const msg = encodeStateMessage(now, cars);
    let sent = false;
    for (const link of this.links) sent = link.sendState(msg) || sent;
    return sent;
  }

  /** Host: broadcast the authoritative phase, on change and at PHASE_HZ. */
  publishPhase(now, phase) {
    this._now = now;
    if (!this.isHost || this.state !== NET_STATE.RACING || !phase) return false;
    const changed = !this._lastPhase ||
      this._lastPhase.phase !== phase.phase ||
      this._lastPhase.lightsOn !== phase.lightsOn;
    if (!changed && now - this._lastPhaseAt < PHASE_INTERVAL) return false;
    this._lastPhaseAt = now;
    this._lastPhase = { ...phase };
    const msg = encodePhaseMessage(phase);
    for (const peer of this.peers.values()) peer.transport?.send(msg);
    return true;
  }

  /** Host: the classification is final; everyone shows the same sheet. */
  publishResults(rows, fastestLapDriverId = null) {
    if (!this.isHost) return false;
    const encoded = encodeResultRows(rows);
    if (!encoded.length) return false;
    this._results = decodeResultRows(encoded);
    this.state = NET_STATE.FINISHED;
    const msg = { k: MSG.RESULT, rows: encoded, fl: sanitizeId(fastestLapDriverId || '') };
    for (const peer of this.peers.values()) peer.transport?.send(msg);
    return true;
  }

  /** Latest official classification, or null while the race is running. */
  get results() { return this._results; }

  /** Interpolated pose for a networked car at local time `now`. */
  pose(driverId, now) {
    this._now = now;
    return this.remote.sample(driverId, now);
  }

  /** Advance internal timing. Safe to call every frame. */
  tick(now) {
    this._now = now;
    return this;
  }

  /** Leave cleanly so the other side sees a disconnect rather than a timeout. */
  close(reason = 'left') {
    if (this.state === NET_STATE.CLOSED) return;
    for (const link of this.links) {
      try { link.send({ k: MSG.BYE }); } catch { /* link already gone */ }
    }
    const links = [...this.links];
    this.state = NET_STATE.CLOSED;
    for (const link of links) {
      const detach = this._detachers.get(link);
      if (detach) { for (const off of detach) off(); this._detachers.delete(link); }
      try { link.close(reason); } catch { /* link already gone */ }
    }
    this.links.clear();
    this.peers.clear();
    this.remote.clear();
    this.onEvent(NET_EVENT.CLOSED, { reason });
  }
}
