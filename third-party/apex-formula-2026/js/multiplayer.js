// multiplayer.js — the game-facing face of a private race.
//
// This is the only module the rest of the game talks to. It owns the invite
// handshake, the MultiplayerSession, and the two per-frame pumps that keep a
// RaceSession and the network in step. Everything protocol-shaped lives under
// js/net/.

import { DRIVERS } from './data.js';
import { TRACKS } from './tracks.js';
import { createRandom, deriveSeed, normalizeSeed } from './random.js';
import { MultiplayerSession, NET_EVENT, NET_STATE } from './net/session.js';
import { PROTOCOL_VERSION, packCarFlags } from './net/protocol.js';
import {
  buildAnswerPayload,
  buildInviteLink,
  buildOfferPayload,
  decodeInvite,
  encodeInvite,
  makeRoomId,
  readAnswerPayload,
  readInviteCode,
  readOfferPayload,
} from './net/invite.js';
import {
  DEFAULT_ICE_SERVERS,
  createGuestConnection,
  createHostConnection,
  parseIceServerText,
  peerConnectionSupported,
} from './net/transport.js';

export { NET_EVENT, NET_STATE, PROTOCOL_VERSION, DEFAULT_ICE_SERVERS, parseIceServerText, peerConnectionSupported, readInviteCode };

/** Humans line up at the front of the grid; AI fill in behind them. */
export function buildGridOrder({ humanDriverIds = [], aiOpponents = true, random = Math.random } = {}) {
  const humans = humanDriverIds.filter(id => DRIVERS.some(d => d.id === id));
  const seen = new Set(humans);
  const order = [...humans];
  if (!aiOpponents) return order;
  const rest = DRIVERS.filter(d => !seen.has(d.id)).map(d => ({
    id: d.id,
    // Same shaping the single-player grid uses, so the AI field behind the
    // humans still looks like a plausible qualifying result.
    score: d.pace * 0.7 + (d.racecraft ?? d.pace) * 0.3 + (random() - 0.5) * 0.05,
  }));
  rest.sort((a, b) => b.score - a.score);
  return order.concat(rest.map(item => item.id));
}

/** A track id the other side might not have; refuse rather than crash. */
export function isPlayableTrack(trackId) {
  return !!(trackId && TRACKS[trackId]);
}

function driverPool() { return DRIVERS.map(d => d.id); }

function displayNameFor(driverId, fallback) {
  const driver = DRIVERS.find(d => d.id === driverId);
  if (driver) return `${driver.firstName} ${driver.lastName}`.trim();
  return fallback || 'PLAYER';
}

/**
 * Open a private race and produce the invite a friend can open.
 *
 * The returned object holds the connection in a half-open state: the offer is
 * ready, and `accept(replyCode)` completes the handshake once the friend sends
 * their reply code back.
 */
export async function createPrivateRace({
  driverId,
  name,
  trackId,
  laps,
  difficulty = 1,
  aiOpponents = true,
  iceServers,
  seed,
  baseHref = '',
  onEvent = () => {},
} = {}) {
  if (!peerConnectionSupported()) {
    throw new Error('This browser cannot open a direct connection to another player.');
  }
  if (!isPlayableTrack(trackId)) throw new Error('Choose a circuit before opening the race.');

  const raceSeed = seed == null ? createRandom().state : normalizeSeed(seed);
  const roomRandom = createRandom(deriveSeed(raceSeed, 'room'));
  const roomId = makeRoomId(roomRandom);
  const hostName = name || displayNameFor(driverId, 'HOST');

  const session = new MultiplayerSession({
    role: 'host',
    localName: hostName,
    driverId,
    driverPool: driverPool(),
    onEvent,
    raceConfig: { trackId, laps, difficulty, seed: raceSeed, gridOrder: [], aiOpponents },
  });

  // One offer can only ever be answered once, so an invite is per-guest. The
  // host mints a fresh one after each friend connects, which is what lets a
  // private race grow past two people without any server in the middle.
  const openConnections = new Set();

  async function mintInvite() {
    const connection = await createHostConnection({ iceServers });
    openConnections.add(connection);
    const code = await encodeInvite(buildOfferPayload({
      sdp: connection.sdp,
      roomId,
      hostName,
      trackId,
      laps,
      difficulty,
      aiOpponents,
      version: PROTOCOL_VERSION,
    }));
    return {
      code,
      link: buildInviteLink(baseHref, code),
      gathering: connection.gathering,
      /** Complete the handshake with the reply code the friend pasted back. */
      async accept(replyCode) {
        const payload = await decodeInvite(replyCode);
        const answer = readAnswerPayload(payload);
        if (!answer) throw new Error('That is not a reply code from this game. Ask your friend to copy the whole code.');
        if (answer.version !== PROTOCOL_VERSION) {
          throw new Error('Your friend is running a different version of the game. Both of you need the same build.');
        }
        if (answer.roomId && answer.roomId !== roomId) {
          throw new Error('That reply code belongs to a different race.');
        }
        const transport = await connection.accept(answer.sdp);
        session.attach(transport);
        return { transport, guestName: answer.guestName, driverId: answer.driverId };
      },
    };
  }

  const invite = await mintInvite();

  return {
    role: 'host',
    session,
    roomId,
    seed: raceSeed,
    invite,
    config: { trackId, laps, difficulty, seed: raceSeed, gridOrder: [], aiOpponents },

    /** A fresh invite for the next friend. */
    newInvite: mintInvite,

    close(reason = 'closed') {
      session.close(reason);
      for (const connection of openConnections) {
        try { connection.close(reason); } catch { /* already gone */ }
      }
      openConnections.clear();
    },
  };
}

