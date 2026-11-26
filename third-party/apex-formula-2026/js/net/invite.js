// invite.js — the "send this to your friend" half of a private race.
//
// APEX FORMULA has no back end and no signalling server, so the two browsers
// have to introduce themselves through the players. This module turns a WebRTC
// offer (or answer) plus the race settings into one opaque, URL-safe string,
// and turns it back again on the other side.
//
// Pure module. It touches TextEncoder/TextDecoder and, when the browser has
// them, CompressionStream/DecompressionStream — no DOM, no network.

import { sanitizeId, sanitizeText } from './protocol.js';

/** Codec markers. The first character of a code says how to read the rest. */
const CODEC_RAW = 'A';       // base64url(JSON)
const CODEC_DEFLATE = 'B';   // base64url(deflate-raw(JSON))

/** Query/hash key used for invite links. */
export const INVITE_PARAM = 'race';

/** A pasted code longer than this is a mistake, not an invite. */
export const MAX_CODE_LENGTH = 24000;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  // Accept standard base64 too, so a code that survived a helpful "+/" mangling
  // by a chat client still opens.
  table['+'.charCodeAt(0)] = 62;
  table['/'.charCodeAt(0)] = 63;
  return table;
})();

/** Bytes -> unpadded base64url. */
export function bytesToBase64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Unpadded base64url -> bytes. Throws on any character outside the alphabet. */
export function base64urlToBytes(text) {
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) continue;                       // '=' padding, harmless
    if (code === 32 || code === 10 || code === 13 || code === 9) continue;
    if (code > 127 || B64_LOOKUP[code] < 0) throw new Error('invalid character in code');
    clean += text[i];
  }
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let out = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | B64_LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, out);
}

