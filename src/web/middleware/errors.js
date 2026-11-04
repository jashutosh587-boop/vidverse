import { HttpError, ValidationError } from '../../lib/errors.js';
import { errorPage } from '../views/pages/error.js';

const wantsJson = (req) => req.originalUrl.startsWith('/api/') || req.get('x-requested-with') === 'fetch' || (req.accepts(['html', 'json']) === 'json' && !req.accepts('html'));

export function notFoundHandler(req, res, next) {
  next(new HttpError(404, 'We could not find that page.', { code: 'not_found' }));
}

export function errorHandler(ctx) {
  return async (err, req, res, _next) => {
    let status = 500;
    let message = 'Something went wrong on our side. Please try again in a moment.';
    let code = 'server_error';
    let fields;
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
      code = err.code ?? 'error';
      if (err instanceof ValidationError) fields = err.fieldErrors;
      for (const [k, v] of Object.entries(err.headers ?? {})) res.setHeader(k, v);
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      message = 'That was too large to send.';
      code = 'too_large';
    } else if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      status = 400;
      message = 'We could not read that request.';
      code = 'bad_request';
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      // Errors raised by the framework for a request that cannot be served: an address with a broken % escape (400),
      // too many form fields (413), an upload that stopped half way (400). They are the sender's mistake, not ours.
      status = err.status;
      message = status === 413 ? 'That was too large to send.' : status === 404 ? 'We could not find that page.' : 'We could not read that request.';
      code = status === 413 ? 'too_large' : status === 404 ? 'not_found' : 'bad_request';
    }
    if (status >= 500) ctx.log.error('request failed', { method: req.method, path: req.path, status, err: { name: err?.name, message: err?.message, stack: ctx.config.isProduction ? undefined : err?.stack } });
    if (res.headersSent) return res.end();
    res.removeHeader('Content-Length');
    res.status(status);
    if (wantsJson(req)) return res.json({ error: { message, code, fields } });
    // Video files and thumbnails are answered before the page machinery exists. A plain sentence is the right reply to a
    // refused file, and a refused file is not a fault, so it must not be logged as one.
    if (typeof res.page !== 'function') return res.type('text/plain').send(message);
    try {
      await res.page(errorPage({ status, message, code, requestId: status >= 500 ? req.id : null }), { title: status === 404 ? 'Page not found' : 'Something went wrong', noindex: true });
    } catch (e) {
      ctx.log.error('error page failed', { err: e });
      res.type('text/plain').send(message);
    }
  };
}
