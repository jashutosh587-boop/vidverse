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

/** Switch this response to the ads profile (called by the watch page when it shows an ad slot). */
export function useAdsCsp(ctx, res) {
  res.locals.cspProfile = 'ads';
  res.setHeader('Content-Security-Policy', buildCsp({ nonce: res.locals.nonce, profile: 'ads', upgradeInsecure: ctx.config.baseUrl.startsWith('https://') }));
}
