// publicRace.js — racing strangers.
//
// A private race and a public one differ in exactly one respect: who carries
// the introduction. In a private race the players carry it themselves — the
// host copies a link, the guest pastes a reply code back. That works, and it
// needs no server, but it only works when you already know who you want to
// race.
//
// A public race carries the same two codes over a WebSocket instead, so two
// people who have never met can be introduced. Everything downstream is
// identical: the same invite codec, the same handshake validation, the same
// star topology, the same host authority. The relay learns nothing except that
// two browsers would like to talk, and once they can, it is finished.
//
// That is deliberate. The netcode that races the cars is the netcode that was
// already tested against a hostile peer; this module does not get to invent a
// second one.

import { createPrivateRace, acceptPrivateRace } from '../multiplayer.js';
import {
  BackendError, openSignalling, publishRoom, withdrawRoom,
} from './backend.js';

/** How often the host renews its listing. The directory expires a lease at 60s. */
const HEARTBEAT_MS = 20_000;

/** A guest waits this long for the host to answer before giving up. */
const OFFER_TIMEOUT_MS = 25_000;

function parse(event) {
  try { return JSON.parse(typeof event.data === 'string' ? event.data : ''); }
  catch { return null; }
}

/**
 * Open a race that appears in the public list.
 *
 * Returns the same handle shape `createPrivateRace` does, plus `close()` which
 * also withdraws the listing. The caller drives the lobby exactly as it does
 * for a private race — the roster, the ready states and the start are all
 * unchanged, because they are all still the host's.
 */
export async function hostPublicRace({
  driverId, handle: playerHandle, trackId, laps, difficulty = 1,
  aiOpponents = true, iceServers, onEvent = () => {}, onStatus = () => {},
} = {}) {
  const race = await createPrivateRace({
    driverId, name: playerHandle, trackId, laps, difficulty, aiOpponents, iceServers, onEvent,
  });

  const roomListing = () => ({
    id: race.roomId,
    hostHandle: playerHandle || 'HOST',
    trackId, laps, difficulty,
    aiOpponents,
    players: race.session.playerCount,
    maxPlayers: 8,
  });

  let hostLease = '';
  try {
    const published = await publishRoom(roomListing());
    hostLease = published?.hostLease || '';
    if (!hostLease) throw new BackendError('The lobby server did not issue a host lease.');
  } catch (error) {
    race.close('publish-failed');
    throw error instanceof BackendError ? error : new BackendError('Could not list the race publicly.');
  }

  // One offer answers exactly one guest, so the host holds a spare and mints
  // the next one the moment the current one is spent. Offers already handed out
  // are kept against the guest they were handed to: two people can be part-way
  // through joining at once, and an answer has to reach the offer it belongs to
  // rather than whichever one happens to still be open.
  let pending = race.invite;
  const outstanding = new Map();
  let closed = false;
  let sealed = false;

  const socket = openSignalling(race.roomId, {
    role: 'host', name: playerHandle, driverId, hostLease,
  });

  socket.addEventListener('message', async (event) => {
    const msg = parse(event);
    if (!msg || closed) return;

    if (msg.k === 'join') {
      if (!pending) return;
      const invite = pending;
      pending = null;
      try {
        socket.send(JSON.stringify({ k: 'offer', to: msg.from, sdp: invite.code }));
        outstanding.set(msg.from, invite);
        onStatus(`${msg.name || 'A driver'} is connecting…`);
      } catch {
        pending = invite;
        return;
      }
      // The spare for whoever knocks next.
      try { pending = await race.newInvite(); } catch { pending = null; }
      return;
    }

    if (msg.k === 'answer') {
      const invite = outstanding.get(msg.from);
      if (!invite) return;
      outstanding.delete(msg.from);
      try {
        await invite.accept(msg.sdp);
        onStatus(`${msg.name || 'A driver'} joined.`);
      } catch (error) {
        onStatus(error?.message || 'A driver could not connect.');
      }
      return;
    }

    if (msg.k === 'left') {
      outstanding.delete(msg.from);
      onStatus('A driver left the lobby.');
    }
  });

  socket.addEventListener('close', () => {
    if (!closed && !sealed) onStatus('The lobby connection dropped. Players already connected are unaffected.');
  });

  // Renew the listing, and keep the advertised player count honest so a race
  // that fills up stops appearing as joinable.
  const heartbeat = setInterval(() => {
    if (closed || sealed) return;
    publishRoom(roomListing(), hostLease).catch(() => { /* the lease will lapse */ });
  }, HEARTBEAT_MS);

  return {
    ...race,
    public: true,
    roomId: race.roomId,
    close(reason = 'closed') {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      pending = null;
      outstanding.clear();
      try { socket.close(); } catch { /* already gone */ }
      if (!sealed) withdrawRoom(race.roomId, hostLease);
      race.close(reason);
    },
    /** Stop taking new players but keep racing the ones already here. */
    async seal() {
      if (closed || sealed) return;
      sealed = true;
      clearInterval(heartbeat);
      pending = null;
      outstanding.clear();
      try { socket.close(); } catch { /* already gone */ }
      await withdrawRoom(race.roomId, hostLease);
    },
  };
}

/**
 * Join a race from the public list.
 *
 * The guest never sees a code: it asks the relay to introduce it, receives the
 * host's offer, and sends its reply straight back. The codes are the same ones
 * a private race would have moved by hand.
 */
export async function joinPublicRace({
  roomId, driverId, handle: playerHandle, iceServers, onEvent = () => {}, onStatus = () => {},
} = {}) {
  const socket = openSignalling(roomId, { role: 'guest', name: playerHandle, driverId });

  const offerCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new BackendError('The host did not respond. They may have closed the race.'));
    }, OFFER_TIMEOUT_MS);

    const onMessage = (event) => {
      const msg = parse(event);
      if (!msg) return;
      if (msg.k === 'offer' && typeof msg.sdp === 'string') { cleanup(); resolve(msg.sdp); return; }
      if (msg.k === 'error') {
        cleanup();
        reject(new BackendError(msg.reason === 'host-left'
          ? 'The host left before the race could start.'
          : 'That race is no longer available.'));
      }
    };
    const onClose = () => { cleanup(); reject(new BackendError('The lobby connection closed.')); };
    const onError = () => { cleanup(); reject(new BackendError('Could not reach the lobby.')); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    }

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    onStatus('Waiting for the host…');
  }).catch((error) => {
    try { socket.close(); } catch { /* already gone */ }
    throw error;
  });

  onStatus('Connecting…');

  let joined;
  try {
    joined = await acceptPrivateRace({
      code: offerCode, driverId, name: playerHandle, iceServers, onEvent,
    });
  } catch (error) {
    try { socket.close(); } catch { /* already gone */ }
    throw error;
  }

  try {
    socket.send(JSON.stringify({ k: 'answer', sdp: joined.replyCode }));
  } catch {
    try { socket.close(); } catch { /* already gone */ }
    throw new BackendError('Could not send the reply to the host.');
  }

  // The relay has done its only job. Everything from here is peer to peer.
  setTimeout(() => { try { socket.close(); } catch { /* already gone */ } }, 2000);

  return { ...joined, public: true, roomId };
}