async function runStream(stream, bytes) {
  const writer = stream.writable.getWriter();
  // A truncated code makes the inflater reject on BOTH ends of the stream.
  // These two promises are settled up front so the read error below is the one
  // that surfaces, instead of an unhandled rejection tearing down the page.
  const drained = Promise.all([
    writer.write(bytes).catch(() => {}),
    writer.close().catch(() => {}),
  ]);
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock?.();
    await drained;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function hasCompression() {
  return typeof globalThis.CompressionStream === 'function' &&
    typeof globalThis.DecompressionStream === 'function';
}

/**
 * Encode any JSON-serialisable payload as one URL-safe invite code.
 *
 * A raw WebRTC offer is 1.5-3 kB of highly repetitive text; deflate takes a
 * typical one down to roughly a quarter of that, which is the difference
 * between a code a friend can paste and one a chat client will truncate.
 */
export async function encodeInvite(payload) {
  const json = JSON.stringify(payload);
  if (typeof json !== 'string') throw new TypeError('invite payload is not serialisable');
  const bytes = new TextEncoder().encode(json);
  if (hasCompression()) {
    try {
      const packed = await runStream(new globalThis.CompressionStream('deflate-raw'), bytes);
      if (packed.length < bytes.length) return CODEC_DEFLATE + bytesToBase64url(packed);
    } catch {
      // fall through to the uncompressed form
    }
  }
  return CODEC_RAW + bytesToBase64url(bytes);
}

/**
 * Decode a code produced by encodeInvite. Returns null for anything that is not
 * a well-formed code — a truncated paste, a URL, or a sentence.
 */
export async function decodeInvite(code) {
  const trimmed = normalizeCode(code);
  if (!trimmed) return null;
  const codec = trimmed[0];
  const body = trimmed.slice(1);
  let bytes;
  try {
    bytes = base64urlToBytes(body);
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  if (codec === CODEC_DEFLATE) {
    if (!hasCompression()) return null;
    try {
      bytes = await runStream(new globalThis.DecompressionStream('deflate-raw'), bytes);
    } catch {
      return null;
    }
  } else if (codec !== CODEC_RAW) {
    return null;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Strip whatever wrapping a code picked up in transit — surrounding whitespace,
 * a full invite URL, stray line breaks from an email client.
 */
export function normalizeCode(code) {
  if (typeof code !== 'string') return '';
  let text = code.trim();
  if (!text) return '';
  if (text.length > MAX_CODE_LENGTH) return '';
  const fromUrl = readInviteCode(text);
  if (fromUrl) text = fromUrl;
  text = text.replace(/\s+/g, '');
  if (text.length < 2) return '';
  return text;
}

/**
 * Pull an invite code out of a URL (or a bare `#race=...` fragment).
 * Returns '' when the text carries no invite.
 */
export function readInviteCode(href) {
  if (typeof href !== 'string' || !href) return '';
  const key = INVITE_PARAM;
  const patterns = [
    new RegExp(`[#&?]${key}=([^&#\\s]+)`),
    new RegExp(`^${key}=([^&#\\s]+)`),
  ];
  for (const pattern of patterns) {
    const match = href.match(pattern);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { return match[1]; }
    }
  }
  return '';
}

/**
 * Build the link a host sends to a friend. The code lives in the fragment so it
 * is never sent to whatever static host is serving the game.
 */
export function buildInviteLink(baseHref, code) {
  const base = typeof baseHref === 'string' && baseHref ? baseHref : '';
  const clean = base.split('#')[0];
  return `${clean}#${INVITE_PARAM}=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------------------
// typed invite payloads
// ---------------------------------------------------------------------------

/** Payload kinds carried inside a code. */
export const INVITE_KIND = Object.freeze({ OFFER: 'offer', ANSWER: 'answer' });

/**
 * Host -> guest. Carries the connection offer plus everything the guest needs
 * to render the lobby before accepting.
 */
export function buildOfferPayload({ sdp, roomId, hostName, trackId, laps, difficulty, aiOpponents, version }) {
  return {
    k: INVITE_KIND.OFFER,
    v: version,
    r: sanitizeId(roomId, 16),
    n: sanitizeText(hostName, 24),
    t: sanitizeId(trackId, 24),
    l: laps,
    d: difficulty,
    ai: aiOpponents === false ? 0 : 1,
    s: String(sdp ?? ''),
  };
}

export function readOfferPayload(payload) {
  if (!payload || payload.k !== INVITE_KIND.OFFER) return null;
  const sdp = typeof payload.s === 'string' ? payload.s : '';
  if (!sdp.includes('v=0')) return null;
  return {
    version: Number.isFinite(payload.v) ? payload.v : 0,
    roomId: sanitizeId(payload.r, 16),
    hostName: sanitizeText(payload.n, 24),
    trackId: sanitizeId(payload.t, 24),
    laps: Number.isFinite(payload.l) ? payload.l : 5,
    difficulty: Number.isFinite(payload.d) ? payload.d : 1,
    aiOpponents: payload.ai !== 0,
    sdp,
  };
}

/** Guest -> host. The reply code pasted back into the host's lobby. */
export function buildAnswerPayload({ sdp, roomId, guestName, driverId, version }) {
  return {
    k: INVITE_KIND.ANSWER,
    v: version,
    r: sanitizeId(roomId, 16),
    n: sanitizeText(guestName, 24),
    d: sanitizeId(driverId, 32),
    s: String(sdp ?? ''),
  };
}

export function readAnswerPayload(payload) {
  if (!payload || payload.k !== INVITE_KIND.ANSWER) return null;
  const sdp = typeof payload.s === 'string' ? payload.s : '';
  if (!sdp.includes('v=0')) return null;
  return {
    version: Number.isFinite(payload.v) ? payload.v : 0,
    roomId: sanitizeId(payload.r, 16),
    guestName: sanitizeText(payload.n, 24),
    driverId: sanitizeId(payload.d, 32),
    sdp,
  };
}

/** Short, human-quotable room id derived from a seeded RNG (no Math.random). */
export function makeRoomId(random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    const roll = Math.floor(Math.abs(random()) * alphabet.length) % alphabet.length;
    out += alphabet[roll];
  }
  return out;
}
