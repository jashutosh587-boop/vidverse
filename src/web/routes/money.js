import express from 'express';
import { HttpError, ValidationError, notFound } from '../../lib/errors.js';
import { isVideoId } from '../../lib/ids.js';
import { dayString } from '../../lib/format.js';
import { csvLine, csvMoney, csvText } from '../../lib/csv.js';
import { parseAmount } from '../../lib/money.js';
import { cleanText } from '../../lib/validate.js';
import { DETAILS_COOLOFF_MS } from '../../services/monetization.js';
import { limit } from '../middleware/limit.js';
import { requireUser } from '../guards.js';
import { pageOf } from '../util.js';
import * as v from '../views/pages/money.js';

const str = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const NOINDEX = (title, extra = {}) => ({ title, noindex: true, ...extra });
const LABEL = { razorpay: 'Razorpay', test: 'the practice checkout' };
const messageSchema = cleanText({ max: 140, label: 'The message' });

/** Tips (viewer side), earnings and payouts (creator side). Only mounted when a payment provider is configured. */
export function moneyRoutes(ctx) {
  const r = express.Router();
  const mon = ctx.monetization;
  if (!mon) return r;
  const { config } = ctx;

  const tipLimit = limit(ctx, { name: 'tip', limit: 20, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });
  const sensitive = limit(ctx, { name: 'payout-sensitive', limit: 10, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });
  const statementLimit = limit(ctx, { name: 'statement', limit: 10, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });

  const model = () => ({
    currency: mon.currency,
    min: mon.limits.min,
    max: mon.limits.max,
    feeBps: mon.limits.feeBps,
    holdDays: mon.limits.holdDays,
    payoutMin: mon.limits.payoutMin,
    testMode: mon.providerName === 'test',
    providerLabel: LABEL[mon.providerName] ?? 'our payment provider',
  });

  /** Where the payer may be sent: the provider's https page, or (practice mode, outside production) this site. */
  function checkoutTarget(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:') return u.toString();
      if (!config.isProduction && u.origin === new URL(config.baseUrl).origin) return u.toString();
    } catch {
      /* not a URL */
    }
    return null;
  }

  // ------------------------------------------------------------------ viewers: tipping a channel

  async function tipTarget(req) {
    const handle = String(req.params.handle ?? '').toLowerCase();
    const channel = await ctx.db.one(`SELECT id, handle, display_name, avatar_hue FROM users WHERE handle = $1 AND status = 'active'`, [handle]);
    if (!channel) throw notFound('We could not find that channel.');
    if (channel.id === req.user.id) throw new HttpError(400, 'You cannot tip your own channel.');
    if (!(await mon.tipsAvailable(channel.id))) throw notFound('This channel cannot receive tips right now.');
    const wanted = str(req.query.video ?? req.body?.video, 20);
    const video = isVideoId(wanted) ? await ctx.db.one(`SELECT id, title FROM videos WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND visibility = 'public'`, [wanted, channel.id]) : null;
    return { channel, video };
  }

  const emptyValues = { preset: '', amount: '', message: '', anonymous: false };

  r.get('/support/@:handle', requireUser, async (req, res) => {
    const { channel, video } = await tipTarget(req);
    await res.page(v.tipPage(req, { channel, video, values: emptyValues, m: model() }), NOINDEX(`Support ${channel.display_name}`));
  });

  r.post('/support/@:handle', requireUser, tipLimit, async (req, res) => {
    const { channel, video } = await tipTarget(req);
    const values = { preset: str(req.body.preset, 12), amount: str(req.body.amount, 20), message: str(req.body.message, 300), anonymous: req.body.anonymous === '1' };
    const errors = {};

    const typed = values.amount.trim();
    const amountMinor = parseAmount(typed || values.preset);
    if (!typed && !values.preset) errors.amount = 'Choose an amount, or type one.';
    else if (amountMinor === null) errors.amount = 'Enter an amount in rupees, such as 250 or 99.50.';
    const message = messageSchema.safeParse(values.message);
    if (!message.success) errors.message = message.error.issues[0].message;

    const render = (e, status = 422) => res.status(status).page(v.tipPage(req, { channel, video, values, errors: e, m: model() }), NOINDEX(`Support ${channel.display_name}`));
    if (Object.keys(errors).length) return render(errors);

    try {
      const tip = await mon.createTip({ payer: req.user, channelId: channel.id, videoId: video?.id ?? null, amountMinor, message: message.data, anonymous: values.anonymous });
      return res.redirect(303, `/support/continue/${tip.paymentId}`);
    } catch (e) {
      if (e instanceof ValidationError) return render(e.fieldErrors);
      if (e instanceof HttpError && e.status < 500) return render({ _: e.message }, e.status);
      throw e;
    }
  });

  r.get('/support/continue/:id', requireUser, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    const target = payment.status === 'created' && payment.checkout_url ? checkoutTarget(payment.checkout_url) : null;
    if (!target) return res.redirect(303, `/support/thanks/${payment.id}`);
    await res.page(v.continuePage(req, { payment, checkoutUrl: target, m: model() }), NOINDEX('Continue to payment', { scripts: ['js/support.js'] }));
  });

  r.get('/support/thanks/:id', requireUser, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    await res.page(v.thanksPage(req, { payment }), NOINDEX('Your tip', { scripts: ['js/support.js'] }));
  });

  r.get('/api/support/:id/status', requireUser, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: payment.status });
  });

  // ------------------------------------------------------------------ practice checkout (never in production)

  const practiceOnly = (req, res, next) => (mon.providerName === 'test' && !config.isProduction ? next() : next(notFound()));

  r.get('/support/test-checkout/:id', requireUser, practiceOnly, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    if (payment.status !== 'created') return res.redirect(303, `/support/thanks/${payment.id}`);
    await res.page(v.testCheckoutPage(req, { payment }), NOINDEX('Practice checkout'));
  });

  r.post('/support/test-checkout/:id/pay', requireUser, practiceOnly, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    await mon.applyProviderEvent({
      id: `test-paid-${payment.id}`,
      rawType: 'test.paid',
      type: 'paid',
      providerRef: `test_${payment.id}`,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      providerPaymentId: `test_pay_${payment.id}`,
      paidAt: null,
    });
    res.redirect(303, `/support/thanks/${payment.id}`);
  });

  r.post('/support/test-checkout/:id/cancel', requireUser, practiceOnly, async (req, res) => {
    const payment = await mon.tipForPayer(String(req.params.id), req.user.id);
    if (!payment) throw notFound();
    await mon.applyProviderEvent({ id: `test-cancelled-${payment.id}`, rawType: 'test.cancelled', type: 'cancelled', providerRef: `test_${payment.id}` });
    res.redirect(303, `/support/thanks/${payment.id}`);
  });

  // ------------------------------------------------------------------ creators: earnings

  r.get('/studio/earnings', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, 20);
    const [balances, earnings, tips, ledger, canReceive] = await Promise.all([
      mon.balances(req.user.id),
      mon.earnings(req.user.id),
      mon.recentTips(req.user.id, { limit: 10 }),
      mon.ledger(req.user.id, { limit: size, offset }),
      mon.tipsAvailable(req.user.id),
    ]);
    await res.page(v.earningsPage(req, { balances, earnings, tips, ledger, canReceive, page, now: ctx.clock(), m: model() }), NOINDEX('Earnings'));
  });

  r.get('/studio/earnings.csv', requireUser, statementLimit, async (req, res) => {
    const { rows } = await ctx.db.query(
      `SELECT created_at, kind, amount_minor, currency, available_at, ref_type, ref_id, note FROM ledger_entries WHERE user_id = $1 ORDER BY id ASC LIMIT 5000`,
      [req.user.id],
    );
    const iso = (d) => new Date(d).toISOString();
    const lines = [csvLine(['Date (UTC)', 'What', 'Amount', 'Currency', 'Available from (UTC)', 'Reference', 'Note'])];
    for (const e of rows) {
      lines.push(csvLine([csvText(iso(e.created_at)), csvText(e.kind), csvMoney(e.amount_minor), csvText(e.currency), csvText(iso(e.available_at)), csvText(`${e.ref_type}:${e.ref_id}`), csvText(e.note)]));
    }
    const name = `${config.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-statement-${dayString(ctx.clock())}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.send(String.fromCharCode(0xfeff) + lines.join(''));
  });

  // ------------------------------------------------------------------ creators: payouts

  async function showPayouts(req, res, { values = {}, errors = {} } = {}, status = 200) {
    const [balances, profile, payouts] = await Promise.all([mon.balances(req.user.id), mon.payoutProfile(req.user.id), mon.listPayouts(req.user.id)]);
    const coolOffUntil = profile ? new Date(new Date(profile.updated_at).getTime() + DETAILS_COOLOFF_MS) : null;
    return res.status(status).page(v.payoutsPage(req, { balances, profile, payouts, coolOffUntil, now: ctx.clock(), values, errors, m: model() }), NOINDEX('Payouts'));
  }

  r.get('/studio/payouts', requireUser, (req, res) => showPayouts(req, res));

  r.post('/studio/payouts/details', requireUser, sensitive, async (req, res) => {
    const b = req.body ?? {};
    const values = { method: str(b.method, 8), upi: str(b.upi, 120), holder: str(b.holder, 100), account: str(b.account, 40), ifsc: str(b.ifsc, 30) };
    if (!(await ctx.auth.verifyCurrentPassword(req.user.id, str(b.password, 128)))) return showPayouts(req, res, { values, errors: { password: 'That is not your password.' } }, 422);
    try {
      await mon.savePayoutProfile(req.user.id, values);
    } catch (e) {
      if (e instanceof ValidationError) return showPayouts(req, res, { values, errors: e.fieldErrors }, 422);
      throw e;
    }
    res.flash('success', 'Payout details saved. For your safety, payouts wait 24 hours after a change, and we sent you an email about it.');
    return res.redirect(303, '/studio/payouts');
  });

  r.post('/studio/payouts/request', requireUser, sensitive, async (req, res) => {
    const typed = str(req.body.payout_amount, 20);
    const values = { payout_amount: typed };
    const minor = parseAmount(typed);
    if (minor === null) return showPayouts(req, res, { values, errors: { payout_amount: 'Enter an amount in rupees, such as 500 or 1250.50.' } }, 422);
    try {
      await mon.requestPayout(req.user.id, minor);
    } catch (e) {
      if (e instanceof ValidationError) return showPayouts(req, res, { values, errors: { payout_amount: e.fieldErrors.amount ?? e.message } }, 422);
      if (e instanceof HttpError && e.status < 500) return showPayouts(req, res, { values, errors: { _: e.message } }, e.status);
      throw e;
    }
    res.flash('success', 'Payout requested. A person will review it. You can follow it on this page.');
    return res.redirect(303, '/studio/payouts');
  });

  r.post('/studio/payouts/:id/cancel', requireUser, async (req, res) => {
    try {
      await mon.cancelPayout(req.user.id, String(req.params.id));
      res.flash('success', 'Payout cancelled. The amount is back in your balance.');
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      res.flash('error', e.message);
    }
    return res.redirect(303, '/studio/payouts');
  });

  return r;
}

export const moneyMount = { attach: (app, ctx) => app.use(moneyRoutes(ctx)) };

/**
 * The payment provider calls this. It is mounted before sessions, cookies, CSRF and body parsing: the signature
 * covers the exact bytes of the body, so the body must reach the check untouched.
 */
export const webhookMount = {
  beforeSession: true,
  attach(app, ctx) {
    if (!ctx.monetization || ctx.config.payments.provider !== 'razorpay') return;
    app.post('/webhooks/razorpay', express.raw({ type: () => true, limit: '200kb' }), async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const event = ctx.paymentProvider.readWebhook({ rawBody: req.body, headers: req.headers });
      if (!event) {
        ctx.log.warn('payment webhook rejected: bad signature or body');
        return res.status(400).json({ ok: false });
      }
      try {
        const out = await ctx.monetization.applyProviderEvent(event);
        return res.status(200).json({ ok: true, result: out.result });
      } catch (e) {
        // A 5xx makes the provider send the event again later, which is what we want after a failure on our side.
        ctx.log.error('payment webhook failed', { err: e });
        return res.status(500).json({ ok: false });
      }
    });
  },
};
