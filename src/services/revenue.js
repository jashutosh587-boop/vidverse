import { LEGAL_VERSION } from '../config.js';
import { ValidationError, conflict, notFound } from '../lib/errors.js';
import { allocate } from '../lib/money.js';

const SOURCES = ['membership', 'sponsorship', 'manual', 'adsense'];
const num = (v) => Number(v ?? 0);

/**
 * Shares money the operator has already received (a sponsor, a membership programme) among creators in proportion to
 * the qualified watch time of their videos in a period. Source-agnostic on purpose.
 *
 * AdSense is the exception that needs care: Google's AdSense program policies do not let a publisher pass AdSense
 * earnings on to other people without Google's written permission, which is rarely given. A batch with source
 * "adsense" is therefore refused unless the person posting it states that they hold that permission.
 */
export function createRevenueService(ctx) {
  const { db, config, clock, audit } = ctx;
  const currency = config.payments.currency;

  async function weights(batch) {
    const { rows } = await db.query(
      `SELECT v.owner_id AS user_id, u.handle, sum(d.watch_ms)::bigint AS watch_ms
         FROM video_view_days d JOIN videos v ON v.id = d.video_id JOIN users u ON u.id = v.owner_id
        WHERE d.qualified AND d.day BETWEEN $1::date AND $2::date AND v.status = 'ready'
          AND u.status = 'active' AND u.creator_terms_version = $3
        GROUP BY v.owner_id, u.handle HAVING sum(d.watch_ms) > 0 ORDER BY v.owner_id`,
      [batch.period_start, batch.period_end, LEGAL_VERSION],
    );
    return rows.map((r) => ({ userId: r.user_id, handle: r.handle, watchMs: num(r.watch_ms) }));
  }

  const poolOf = (batch) => Number((BigInt(num(batch.gross_minor)) * BigInt(batch.creator_share_bps)) / 10_000n);

  const api = {
    async createBatch(input, staffId) {
      const errors = {};
      const label = String(input.label ?? '').trim();
      if (label.length < 1 || label.length > 100) errors.label = 'Give the batch a name of up to 100 characters.';
      if (!SOURCES.includes(input.source)) errors.source = 'Choose where the money came from.';
      if (!Number.isSafeInteger(input.grossMinor) || input.grossMinor <= 0) errors.gross = 'Enter the amount received, such as 25000.';
      if (!Number.isInteger(input.creatorShareBps) || input.creatorShareBps < 0 || input.creatorShareBps > 10_000) errors.share = 'The creators’ share is between 0 and 100 percent.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart ?? '')) errors.periodStart = 'Enter a start date.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd ?? '')) errors.periodEnd = 'Enter an end date.';
      if (!errors.periodStart && !errors.periodEnd && input.periodEnd < input.periodStart) errors.periodEnd = 'The end date cannot be before the start date.';
      if (input.source === 'adsense' && input.googlePermissionAttested !== true) {
        errors.source = 'Google’s AdSense program policies do not allow passing AdSense earnings to other people without Google’s written permission. Tick the box below only if you hold that permission.';
      }
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const row = await db.one(
        `INSERT INTO revenue_batches (label, source, gross_minor, creator_share_bps, currency, period_start, period_end, google_permission_attested, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [label, input.source, input.grossMinor, input.creatorShareBps, currency, input.periodStart, input.periodEnd, input.source === 'adsense' && input.googlePermissionAttested === true, staffId],
      );
      await audit.record(staffId, 'revenue.batch_create', { targetType: 'revenue_batch', targetId: row.id, meta: { source: input.source, grossMinor: input.grossMinor } });
      return row.id;
    },

    async get(id) {
      if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
      return db.one('SELECT * FROM revenue_batches WHERE id = $1', [id]);
    },

    async list(limit = 50) {
      return (await db.query('SELECT * FROM revenue_batches ORDER BY created_at DESC LIMIT $1', [limit])).rows;
    },

    /** What posting would do, without doing it. For a posted batch, what was done. */
    async preview(id) {
      const batch = await api.get(id);
      if (!batch) throw notFound();
      if (batch.status === 'posted') {
        const { rows } = await db.query(
          `SELECT a.user_id, u.handle, a.watch_ms, a.amount_minor FROM revenue_allocations a JOIN users u ON u.id = a.user_id WHERE a.batch_id = $1 ORDER BY a.amount_minor DESC, u.handle`,
          [id],
        );
        return { batch, pool: num(batch.pool_minor), rows: rows.map((r) => ({ userId: r.user_id, handle: r.handle, watchMs: num(r.watch_ms), amountMinor: num(r.amount_minor) })), posted: true };
      }
      const pool = poolOf(batch);
      const w = await weights(batch);
      const shares = allocate(pool, w.map((x) => ({ key: x.userId, weight: x.watchMs })));
      const rows = w.map((x) => ({ ...x, amountMinor: shares.get(x.userId) ?? 0 })).filter((x) => x.amountMinor > 0).sort((a, b) => b.amountMinor - a.amountMinor || (a.handle < b.handle ? -1 : 1));
      return { batch, pool, rows, posted: false };
    },

    /** Books the shares into creators' balances. Happens once; the batch is locked by the status change. */
    async post(id, staffId) {
      await db.tx(async () => {
        const batch = await db.one(`UPDATE revenue_batches SET status = 'posted', posted_at = $2 WHERE id = $1 AND status = 'draft' RETURNING *`, [id, clock()]);
        if (!batch) throw conflict('That batch has already been posted, or does not exist.');
        if (batch.source === 'adsense' && !batch.google_permission_attested) throw new ValidationError({ source: 'An AdSense batch needs the permission statement.' });
        const pool = poolOf(batch);
        const w = await weights(batch);
        if (!w.length) throw new ValidationError({ _: 'No creator has qualified watch time in that period, so there is nobody to pay.' });
        const shares = allocate(pool, w.map((x) => ({ key: x.userId, weight: x.watchMs })));
        let allocated = 0;
        for (const x of w) {
          const amount = shares.get(x.userId) ?? 0;
          if (amount <= 0) continue;
          allocated += amount;
          await db.query('INSERT INTO revenue_allocations (batch_id, user_id, watch_ms, amount_minor) VALUES ($1, $2, $3, $4)', [id, x.userId, x.watchMs, amount]);
          await db.query(
            `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id, note) VALUES ($1, $2, 'revenue_share', $3, $4, $5, 'revenue_batch', $6, $7)`,
            [`user:${x.userId}`, x.userId, amount, currency, clock(), id, batch.label.slice(0, 100)],
          );
        }
        await db.query('UPDATE revenue_batches SET pool_minor = $2, allocated_minor = $3 WHERE id = $1', [id, pool, allocated]);
        await audit.record(staffId, 'revenue.batch_post', { targetType: 'revenue_batch', targetId: id, meta: { pool, allocated, creators: w.length, source: batch.source } });
      });
    },
  };
  return api;
}
