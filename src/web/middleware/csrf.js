import { forbidden } from '../../lib/errors.js';
import { safeEqual } from '../../lib/crypto.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every state-changing request must (1) come from this site, judged by Origin and Sec-Fetch-Site, and
 * (2) carry the CSRF token (form field _csrf, JSON field _csrf, or header X-CSRF-Token).
 * Both are required: the token is the main defence, the origin check covers browsers' odd cases.
 */
export function csrfProtection(ctx) {
  const allowedOrigin = new URL(ctx.config.baseUrl).origin;
  const fail = () =>
    forbidden('Your page was out of date or the request did not come from this site. Reload the page and try again.', { code: 'csrf' });

  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();

    const origin = req.headers.origin;
    if (origin !== undefined) {
      const dev = !ctx.config.isProduction && origin === `${req.protocol}://${req.get('host')}`;
      if (origin !== allowedOrigin && !dev) return next(fail());
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return next(fail());

    const sent = req.get('x-csrf-token') ?? (req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '');
    if (!sent || !safeEqual(sent, req.csrfToken)) return next(fail());
    next();
  };
}
