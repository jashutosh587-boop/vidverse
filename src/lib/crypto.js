import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacB64u = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

/** HKDF so one root secret yields independent keys for CSRF, cookies, viewer hashes and so on. */
export function deriveKey(secret, label) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(`vidverse:${label}`), 32));
}

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) {
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

// ---- Passwords: scrypt, parameters stored with each hash so they can be raised later. ----

export const PROD_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
const KEYLEN = 64;
const MAX_CONCURRENT_HASHES = 2;
let active = 0;
const waiting = [];

async function slot(fn) {
  // scrypt at production cost uses ~128 MiB, so a burst of logins must queue instead of exhausting memory.
  if (active >= MAX_CONCURRENT_HASHES) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function derive(password, salt, { N, r, p }) {
  const maxmem = 128 * N * r + 4 * 1024 * 1024 + 128 * r * p;
  return scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem });
}

export async function hashPassword(password, params = PROD_SCRYPT) {
  const salt = crypto.randomBytes(16);
  const hash = await slot(() => derive(password, salt, params));
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function parseHash(stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored ?? '');
  if (!m) return null;
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4], 'base64url'), hash: Buffer.from(m[5], 'base64url') };
}

export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || parsed.N > 2 ** 20) return false;
  const got = await slot(() => derive(password, parsed.salt, parsed));
  return got.length === parsed.hash.length && crypto.timingSafeEqual(got, parsed.hash);
}

/** True when a stored hash was made with cheaper parameters than the current ones. */
export function needsRehash(stored, params = PROD_SCRYPT) {
  const p = parseHash(stored);
  return !p || p.N < params.N || p.r < params.r || p.p < params.p;
}

let dummy;
/** Spend the same time as a real check so an unknown email cannot be told apart by timing. */
export async function verifyDummy(password, params) {
  dummy ??= await hashPassword('dummy-password-for-timing', params);
  await verifyPassword(password, dummy);
  return false;
}

// ---- Authenticated encryption for stored secrets (payout details, 2FA seeds). ----

/** Spec: "k2:<base64 32 bytes>,k1:<base64 32 bytes>". The first key encrypts; all keys decrypt. */
export function createKeyring(spec) {
  const keys = new Map();
  let currentId = null;
  for (const item of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    const id = item.slice(0, i);
    const key = Buffer.from(item.slice(i + 1), 'base64');
    if (i < 1 || !/^[a-z0-9]{1,8}$/i.test(id) || key.length !== 32) throw new Error('ENCRYPTION_KEYS must look like "k1:<base64 of 32 bytes>"');
    keys.set(id, key);
    currentId ??= id;
  }
  if (!currentId) throw new Error('No encryption key configured');
  return { currentId, keys };
}

/** `aad` binds the ciphertext to its row, so a value copied to another user's record fails to decrypt. */
export function encryptString(keyring, plaintext, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyring.keys.get(keyring.currentId), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', keyring.currentId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptString(keyring, token, aad = '') {
  const [v, id, iv, tag, ct] = String(token).split('.');
  const key = keyring.keys.get(id);
  if (v !== 'v1' || !key || !iv || !tag || ct === undefined) throw new Error('Unreadable encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
