/**
 * Content-Security-Policy builder.
 *
 * "strict" is used everywhere: scripts need this response's nonce, nothing is inline, nothing loads from
 * another site. "ads" is used only on the watch page of a video that shows an AdSense slot, and follows
 * Google's guidance for AdSense under a nonce-based policy: the ad script (loaded with our nonce) may load
 * the scripts it needs ('strict-dynamic'), and ad frames, images and requests may come from https hosts.
 */
export function buildCsp({ nonce, profile = 'strict', upgradeInsecure = false }) {
  const d = {
    'default-src': ["'none'"],
    'script-src': [`'nonce-${nonce}'`, "'strict-dynamic'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
  };
  if (profile === 'ads') {
    d['script-src'] = [`'nonce-${nonce}'`, "'strict-dynamic'", "'unsafe-eval'", "'unsafe-inline'", 'https:', 'http:'];
    d['style-src'] = ["'self'", "'unsafe-inline'"];
    d['img-src'] = ["'self'", 'data:', 'https:'];
    d['connect-src'] = ["'self'", 'https:'];
    d['frame-src'] = ['https:'];
  }
  const parts = Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`);
  parts.push('report-uri /api/csp-report');
  if (upgradeInsecure) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}
