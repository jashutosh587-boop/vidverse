import { tooMany } from '../../lib/errors.js';

/**
 * Per-route rate limit. `key` picks what is counted (default: the client address).
 *   router.post('/login', limit(ctx, { name: 'login', limit: 20, windowMs: 15 * 60_000 }), handler)
 */
export function limit(ctx, { name, limit: max, windowMs, key }) {
  return (req, res, next) => {
    const who = key ? key(req) : req.ip;
    const r = ctx.limiter.hit(`${name}:${who}`, { limit: max, windowMs });
    if (r.allowed) return next();
    const seconds = Math.ceil(r.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(seconds));
    next(tooMany(`Too many attempts. Try again in ${seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`, { code: 'rate_limited' }));
  };
}
