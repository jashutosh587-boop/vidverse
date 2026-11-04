import crypto from 'node:crypto';
import { buildCsp } from '../csp.js';

/** Per-request nonce plus the fixed security headers. Pages can switch to the "ads" CSP profile before rendering. */
export function securityHeaders(ctx) {
  const https = ctx.config.baseUrl.startsWith('https://');
  return (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.nonce = nonce;
    res.locals.cspProfile = 'strict';
    res.setHeader('Content-Security-Policy', buildCsp({ nonce, profile: 'strict', upgradeInsecure: https }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=(), browsing-topics=(), fullscreen=(self)');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  };
}

/**
 * Rebuilds this response's policy for a page that needs more than the strict default: the ads profile (a watch page
 * that shows an ad slot) and/or extra media hosts (a catalog video that plays from its archive).
 */
export function applyPageCsp(ctx, res, { ads = false, mediaHosts = [] } = {}) {
  if (!ads && !mediaHosts.length) return;
  const profile = ads ? 'ads' : res.locals.cspProfile ?? 'strict';
  res.locals.cspProfile = profile;
  res.setHeader('Content-Security-Policy', buildCsp({ nonce: res.locals.nonce, profile, upgradeInsecure: ctx.config.baseUrl.startsWith('https://'), mediaHosts }));
}

/** Switch this response to the ads profile (called by the watch page when it shows an ad slot). */
export function useAdsCsp(ctx, res) {
  applyPageCsp(ctx, res, { ads: true });
}
