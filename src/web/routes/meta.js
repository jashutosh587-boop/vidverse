import express from 'express';
import { limit } from '../middleware/limit.js';
import { escapeHtml } from '../../lib/html.js';

/** Routes that must work without a session or CSRF token: health, robots, ads.txt, CSP reports. */
export function metaRoutes(ctx) {
  const r = express.Router();
  const { config } = ctx;

  r.get('/api/health', async (req, res) => {
    try {
      await ctx.db.query('SELECT 1');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ status: 'ok', version: config.version });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  r.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      ['User-agent: *', 'Disallow: /studio', 'Disallow: /admin', 'Disallow: /settings', 'Disallow: /api/', 'Disallow: /login', 'Disallow: /signup', 'Disallow: /notifications', 'Disallow: /media/v/', `Sitemap: ${config.baseUrl}/sitemap.xml`, ''].join('\n'),
    );
  });

  // Public videos and channels, newest first. Unlisted and private videos are never listed.
  r.get('/sitemap.xml', async (req, res) => {
    const [videos, channels] = await Promise.all([
      ctx.db.query(
        `SELECT v.id, v.updated_at FROM videos v JOIN users u ON u.id = v.owner_id
          WHERE v.status = 'ready' AND v.visibility = 'public' AND u.status = 'active' ORDER BY v.published_at DESC LIMIT 5000`,
      ),
      ctx.db.query(
        `SELECT u.handle FROM users u WHERE u.status = 'active'
            AND EXISTS (SELECT 1 FROM videos v WHERE v.owner_id = u.id AND v.status = 'ready' AND v.visibility = 'public') ORDER BY u.created_at DESC LIMIT 2000`,
      ),
    ]);
    const url = (path, lastmod) => `<url><loc>${escapeHtml(config.baseUrl + path)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      url('/'),
      url('/trending'),
      url('/help'),
      ...['terms', 'privacy', 'community-guidelines', 'copyright'].map((slug) => url(`/legal/${slug}`)),
      ...channels.rows.map((c) => url(`/@${c.handle}`)),
      ...videos.rows.map((v) => url(`/watch/${v.id}`, v.updated_at)),
      '</urlset>',
    ].join('\n');
    res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(xml);
  });

  r.get('/ads.txt', (req, res, next) => {
    const { client, adsTxt } = config.ads;
    if (adsTxt) return res.type('text/plain').send(`${adsTxt}\n`);
    if (client) return res.type('text/plain').send(`google.com, ${client.replace('ca-pub-', 'pub-')}, DIRECT, f08c47fec0942fa0\n`);
    return next();
  });

  // Browsers send CSP violation reports without cookies or a CSRF token, so this is deliberately outside the CSRF check.
  r.post(
    '/api/csp-report',
    limit(ctx, { name: 'csp', limit: 30, windowMs: 60_000 }),
    express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '8kb' }),
    (req, res) => {
      const report = req.body?.['csp-report'] ?? (Array.isArray(req.body) ? req.body[0]?.body : null) ?? {};
      const pathOf = (u) => {
        try {
          return new URL(String(u)).pathname;
        } catch {
          return String(u ?? '').slice(0, 60);
        }
      };
      ctx.log.warn('csp violation', {
        directive: String(report['violated-directive'] ?? report.effectiveDirective ?? '').slice(0, 80),
        blocked: String(report['blocked-uri'] ?? report.blockedURL ?? '').slice(0, 100),
        page: pathOf(report['document-uri'] ?? report.documentURL),
      });
      res.status(204).end();
    },
  );

  return r;
}