/**
 * Read an invite without connecting, so the join screen can show what the race
 * actually is before the player commits to it.
 */
export async function previewInvite(code) {
  const payload = await decodeInvite(code);
  const offer = readOfferPayload(payload);
  if (!offer) return null;
  return {
    ...offer,
    playable: isPlayableTrack(offer.trackId),
    compatible: offer.version === PROTOCOL_VERSION,
  };
}

/**
 * Accept an invite. Produces the reply code the guest sends back to the host;
 * the link goes live once the host pastes it in.
 */
export async function acceptPrivateRace({
  code,
  driverId,
  name,
  iceServers,
  onEvent = () => {},
} = {}) {
  if (!peerConnectionSupported()) {
    throw new Error('This browser cannot open a direct connection to another player.');
  }
  const payload = await decodeInvite(code);
  const offer = readOfferPayload(payload);
  if (!offer) throw new Error('That invite code could not be read. Ask your friend to send the whole link.');
  if (offer.version !== PROTOCOL_VERSION) {
    throw new Error('That invite was made with a different version of the game. Both of you need the same build.');
  }
  if (!isPlayableTrack(offer.trackId)) throw new Error('That invite is for a circuit this build does not have.');

  const guestName = name || displayNameFor(driverId, 'GUEST');
  const session = new MultiplayerSession({
    role: 'guest',
    localName: guestName,
    driverId,
    driverPool: driverPool(),
    onEvent,
    raceConfig: {
      trackId: offer.trackId,
      laps: offer.laps,
      difficulty: offer.difficulty,
      seed: 0,
      gridOrder: [],
      aiOpponents: offer.aiOpponents,
    },
  });

  const connection = await createGuestConnection({ offerSdp: offer.sdp, iceServers });
  const replyCode = await encodeInvite(buildAnswerPayload({
    sdp: connection.sdp,
    roomId: offer.roomId,
    guestName,
    driverId,
    version: PROTOCOL_VERSION,
  }));
  session.attach(connection.transport);

  return {
    role: 'guest',
    session,
    offer,
    replyCode,
    transport: connection.transport,
    gathering: connection.gathering,
    close(reason = 'closed') {
      session.close(reason);
      connection.close(reason);
    },
  };
}

// ---------------------------------------------------------------------------
// per-frame pumps
// ---------------------------------------------------------------------------

/**
 * Move every network-driven car in `raceSession` to its interpolated pose.
 *
 * Call this immediately before each fixed simulation step so the race session's
 * own previous/current render snapshots bracket the new pose and the outer
 * render interpolation stays smooth.
 */
export function applyRemotePoses(net, raceSession, now) {
  if (!net || !raceSession) return 0;
  let applied = 0;
  for (const entry of raceSession.entries) {
    if (!entry.netRemote) continue;
    const pose = net.pose(entry.driver.id, now);
    if (pose && pose.valid && raceSession.setNetworkPose(entry.driver.id, pose)) applied++;
  }
  return applied;
}

/**
 * Publish this machine's cars, and — on the host — the authoritative phase.
 * Rate limiting lives in the session, so calling this every frame is correct.
 */
export function publishRaceState(net, raceSession, now) {
  if (!net || !raceSession || net.state !== NET_STATE.RACING) return false;
  // The race session reports named conditions; turning them into wire bits is
  // this layer's job, which keeps the protocol out of the simulation.
  const cars = raceSession.networkCarStates();
  for (const car of cars) car.flags = packCarFlags(car.flags);
  const sent = net.publishState(now, cars);
  if (net.isHost) {
    net.publishPhase(now, {
      phase: raceSession.phase,
      lightsOn: raceSession.lightsOn,
      raceTime: raceSession.raceTime,
      laps: raceSession.laps,
    });
  }
  return sent;
}
