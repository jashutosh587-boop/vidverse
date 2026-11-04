import crypto from 'node:crypto';

/** 11 URL-safe characters, 64 bits of randomness (the same length YouTube uses). */
export function newVideoId() {
  return crypto.randomBytes(8).toString('base64url');
}

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (s) => typeof s === 'string' && VIDEO_ID_RE.test(s);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
