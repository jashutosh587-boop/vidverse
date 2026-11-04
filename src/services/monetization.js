import { LEGAL_VERSION } from '../config.js';
import { decryptString, encryptString } from '../lib/crypto.js';
import { HttpError, ValidationError, conflict, notFound } from '../lib/errors.js';
import { formatMoney } from '../lib/format.js';
import { splitTip } from '../lib/money.js';
import { parsePayoutDetails } from '../lib/payout-details.js';
import * as emails from './emails.js';

const DAY = 86_400_000;
/** After payout details change, payout requests wait this long. A thief with a stolen session cannot cash out at once. */
export const DETAILS_COOLOFF_MS = 24 * 3_600_000;
const OPEN_TIPS_PER_PAYER = 5;
const num = (v) => Number(v ?? 0);

/**
 * Tips, balances and payouts.
 *
 * The ledger is the only record of what a creator is owed: every balance is a sum of ledger entries, entries are
 * never changed or deleted (the database refuses), and each payment or payout can be booked only once. Money only
 * arrives through `applyProviderEvent`, which is called from the signed webhook (or from the test provider).
 */
export function createMonetizationService(ctx) {
  const { db, config, clock, log, audit } = ctx;
  const pay = config.payments;
  const provider = ctx.paymentProvider;

  const sendInBackground = (to, message) => {
    ctx.mailer.send({ to, ...message }).catch((e) => log.error('email failed', { err: e }));
  };
  const money = (minor) => formatMoney(minor, pay.currency);

  const api = {
    providerName: provider.name,
    currency: pay.currency,
    limits: { min: pay.tipMinMinor, max: pay.tipMaxMinor, feeBps: pay.feeBps, holdDays: pay.holdDays, payoutMin: pay.payoutMinMinor },

    // ------------------------------------------------------------------ tips

    /** True when a viewer can tip this channel: payments are on, the channel is active and its owner accepted the creator terms. */
    async tipsAvailable(channelId) {
      const row = await db.one(`SELECT 1 AS ok FROM users WHERE id = $1 AND status = 'active' AND creator_terms_version = $2`, [channelId, LEGAL_VERSION]);
      return Boolean(row);
    },

    /** Starts a tip. Returns where to send the payer to pay. Nothing is credited until the provider confirms. */
    async createTip({ payer, channelId, videoId = null, amountMinor, message = '', anonymous = false }) {
      if (!payer.email_verified_at) throw new HttpError(403, 'Confirm your email address before sending a tip.', { code: 'unverified' });
      if (payer.id === channelId) throw new ValidationError({ amount: 'You cannot tip your own channel.' });
      if (!(await api.tipsAvailable(channelId))) throw notFound('This channel cannot receive tips right now.');
      if (!Number.isSafeInteger(amountMinor) || amountMinor < pay.tipMinMinor || amountMinor > pay.tipMaxMinor) {
        throw new ValidationError({ amount: `Choose an amount between ${money(pay.tipMinMinor)} and ${money(pay.tipMaxMinor)}.` });
      }
      let video = null;
      if (videoId) {
        video = await db.one(`SELECT id FROM videos WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND visibility = 'public'`, [videoId, channelId]);
      }
      const recent = await db.one(`SELECT count(*)::int AS n FROM payments WHERE payer_id = $1 AND status = 'created' AND created_at > $2`, [payer.id, new Date(clock().getTime() - DAY)]);
      if (recent.n >= OPEN_TIPS_PER_PAYER) throw new HttpError(429, 'You have several tips waiting for payment. Finish or wait for them to expire before starting another.');

      const { fee, net } = splitTip(amountMinor, pay.feeBps);
      const created = await db.one(
        `INSERT INTO payments (payer_id, channel_id, video_id, amount_minor, currency, fee_minor, net_minor, provider, message, anonymous, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [payer.id, channelId, video?.id ?? null, amountMinor, pay.currency, fee, net, provider.name, message || null, Boolean(anonymous), clock()],
      );
      const channel = await db.one('SELECT handle FROM users WHERE id = $1', [channelId]);
      try {
        const checkout = await provider.createCheckout({
          paymentId: created.id,
          amountMinor,
          currency: pay.currency,
          description: `Tip for @${channel.handle} on ${config.siteName}`,
          callbackUrl: `${config.baseUrl}/support/thanks/${created.id}`,
          expiresAt: new Date(clock().getTime() + DAY),
        });
        await db.query('UPDATE payments SET provider_ref = $2, checkout_url = $3 WHERE id = $1', [created.id, checkout.providerRef, checkout.checkoutUrl]);
        return { paymentId: created.id, checkoutUrl: checkout.checkoutUrl };
      } catch (e) {
        await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'created'`, [created.id]);
        log.error('could not create a checkout', { provider: provider.name, status: e?.status, err: e?.message });
        throw new HttpError(502, 'We could not reach the payment provider. You have not been charged. Try again in a few minutes.');
      }
    },

    /** A tip as its payer may see it. Others get null. */
    async tipForPayer(paymentId, payerId) {
      if (!/^[0-9a-f-]{36}$/.test(paymentId)) return null;
      return db.one(
        `SELECT p.id, p.status, p.amount_minor, p.currency, p.anonymous, p.created_at, p.paid_at, p.checkout_url, u.handle AS channel_handle, u.display_name AS channel_name
           FROM payments p JOIN users u ON u.id = p.channel_id WHERE p.id = $1 AND p.payer_id = $2`,
        [paymentId, payerId],
      );
    },

    /**
     * Applies one confirmed event from the provider, once. `eventId` is the provider's own id for the event:
     * the same event arriving again (they retry) changes nothing. Dedupe and effect share one transaction, so a
     * crash in the middle undoes both and the retry starts clean.
     */
    async applyProviderEvent(event) {
      return db.tx(async () => {
        const fresh = await db.one(
          `INSERT INTO webhook_events (provider, event_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id`,
          [provider.name, event.id, String(event.rawType ?? event.type).slice(0, 60)],
        );
        if (!fresh) return { result: 'duplicate' };
        switch (event.type) {
          case 'paid':
            return creditPayment(event);
          case 'expired':
          case 'cancelled':
            await db.query(`UPDATE payments SET status = $2 WHERE provider_ref = $1 AND status = 'created'`, [event.providerRef, event.type === 'expired' ? 'expired' : 'failed']);
            return { result: event.type };
          default:
            return { result: 'ignored' };
        }
      });
    },

    // ------------------------------------------------------------------ balances

    async balances(userId) {
      const row = await db.one(
        `SELECT COALESCE(sum(amount_minor) FILTER (WHERE available_at <= $2), 0) AS available,
                COALESCE(sum(amount_minor) FILTER (WHERE available_at > $2), 0) AS pending
           FROM ledger_entries WHERE user_id = $1`,
        [userId, clock()],
      );
      const available = num(row.available);
      const pending = num(row.pending);
      return { available, pending, total: available + pending, currency: pay.currency };
    },

    /** Lifetime and recent totals for the Earnings page. */
    async earnings(userId) {
      const since = new Date(clock().getTime() - 28 * DAY);
      const [life, recent, paidOut] = await Promise.all([
        db.one(`SELECT count(*)::int AS tips, COALESCE(sum(amount_minor), 0) AS gross, COALESCE(sum(fee_minor), 0) AS fees, COALESCE(sum(net_minor), 0) AS net FROM payments WHERE channel_id = $1 AND status = 'paid'`, [userId]),
        db.one(`SELECT count(*)::int AS tips, COALESCE(sum(net_minor), 0) AS net FROM payments WHERE channel_id = $1 AND status = 'paid' AND paid_at >= $2`, [userId, since]),
        db.one(`SELECT COALESCE(sum(amount_minor), 0) AS total FROM payouts WHERE user_id = $1 AND status = 'paid'`, [userId]),
      ]);
      return {
        lifetime: { tips: life.tips, gross: num(life.gross), fees: num(life.fees), net: num(life.net) },
        last28: { tips: recent.tips, net: num(recent.net) },
        paidOut: num(paidOut.total),
        currency: pay.currency,
      };
    },

    async recentTips(userId, { limit = 20, offset = 0 } = {}) {
      const { rows } = await db.query(
        `SELECT p.id, p.status, p.amount_minor, p.fee_minor, p.net_minor, p.currency, p.message, p.paid_at, p.video_id,
                CASE WHEN p.anonymous THEN NULL ELSE u.display_name END AS from_name,
                CASE WHEN p.anonymous THEN NULL ELSE u.handle END AS from_handle, v.title AS video_title
           FROM payments p LEFT JOIN users u ON u.id = p.payer_id LEFT JOIN videos v ON v.id = p.video_id
          WHERE p.channel_id = $1 AND p.status IN ('paid', 'refunded') ORDER BY p.paid_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    async ledger(userId, { limit = 30, offset = 0 } = {}) {
      const { rows } = await db.query(
        `SELECT id, kind, amount_minor, currency, available_at, ref_type, ref_id, note, created_at FROM ledger_entries WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    // ------------------------------------------------------------------ payout details and payouts

    async payoutProfile(userId) {
      return db.one('SELECT method, display_hint, updated_at FROM payout_profiles WHERE user_id = $1', [userId]);
    },

    /** Saves where to pay. Throws ValidationError with field messages when the details do not look right. */
    async savePayoutProfile(userId, input) {
      const parsed = parsePayoutDetails(input);
      if (!parsed.ok) throw new ValidationError(parsed.errors);
      const enc = encryptString(config.encryptionKeys, JSON.stringify(parsed.details), `payout:${userId}`);
      await db.query(
        `INSERT INTO payout_profiles (user_id, method, details_enc, display_hint, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET method = $2, details_enc = $3, display_hint = $4, updated_at = $5`,
        [userId, parsed.method, enc, parsed.hint, clock()],
      );
      await audit.record(userId, 'payout.details_changed', { targetType: 'user', targetId: userId, meta: { method: parsed.method } });
      const user = await db.one('SELECT email FROM users WHERE id = $1', [userId]);
      if (user) sendInBackground(user.email, emails.payoutDetailsChangedEmail({ siteName: config.siteName, baseUrl: config.baseUrl, hint: parsed.hint }));
      return { hint: parsed.hint };
    },

    async requestPayout(userId, amountMinor) {
      const user = await db.one(`SELECT status, creator_terms_version FROM users WHERE id = $1`, [userId]);
      if (!user || user.status !== 'active') throw new HttpError(403, 'This account cannot request payouts.');
      if (user.creator_terms_version !== LEGAL_VERSION) throw new HttpError(403, 'Accept the creator terms first.');
      const profile = await db.one('SELECT method, details_enc, display_hint, updated_at FROM payout_profiles WHERE user_id = $1', [userId]);
      if (!profile) throw new HttpError(409, 'Add your payout details first.');
      const wait = new Date(profile.updated_at).getTime() + DETAILS_COOLOFF_MS - clock().getTime();
      if (wait > 0) throw new HttpError(409, `You changed your payout details recently. For your safety, payouts wait ${Math.ceil(wait / 3_600_000)} more ${Math.ceil(wait / 3_600_000) === 1 ? 'hour' : 'hours'}.`);
      if (!Number.isSafeInteger(amountMinor) || amountMinor < pay.payoutMinMinor) throw new ValidationError({ amount: `The minimum payout is ${money(pay.payoutMinMinor)}.` });

      const id = await db.tx(async () => {
        await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]); // one request at a time per person
        if (await db.one(`SELECT 1 AS x FROM payouts WHERE user_id = $1 AND status IN ('requested', 'approved')`, [userId])) {
          throw conflict('You already have a payout request open. Wait for it to be paid, or cancel it.');
        }
        const bal = await api.balances(userId);
        if (amountMinor > bal.available) throw new ValidationError({ amount: `You can withdraw up to ${money(Math.max(0, bal.available))} right now.` });
        let payout;
        try {
          payout = await db.one(
            `INSERT INTO payouts (user_id, amount_minor, currency, method, details_enc, display_hint, requested_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [userId, amountMinor, pay.currency, profile.method, profile.details_enc, profile.display_hint, clock()],
          );
        } catch (e) {
          // The database allows one open request per person; this is its backstop if two requests ever slip past the lock.
          if (e?.code === '23505') throw conflict('You already have a payout request open. Wait for it to be paid, or cancel it.');
          throw e;
        }
        await db.query(
          `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'payout_request', $3, $4, $5, 'payout', $6)`,
          [`user:${userId}`, userId, -amountMinor, pay.currency, clock(), payout.id],
        );
        return payout.id;
      });
      await audit.record(userId, 'payout.request', { targetType: 'payout', targetId: id, meta: { amountMinor } });
      return id;
    },

    async cancelPayout(userId, payoutId) {
      if (!/^[0-9a-f-]{36}$/.test(payoutId)) throw notFound();
      await db.tx(async () => {
        const p = await db.one(`UPDATE payouts SET status = 'cancelled', decided_at = $3 WHERE id = $1 AND user_id = $2 AND status = 'requested' RETURNING amount_minor, currency`, [payoutId, userId, clock()]);
        if (!p) throw conflict('That request can no longer be cancelled.');
        await returnToBalance(userId, payoutId, p);
      });
      await audit.record(userId, 'payout.cancel', { targetType: 'payout', targetId: payoutId });
    },

    async listPayouts(userId) {
      const { rows } = await db.query(
        `SELECT id, amount_minor, currency, status, display_hint, requested_at, decided_at, paid_at, paid_reference, note FROM payouts WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 50`,
        [userId],
      );
      return rows;
    },

    // ------------------------------------------------------------------ staff: payouts and refunds

    async adminListPayouts({ status = 'open', limit = 50, offset = 0 } = {}) {
      const filter = status === 'open' ? `p.status IN ('requested', 'approved')` : status === 'all' ? 'TRUE' : `p.status = '${['paid', 'rejected', 'cancelled'].includes(status) ? status : 'paid'}'`;
      const { rows } = await db.query(
        `SELECT p.id, p.user_id, p.amount_minor, p.currency, p.status, p.method, p.display_hint, p.requested_at, p.decided_at, p.paid_at, p.paid_reference, p.note,
                u.handle, u.display_name, u.email
           FROM payouts p JOIN users u ON u.id = p.user_id WHERE ${filter} ORDER BY p.requested_at ASC LIMIT $1 OFFSET $2`,
        [limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    async approvePayout(payoutId, staffId) {
      const p = await db.one(`UPDATE payouts SET status = 'approved', decided_by = $2, decided_at = $3 WHERE id = $1 AND status = 'requested' AND user_id <> $2 RETURNING user_id, amount_minor`, [payoutId, staffId, clock()]);
      if (!p) throw conflict('That payout cannot be approved. It may have been handled already, or it is your own.');
      await audit.record(staffId, 'payout.approve', { targetType: 'payout', targetId: payoutId });
    },

    /** Shows where to send the money. Every look is written to the audit log. */
    async revealPayoutDetails(payoutId, staffId) {
      const p = await db.one(`SELECT user_id, details_enc, method FROM payouts WHERE id = $1 AND status IN ('requested', 'approved')`, [payoutId]);
      if (!p || p.user_id === staffId) throw notFound();
      await audit.record(staffId, 'payout.reveal_details', { targetType: 'payout', targetId: payoutId });
      return { method: p.method, ...JSON.parse(decryptString(config.encryptionKeys, p.details_enc, `payout:${p.user_id}`)) };
    },

    async markPayoutPaid(payoutId, staffId, reference) {
      const ref = String(reference ?? '').trim().slice(0, 100);
      if (!ref) throw new ValidationError({ reference: 'Enter the payment reference (for example the UPI transaction id).' });
      const p = await db.one(
        `UPDATE payouts SET status = 'paid', paid_reference = $3, paid_at = $4, decided_by = $2, decided_at = $4 WHERE id = $1 AND status IN ('requested', 'approved') AND user_id <> $2 RETURNING user_id, amount_minor`,
        [payoutId, staffId, ref, clock()],
      );
      if (!p) throw conflict('That payout cannot be marked as paid. It may have been handled already, or it is your own.');
      await audit.record(staffId, 'payout.paid', { targetType: 'payout', targetId: payoutId, meta: { reference: ref } });
      await ctx.notifications.create(p.user_id, 'payout', { amountMinor: num(p.amount_minor), status: 'paid' });
    },

    async rejectPayout(payoutId, staffId, reason) {
      const note = String(reason ?? '').trim().slice(0, 300);
      if (!note) throw new ValidationError({ reason: 'Say why, so the creator knows what to fix.' });
      await db.tx(async () => {
        const p = await db.one(
          `UPDATE payouts SET status = 'rejected', decided_by = $2, decided_at = $3, note = $4 WHERE id = $1 AND status IN ('requested', 'approved') AND user_id <> $2 RETURNING user_id, amount_minor, currency`,
          [payoutId, staffId, clock(), note],
        );
        if (!p) throw conflict('That payout cannot be declined. It may have been handled already, or it is your own.');
        await returnToBalance(p.user_id, payoutId, p);
        await ctx.notifications.create(p.user_id, 'payout', { amountMinor: num(p.amount_minor), status: 'declined', note });
      });
      await audit.record(staffId, 'payout.reject', { targetType: 'payout', targetId: payoutId, meta: { note } });
    },

    /**
     * Takes a refunded tip back out of the creator's balance. The money itself goes back to the payer through the
     * provider's dashboard: this only keeps our books true. Can be done once per payment.
     */
    async refundPayment(paymentId, staffId, reason) {
      const note = String(reason ?? '').trim().slice(0, 300);
      if (!note) throw new ValidationError({ reason: 'Say why the tip is being refunded.' });
      await db.tx(async () => {
        const p = await db.one(`UPDATE payments SET status = 'refunded' WHERE id = $1 AND status = 'paid' RETURNING channel_id, net_minor, fee_minor, currency`, [paymentId]);
        if (!p) throw conflict('Only a paid tip can be refunded, and only once.');
        const now = clock();
        // The refund carries the same availability date as the tip it undoes, so the two always sit in the same
        // bucket (pending or available) and cancel out there instead of showing a negative "available" balance.
        const original = await db.one(`SELECT available_at FROM ledger_entries WHERE account = $1 AND kind = 'tip_net' AND ref_type = 'payment' AND ref_id = $2`, [`user:${p.channel_id}`, paymentId]);
        await db.query(
          `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id, note) VALUES ($1, $2, 'refund', $3, $4, $5, 'payment', $6, $7)`,
          [`user:${p.channel_id}`, p.channel_id, -num(p.net_minor), p.currency, original?.available_at ?? now, paymentId, note],
        );
        if (num(p.fee_minor) > 0) {
          await db.query(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id, note) VALUES ('platform', NULL, 'refund', $1, $2, $3, 'payment', $4, $5)`, [-num(p.fee_minor), p.currency, now, paymentId, note]);
        }
      });
      await audit.record(staffId, 'payment.refund', { targetType: 'payment', targetId: paymentId, meta: { note } });
    },

    async adminListPayments({ status = 'all', limit = 50, offset = 0 } = {}) {
      const ok = ['created', 'paid', 'failed', 'expired', 'refunded'];
      const { rows } = await db.query(
        `SELECT p.id, p.amount_minor, p.fee_minor, p.net_minor, p.currency, p.status, p.provider, p.created_at, p.paid_at, c.handle AS channel_handle, u.handle AS payer_handle
           FROM payments p JOIN users c ON c.id = p.channel_id LEFT JOIN users u ON u.id = p.payer_id
          WHERE ($1::text = 'all' OR p.status = $1) ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
        [ok.includes(status) ? status : 'all', limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    /** What the platform holds for creators, and what it has earned. For the admin dashboard and the economics check. */
    async platformSummary() {
      const row = await db.one(
        `SELECT COALESCE(sum(amount_minor) FILTER (WHERE user_id IS NOT NULL), 0) AS owed,
                COALESCE(sum(amount_minor) FILTER (WHERE user_id IS NULL), 0) AS platform
           FROM ledger_entries`,
      );
      const orphan = await db.one(
        `SELECT COALESCE(sum(l.amount_minor), 0) AS held FROM ledger_entries l JOIN users u ON u.id = l.user_id WHERE u.status <> 'active'`,
      );
      return { owedToCreators: num(row.owed), platformEarned: num(row.platform), heldForInactiveAccounts: num(orphan.held), currency: pay.currency };
    },

    /** Tips that never got paid are marked expired, so the payer can start over. */
    async expireStale() {
      const r = await db.query(`UPDATE payments SET status = 'expired' WHERE status = 'created' AND created_at < $1`, [new Date(clock().getTime() - 3 * DAY)]);
      return r.rowCount;
    },
  };

  // ---- internals

  async function creditPayment(event) {
    const p = await db.one('SELECT * FROM payments WHERE provider_ref = $1 FOR UPDATE', [event.providerRef]);
    if (!p) {
      log.warn('payment event for an unknown payment', { provider: provider.name });
      return { result: 'unknown' };
    }
    if (p.status === 'paid' || p.status === 'refunded') return { result: 'already_paid' };
    if (event.amountMinor !== num(p.amount_minor) || event.currency !== p.currency) {
      await audit.record(null, 'payment.amount_mismatch', { targetType: 'payment', targetId: p.id, meta: { expected: num(p.amount_minor), got: event.amountMinor, currency: event.currency } });
      return { result: 'mismatch' };
    }
    const paidAt = event.paidAt instanceof Date && !Number.isNaN(event.paidAt.getTime()) ? event.paidAt : clock();
    await db.query(`UPDATE payments SET status = 'paid', paid_at = $2, provider_payment_id = $3 WHERE id = $1`, [p.id, paidAt, event.providerPaymentId ?? null]);
    const availableAt = new Date(paidAt.getTime() + pay.holdDays * DAY);
    await db.query(
      `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'tip_net', $3, $4, $5, 'payment', $6)`,
      [`user:${p.channel_id}`, p.channel_id, num(p.net_minor), p.currency, availableAt, p.id],
    );
    if (num(p.fee_minor) > 0) {
      await db.query(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ('platform', NULL, 'tip_fee', $1, $2, $3, 'payment', $4)`, [num(p.fee_minor), p.currency, paidAt, p.id]);
    }
    let from = 'Someone';
    if (!p.anonymous && p.payer_id) from = (await db.one('SELECT display_name FROM users WHERE id = $1', [p.payer_id]))?.display_name ?? 'Someone';
    await ctx.notifications.create(p.channel_id, 'tip', { from, amountMinor: num(p.amount_minor) });
    return { result: 'credited', paymentId: p.id };
  }

  async function returnToBalance(userId, payoutId, payout) {
    await db.query(
      `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'payout_reversal', $3, $4, $5, 'payout', $6)`,
      [`user:${userId}`, userId, num(payout.amount_minor), payout.currency, clock(), payoutId],
    );
  }

  return api;
}
