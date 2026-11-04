import { parseCookies, serializeCookie } from '../../lib/cookies.js';
import { randomToken, deriveKey, hmacB64u, safeEqual } from '../../lib/crypto.js';

export const COOKIES = { session: '__Host-vv_sid', csrf: '__Host-vv_csrf', flash: '__Host-vv_flash' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const YEAR = 400 * 24 * 3600;

/**
 * Reads cookies and loads who is signed in. After this runs:
 *   req.user          the signed-in member, or null
 *   req.session       { id, token } for an active session
 *   req.mfaPending    { token } while someone has typed a correct password but not yet a second-step code
 *   req.csrfToken     the token every form and fetch must send back
 *   req.flash         a one-time message from the previous request
 *   res.setCookie / res.flash
 */
export function requestContext(ctx) {
  const csrfKey = deriveKey(ctx.config.sessionSecret, 'csrf');
  const flashKey = deriveKey(ctx.config.sessionSecret, 'flash');

  const makeFlash = (type, text) => {
    const body = Buffer.from(JSON.stringify({ type, text })).toString('base64url');
    return `${body}.${hmacB64u(flashKey, body)}`;
  };
  const readFlash = (value) => {
    const [body, mac] = String(value).split('.');
    if (!body || !mac || !safeEqual(hmacB64u(flashKey, body), mac)) return null;
    try {
      const { type, text } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return ['success', 'error', 'info'].includes(type) && typeof text === 'string' ? { type, text: text.slice(0, 300) } : null;
    } catch {
      return null;
    }
  };

  return async (req, res, next) => {
    try {
      res.setCookie = (name, value, opts) => res.append('Set-Cookie', serializeCookie(name, value, opts));
      res.expireCookie = (name) => res.setCookie(name, '', { maxAge: 0 });
      res.flash = (type, text) => res.setCookie(COOKIES.flash, makeFlash(type, text), { maxAge: 120 });

      const cookies = parseCookies(req.headers.cookie);
      req.cookies = cookies;

      let seed = cookies[COOKIES.csrf];
      if (!TOKEN_RE.test(seed ?? '')) {
        seed = randomToken(32);
        res.setCookie(COOKIES.csrf, seed, { maxAge: YEAR });
      }
      req.csrfToken = hmacB64u(csrfKey, seed);
      res.locals.csrfToken = req.csrfToken;

      req.user = null;
      req.session = null;
      req.mfaPending = null;
      const sid = cookies[COOKIES.session];
      if (sid !== undefined) {
        const found = TOKEN_RE.test(sid) ? await ctx.sessions.lookup(sid) : null;
        if (found?.session.stage === 'active') {
          req.user = found.user;
          req.session = { id: found.session.id, token: sid };
        } else if (found?.session.stage === 'mfa') {
          req.mfaPending = { token: sid, userId: found.user.id };
        } else {
          res.expireCookie(COOKIES.session);
        }
      }
      res.locals.user = req.user;

      req.flash = null;
      if (cookies[COOKIES.flash] !== undefined) {
        req.flash = readFlash(cookies[COOKIES.flash]);
        res.expireCookie(COOKIES.flash);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
