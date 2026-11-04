import express from 'express';
import crypto from 'node:crypto';
import { LEGAL_VERSION } from './config.js';
import { securityHeaders, applyPageCsp } from './web/middleware/security.js';
import { requestContext } from './web/middleware/context.js';
import { csrfProtection } from './web/middleware/csrf.js';
import { notFoundHandler, errorHandler } from './web/middleware/errors.js';
import { renderLayout } from './web/views/layout.js';
import { PUBLIC_DIR, FONT_DIRS, HLS_FILE } from './web/assets.js';
import { metaRoutes } from './web/routes/meta.js';
import { authRoutes } from './web/routes/auth.js';

const TERMS_EXEMPT = /^\/(legal|logout|help|contact|api\/health|api\/csp-report|api\/assistant)(\/|$)/;

/** Builds the Express app from a ready context. No network listener is started here (tests call this directly). */
export function createApp(ctx, { extraRoutes = [] } = {}) {
  const { config } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    req.ctx = ctx;
    req.id = crypto.randomBytes(5).toString('hex');
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      ctx.log.info('request', { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - start) / 1_000_000n), user: req.user?.id });
    });
    next();
  });
  app.use(securityHeaders(ctx));

  // Static files: fonts, the player library and the site's own CSS/JS. Versioned URLs cache for a year.
  const staticOpts = {
    index: false,
    dotfiles: 'ignore',
    fallthrough: true,
    maxAge: '1y',
    immutable: true,
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
  };
  app.use('/assets/fonts/sans', express.static(FONT_DIRS.sans, staticOpts));
  app.use('/assets/fonts/mono', express.static(FONT_DIRS.mono, staticOpts));
  app.get('/assets/vendor/hls.min.js', (req, res) => res.sendFile(HLS_FILE, { maxAge: '1y', immutable: true, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }));
  app.use('/assets', express.static(PUBLIC_DIR, staticOpts));

  app.use(metaRoutes(ctx));
  for (const mount of extraRoutes.filter((m) => m.beforeSession)) mount.attach(app, ctx);

  app.use(requestContext(ctx));
  app.use((req, res, next) => {
    res.page = async (content, opts = {}) => {
      const extra = {};
      if (req.user) {
        extra.unread = await ctx.notifications.unreadCount(req.user.id);
        if (req.user.daily_limit_minutes && ctx.analytics) extra.todayWatchMs = await ctx.analytics.todayWatchMs(req.user.id);
      }
      applyPageCsp(ctx, res, { ads: !!opts.ads, mediaHosts: opts.mediaHosts ?? [] });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Vary', 'Cookie');
      res.type('html').send(String(renderLayout(req, res, content, { ...opts, extra })));
    };
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));
  app.use(express.json({ limit: '64kb' }));
  app.use(csrfProtection(ctx));

  // Everyone signed in must have accepted the current Terms before using the site.
  app.use((req, res, next) => {
    if (!req.user || req.user.terms_version === LEGAL_VERSION || TERMS_EXEMPT.test(req.path)) return next();
    if (req.originalUrl.startsWith('/api/')) return res.status(403).json({ error: { message: 'Please accept the updated Terms to continue.', code: 'terms' } });
    return res.redirect(303, `/legal/accept?next=${encodeURIComponent(req.method === 'GET' ? req.originalUrl.slice(0, 500) : '/')}`);
  });

  app.use(authRoutes(ctx));
  for (const mount of extraRoutes.filter((m) => !m.beforeSession)) mount.attach(app, ctx);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx));
  return app;
}
