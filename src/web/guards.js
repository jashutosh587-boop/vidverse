import { HttpError } from '../lib/errors.js';

const isApi = (req) => req.originalUrl.startsWith('/api/');

/** Signed-in members only. Pages send visitors to sign in and bring them back; API calls get a 401. */
export function requireUser(req, res, next) {
  if (req.user) return next();
  if (isApi(req)) return next(new HttpError(401, 'Sign in to continue.', { code: 'auth' }));
  const back = req.method === 'GET' ? req.originalUrl.slice(0, 500) : '/';
  return res.redirect(303, `/login?next=${encodeURIComponent(back)}`);
}

export function requireVerified(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.email_verified_at) return next();
  return next(new HttpError(403, 'Confirm your email address first. We sent a link when you signed up.', { code: 'unverified' }));
}

export function requireStaff(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.role === 'admin' || req.user.role === 'moderator') return next();
  return next(new HttpError(404, 'We could not find that page.'));
}

export function requireAdmin(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.role === 'admin') return next();
  return next(new HttpError(404, 'We could not find that page.'));
}

/** Creators must have accepted the current creator terms before uploading. */
export function creatorTermsAccepted(user, legalVersion) {
  return user?.creator_terms_version === legalVersion;
}

/**
 * Pages that can move money (payouts, refunds, revenue shares) need an administrator who has two-step sign-in on,
 * so a stolen password alone is not enough to cash anything out.
 */
export function requireTwoStep(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (req.user.totp_enabled_at) return next();
  return next(new HttpError(403, 'Turn on two-step verification (Settings, then Password and security) before using the money pages. They can move real money.', { code: 'two_step_required' }));
}
