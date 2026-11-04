import express from 'express';
import { HttpError, ValidationError, notFound } from '../../lib/errors.js';
import { parseAmount } from '../../lib/money.js';
import { cleanText } from '../../lib/validate.js';
import { limit } from '../middleware/limit.js';
import { requireStaff, requireAdmin, requireTwoStep } from '../guards.js';
import { pageOf } from '../util.js';
import * as v from '../views/pages/admin.js';

const str = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const NOINDEX = (title) => ({ title, noindex: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
/** Makes % and _ in a search box match themselves instead of acting as wildcards. */
const likeOf = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const reasonSchema = cleanText({ min: 3, max: 300, label: 'The reason' });

/** The back office. Moderators see reports, people, videos and messages; administrators also see money, jobs and the audit log. */
export function adminRoutes(ctx) {
  const r = express.Router();
  const mon = ctx.monetization;
  const m = mon ? { currency: mon.currency } : null;
  const sensitive = limit(ctx, { name: 'admin-sensitive', limit: 20, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });

  r.use('/admin', requireStaff);
  const adminOnly = [requireAdmin];
  const moneyOnly = [requireAdmin, requireTwoStep, (req, res, next) => (mon ? next() : next(notFound()))];

  /** Runs a staff action, then goes back to a page with a one-line result. Problems the staff member can fix are shown, not thrown. */
  const act = (fn, { done, back }) => async (req, res) => {
    try {
      await fn(req, res);
      if (done) res.flash('success', done);
    } catch (e) {
      if (e instanceof ValidationError) res.flash('error', Object.values(e.fieldErrors)[0] ?? e.message);
      else if (e instanceof HttpError && e.status === 404) throw e; // an id that is not an id, or something that is not there: a real 404, not a friendly message
      else if (e instanceof HttpError && e.status < 500) res.flash('error', e.message);
      else throw e;
    }
    return res.redirect(303, typeof back === 'function' ? back(req) : back);
  };
  const needUuid = (req) => {
    if (!UUID.test(String(req.params.id))) throw notFound();
    return String(req.params.id);
  };
  const reasonOf = (value) => {
    const p = reasonSchema.safeParse(str(value, 400));
    if (!p.success) throw new ValidationError({ reason: p.error.issues[0].message });
    return p.data;
  };

  // ------------------------------------------------------------------ overview

  r.get('/admin', async (req, res) => {
    const admin = req.user.role === 'admin';
    const stats = await ctx.db.one(`SELECT
        (SELECT count(*) FROM users WHERE status = 'active')::int AS users,
        (SELECT count(*) FROM users WHERE status = 'active' AND creator_terms_version IS NOT NULL)::int AS creators,
        (SELECT count(*) FROM videos WHERE status = 'ready')::int AS videos_ready,
        (SELECT count(*) FROM videos WHERE status IN ('uploading', 'processing'))::int AS videos_processing,
        (SELECT count(*) FROM videos WHERE status = 'failed')::int AS videos_failed,
        (SELECT count(*) FROM reports WHERE status = 'open')::int AS reports_open,
        (SELECT count(*) FROM reports WHERE status = 'open' AND reason = 'child_safety')::int AS reports_child,
        (SELECT count(*) FROM contact_messages WHERE status = 'open')::int AS messages_open,
        (SELECT count(*) FROM payouts WHERE status IN ('requested', 'approved'))::int AS payouts_open,
        (SELECT count(*) FROM jobs WHERE status = 'failed')::int AS jobs_failed`);
    const [summary, recent] = await Promise.all([admin && mon ? mon.platformSummary() : null, admin ? ctx.audit.recent(8) : []]);
    await res.page(v.overviewPage(req, { stats, summary, recent, m }), NOINDEX('Admin'));
  });

  // ------------------------------------------------------------------ reports

  r.get('/admin/reports', async (req, res) => {
    const status = pick(req.query.status, ['open', 'actioned', 'dismissed'], 'open');
    const { page, limit: size, offset } = pageOf(req, 20);
    const { items, hasMore } = await ctx.moderation.queue({ status, limit: size, offset });
    await res.page(v.reportsPage(req, { items, hasMore, page, status }), NOINDEX('Reports'));
  });

  r.post('/admin/reports/:id', act(async (req) => {
    const id = String(req.params.id);
    if (!/^\d{1,18}$/.test(id)) throw notFound();
    const decision = pick(str(req.body.decision, 10), ['dismiss', 'remove', 'suspend'], null);
    if (!decision) throw new HttpError(400, 'Choose a decision.');
    await ctx.moderation.resolve(Number(id), req.user, decision, str(req.body[`note-${id}`], 300).trim());
  }, { done: 'Saved.', back: '/admin/reports' }));

  // ------------------------------------------------------------------ people

  r.get('/admin/users', async (req, res) => {
    const q = str(req.query.q, 100).trim();
    const admin = req.user.role === 'admin';
    const { page, limit: size, offset } = pageOf(req, 25);
    const { rows } = await ctx.db.query(
      `SELECT u.id, u.handle, u.display_name, u.email, u.role, u.status, u.created_at, u.suspended_reason,
              (SELECT count(*) FROM videos x WHERE x.owner_id = u.id)::int AS videos
         FROM users u
        WHERE $1 = '' OR u.handle ILIKE $2 OR u.display_name ILIKE $2 OR ($3 AND u.email ILIKE $2)
        ORDER BY u.created_at DESC, u.id LIMIT $4 OFFSET $5`,
      [q, likeOf(q), admin, size + 1, offset],
    );
    await res.page(v.usersPage(req, { items: rows.slice(0, size), hasMore: rows.length > size, page, q }), NOINDEX('People'));
  });

  r.post('/admin/users/:id/suspend', act(async (req) => {
    const id = needUuid(req);
    await ctx.moderation.suspendUser(id, req.user, reasonOf(req.body.reason));
  }, { done: 'Suspended. They are signed out everywhere.', back: '/admin/users' }));

  r.post('/admin/users/:id/restore', act(async (req) => {
    await ctx.moderation.restoreUser(needUuid(req), req.user);
  }, { done: 'Restored.', back: '/admin/users' }));

  r.post('/admin/users/:id/role', adminOnly, act(async (req) => {
    const id = needUuid(req);
    const role = pick(str(req.body.role, 12), ['user', 'moderator'], null);
    if (!role) throw new HttpError(400, 'Choose a role.');
    if (id === req.user.id) throw new HttpError(400, 'You cannot change your own role.');
    const changed = await ctx.db.one(`UPDATE users SET role = $2 WHERE id = $1 AND role <> 'admin' AND status = 'active' RETURNING id`, [id, role]);
    if (!changed) throw new HttpError(409, 'That role cannot be changed. Administrators are managed from the command line.');
    await ctx.audit.record(req.user.id, 'user.role_change', { targetType: 'user', targetId: id, meta: { role }, ip: req.ip });
  }, { done: 'Role changed.', back: '/admin/users' }));

  // ------------------------------------------------------------------ videos

  r.get('/admin/videos', async (req, res) => {
    const q = str(req.query.q, 100).trim();
    const status = pick(req.query.status, ['all', 'ready', 'processing', 'failed', 'removed'], 'all');
    const { page, limit: size, offset } = pageOf(req, 25);
    const { rows } = await ctx.db.query(
      `SELECT v.id, v.title, v.status, v.visibility, v.created_at, v.views, v.removed_reason, u.handle
         FROM videos v JOIN users u ON u.id = v.owner_id
        WHERE ($1 = 'all' OR v.status = $1) AND ($2 = '' OR v.title ILIKE $3 OR v.id = $2)
        ORDER BY v.created_at DESC, v.id LIMIT $4 OFFSET $5`,
      [status, q, likeOf(q), size + 1, offset],
    );
    await res.page(v.videosPage(req, { items: rows.slice(0, size), hasMore: rows.length > size, page, q, status }), NOINDEX('Videos'));
  });

  r.post('/admin/videos/:id/remove', act(async (req) => {
    const id = str(req.params.id, 20);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw notFound();
    if (!(await ctx.videos.removeByStaff(id, req.user.id, reasonOf(req.body.reason)))) throw new HttpError(409, 'That video is already removed, or does not exist.');
  }, { done: 'Removed. The creator was told why.', back: '/admin/videos' }));

  r.post('/admin/videos/:id/restore', act(async (req) => {
    const id = str(req.params.id, 20);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw notFound();
    if (!(await ctx.videos.restoreByStaff(id, req.user.id))) throw new HttpError(409, 'Only a removed video can be restored.');
  }, { done: 'Restored.', back: '/admin/videos?status=removed' }));

  // ------------------------------------------------------------------ messages from people

  r.get('/admin/messages', async (req, res) => {
    const status = pick(req.query.status, ['open', 'closed'], 'open');
    const { page, limit: size, offset } = pageOf(req, 20);
    const { rows } = await ctx.db.query(
      `SELECT m.id, m.email, m.subject, m.body, m.status, m.created_at, u.handle AS user_handle
         FROM contact_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.status = $1 ORDER BY m.created_at ${status === 'open' ? 'ASC' : 'DESC'}, m.id LIMIT $2 OFFSET $3`,
      [status, size + 1, offset],
    );
    await res.page(v.messagesPage(req, { items: rows.slice(0, size), hasMore: rows.length > size, page, status }), NOINDEX('Messages'));
  });

  r.post('/admin/messages/:id/status', act(async (req) => {
    const id = String(req.params.id);
    if (!/^\d{1,18}$/.test(id)) throw notFound();
    const status = pick(str(req.body.status, 8), ['open', 'closed'], null);
    if (!status) throw new HttpError(400, 'Unknown status.');
    const row = await ctx.db.one('UPDATE contact_messages SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
    if (!row) throw notFound();
    await ctx.audit.record(req.user.id, `message.${status}`, { targetType: 'contact_message', targetId: id });
  }, { done: 'Saved.', back: '/admin/messages' }));

  // ------------------------------------------------------------------ payouts (administrators with two-step sign-in)

  r.get('/admin/payouts', ...moneyOnly, async (req, res) => {
    const status = pick(req.query.status, ['open', 'paid', 'rejected', 'cancelled', 'all'], 'open');
    const { page, limit: size, offset } = pageOf(req, 20);
    const { items, hasMore } = await mon.adminListPayouts({ status, limit: size, offset });
    await res.page(v.adminPayoutsPage(req, { items, hasMore, page, status, m }), NOINDEX('Payouts'));
  });

  r.post('/admin/payouts/:id/approve', ...moneyOnly, act(async (req) => mon.approvePayout(needUuid(req), req.user.id), { done: 'Approved.', back: '/admin/payouts' }));

  r.post('/admin/payouts/:id/paid', ...moneyOnly, act(async (req) => mon.markPayoutPaid(needUuid(req), req.user.id, str(req.body.reference, 120)), { done: 'Marked as paid. The creator was told.', back: '/admin/payouts' }));

  r.post('/admin/payouts/:id/reject', ...moneyOnly, act(async (req) => mon.rejectPayout(needUuid(req), req.user.id, reasonOf(req.body.reason)), { done: 'Declined. The money is back in the creator’s balance.', back: '/admin/payouts' }));

  r.post('/admin/payouts/:id/reveal', ...moneyOnly, sensitive, async (req, res) => {
    const id = needUuid(req);
    if (!(await ctx.auth.verifyCurrentPassword(req.user.id, str(req.body.password, 128)))) {
      res.flash('error', 'That is not your password.');
      return res.redirect(303, '/admin/payouts');
    }
    const details = await mon.revealPayoutDetails(id, req.user.id);
    const payout = await ctx.db.one('SELECT p.amount_minor, p.currency, u.handle, u.display_name FROM payouts p JOIN users u ON u.id = p.user_id WHERE p.id = $1', [id]);
    return res.page(v.payoutDetailsPage(req, { payout, details, m }), NOINDEX('Where to pay'));
  });

  // ------------------------------------------------------------------ tips and refunds

  r.get('/admin/payments', ...moneyOnly, async (req, res) => {
    const status = pick(req.query.status, ['all', 'paid', 'created', 'expired', 'failed', 'refunded'], 'all');
    const { page, limit: size, offset } = pageOf(req, 30);
    const { items, hasMore } = await mon.adminListPayments({ status, limit: size, offset });
    await res.page(v.adminPaymentsPage(req, { items, hasMore, page, status, m }), NOINDEX('Tips'));
  });

  r.post('/admin/payments/:id/refund', ...moneyOnly, act(async (req) => mon.refundPayment(needUuid(req), req.user.id, reasonOf(req.body.reason)), { done: 'Refund recorded. The tip is out of the creator’s balance. Now return the money to the payer from your payment provider’s dashboard.', back: '/admin/payments' }));

  // ------------------------------------------------------------------ revenue shares

  const batchValues = (b) => ({ label: str(b.label, 120), source: str(b.source, 20), gross: str(b.gross, 20), share: str(b.share, 8), periodStart: str(b.periodStart, 10), periodEnd: str(b.periodEnd, 10), google_permission: b.google_permission === '1' });

  const showBatches = async (req, res, { values = {}, errors = {} } = {}, status = 200) =>
    res.status(status).page(v.revenueListPage(req, { batches: await ctx.revenue.list(), values, errors, m }), NOINDEX('Revenue shares'));

  r.get('/admin/revenue', ...moneyOnly, (req, res) => showBatches(req, res));

  r.post('/admin/revenue', ...moneyOnly, async (req, res) => {
    const values = batchValues(req.body ?? {});
    const errors = {};
    const gross = parseAmount(values.gross);
    if (gross === null || gross <= 0) errors.gross = 'Enter the amount in rupees, such as 25000.';
    const shareOk = /^\d{1,3}(\.\d{1,2})?$/.test(values.share.trim());
    const bps = shareOk ? Math.round(Number(values.share) * 100) : -1;
    if (!shareOk || bps > 10_000) errors.share = 'Enter a percentage between 0 and 100, such as 70.';
    // The service checks every field again (it is the one place the rules live); a bad amount or percentage here
    // becomes an invalid value there, so no batch is created, and the messages are merged for the form.
    let id = null;
    try {
      id = await ctx.revenue.createBatch(
        { label: values.label, source: values.source, grossMinor: gross ?? 0, creatorShareBps: bps, periodStart: values.periodStart, periodEnd: values.periodEnd, googlePermissionAttested: values.google_permission },
        req.user.id,
      );
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return showBatches(req, res, { values, errors: { ...e.fieldErrors, ...errors } }, 422);
    }
    return res.redirect(303, `/admin/revenue/${id}`);
  });

  const showBatch = async (req, res, extra = {}, status = 200) => {
    const preview = await ctx.revenue.preview(needUuid(req));
    return res.status(status).page(v.revenueBatchPage(req, { batch: preview.batch, preview, m, ...extra }), NOINDEX('Revenue share'));
  };
  r.get('/admin/revenue/:id', ...moneyOnly, (req, res) => showBatch(req, res));

  r.post('/admin/revenue/:id/post', ...moneyOnly, async (req, res) => {
    const id = needUuid(req);
    if (req.body.confirm !== '1') return showBatch(req, res, { error: 'Tick the box to confirm.' }, 422);
    try {
      await ctx.revenue.post(id, req.user.id);
    } catch (e) {
      if (e instanceof ValidationError) return showBatch(req, res, { error: Object.values(e.fieldErrors)[0] ?? e.message }, 422);
      if (e instanceof HttpError && e.status < 500) return showBatch(req, res, { error: e.message }, e.status);
      throw e;
    }
    res.flash('success', 'Posted. The shares are in the creators’ balances.');
    return res.redirect(303, `/admin/revenue/${id}`);
  });

  // ------------------------------------------------------------------ jobs and audit log

  r.get('/admin/jobs', ...adminOnly, async (req, res) => {
    const [stats, failures] = await Promise.all([ctx.jobs.stats(), ctx.jobs.recentFailures(25)]);
    await res.page(v.jobsPage(req, { stats, failures }), NOINDEX('Jobs'));
  });

  r.post('/admin/jobs/:id/retry', ...adminOnly, act(async (req) => {
    const id = String(req.params.id);
    if (!/^\d{1,18}$/.test(id)) throw notFound();
    if (!(await ctx.jobs.retry(Number(id)))) throw new HttpError(409, 'That job is not in the failed list any more.');
    await ctx.audit.record(req.user.id, 'job.retry', { targetType: 'job', targetId: id });
  }, { done: 'Queued again.', back: '/admin/jobs' }));

  r.get('/admin/audit', ...adminOnly, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, 50);
    const rows = await ctx.audit.recent(size + 1, offset);
    await res.page(v.auditPage(req, { items: rows.slice(0, size), hasMore: rows.length > size, page }), NOINDEX('Audit log'));
  });

  return r;
}

export const adminMount = { attach: (app, ctx) => app.use(adminRoutes(ctx)) };
