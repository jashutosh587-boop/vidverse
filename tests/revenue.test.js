import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, makeAdmin } from './helpers/users.js';

const MIN = 60_000;

describe('sharing revenue by watch time', () => {
  let app;
  let rev;
  let staff;
  const u = {};

  const video = (id, owner, status = 'ready') =>
    app.ctx.db.query(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at) VALUES ($1, $2, $3, $4, 'public', now())`, [id, owner, `Video ${id}`, status]);
  const watch = (videoId, day, viewer, ms, qualified = true) =>
    app.ctx.db.query(`INSERT INTO video_view_days (video_id, day, viewer_hash, watch_ms, qualified, counted, last_beat_at) VALUES ($1, $2, $3, $4, $5, true, now())`, [videoId, day, viewer, ms, qualified]);
  const batch = (over = {}) =>
    rev.createBatch({ label: 'Sponsor deal', source: 'sponsorship', grossMinor: 1_000_000, creatorShareBps: 7000, periodStart: '2026-10-01', periodEnd: '2026-10-31', ...over }, staff.id);
  const shares = async (id) => Object.fromEntries((await rev.preview(id)).rows.map((r) => [r.handle, r.amountMinor]));

  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'test' } });
    rev = app.ctx.revenue;
    staff = await createMember(app, app.client(), { email: 'staff@example.com', handle: 'staffer', name: 'Staff' });
    await makeAdmin(app, staff.id);
    for (const [key, name] of [['a', 'Anya'], ['b', 'Bilal'], ['c', 'Chen']]) {
      const c = app.client();
      u[key] = await createMember(app, c, { email: `${key}@example.com`, handle: `creator${key}`, name });
      await c.post('/studio/terms', { agree: '1' });
    }
    await video('AAAAAAAAAAA', u.a.id);
    await video('BBBBBBBBBBB', u.b.id);
    await video('CCCCCCCCCCC', u.c.id);
    // Watch time in October: Anya 60 minutes, Bilal 30, Chen 10.
    await watch('AAAAAAAAAAA', '2026-10-05', 'v1', 40 * MIN);
    await watch('AAAAAAAAAAA', '2026-10-20', 'v2', 20 * MIN);
    await watch('BBBBBBBBBBB', '2026-10-31', 'v1', 30 * MIN);
    await watch('CCCCCCCCCCC', '2026-10-01', 'v3', 10 * MIN);
  });
  after(() => app.close());

  test('a batch needs a name, a source, an amount, a share between 0 and 100 percent and a sensible period', async () => {
    const bad = [
      [{ label: '' }, 'label'],
      [{ label: 'x'.repeat(101) }, 'label'],
      [{ source: 'lottery' }, 'source'],
      [{ grossMinor: 0 }, 'gross'],
      [{ grossMinor: -5 }, 'gross'],
      [{ grossMinor: 1.5 }, 'gross'],
      [{ creatorShareBps: 10_001 }, 'share'],
      [{ creatorShareBps: -1 }, 'share'],
      [{ periodStart: 'yesterday' }, 'periodStart'],
      [{ periodEnd: '2026-09-30' }, 'periodEnd'],
    ];
    for (const [over, field] of bad) {
      await assert.rejects(() => batch(over), (e) => e.status === 422 && field in e.fieldErrors, JSON.stringify(over));
    }
    assert.equal((await app.ctx.db.one('SELECT count(*)::int AS n FROM revenue_batches')).n, 0);
  });

  test('AdSense money is refused unless the person posting states they hold Google’s written permission', async () => {
    await assert.rejects(() => batch({ source: 'adsense' }), (e) => e.status === 422 && /written permission/.test(e.fieldErrors.source));
    await assert.rejects(() => batch({ source: 'adsense', googlePermissionAttested: false }), (e) => e.status === 422);
    for (const sloppy of ['false', 'no', '0', 1, 'true', {}]) {
      await assert.rejects(() => batch({ source: 'adsense', googlePermissionAttested: sloppy }), (e) => e.status === 422, `only a real true counts, not ${JSON.stringify(sloppy)}`);
    }
    const id = await batch({ source: 'adsense', googlePermissionAttested: true, label: 'AdSense, with permission' });
    const row = await rev.get(id);
    assert.equal(row.google_permission_attested, true);
    const audit = await app.ctx.db.one(`SELECT meta FROM audit_log WHERE action = 'revenue.batch_create' AND target_id = $1`, [id]);
    assert.equal(audit.meta.source, 'adsense');
    // For other sources the statement is irrelevant and is not recorded.
    const other = await batch({ googlePermissionAttested: true });
    assert.equal((await rev.get(other)).google_permission_attested, false);
  });

  test('the preview divides the creators’ pool in proportion to qualified watch time, to the paisa', async () => {
    const id = await batch();
    const p = await rev.preview(id);
    assert.equal(p.pool, 700_000);
    assert.equal(p.posted, false);
    assert.deepEqual(await shares(id), { creatora: 420_000, creatorb: 210_000, creatorc: 70_000 });
    assert.equal(p.rows.reduce((s, r) => s + r.amountMinor, 0), 700_000);
    assert.deepEqual(p.rows.map((r) => r.handle), ['creatora', 'creatorb', 'creatorc'], 'largest share first');
    assert.deepEqual(p.rows.map((r) => r.watchMs), [60 * MIN, 30 * MIN, 10 * MIN]);
    assert.equal((await app.ctx.db.one('SELECT count(*)::int AS n FROM ledger_entries')).n, 0, 'a preview books nothing');
  });

  test('a pool that does not divide evenly still adds up exactly', async () => {
    const id = await batch({ grossMinor: 1_000_003, creatorShareBps: 3333, label: 'Odd numbers' });
    const p = await rev.preview(id);
    assert.equal(p.pool, Math.floor((1_000_003 * 3333) / 10_000));
    assert.equal(p.rows.reduce((s, r) => s + r.amountMinor, 0), p.pool);
  });

  test('what does not count: unqualified views, other days, unfinished or removed videos, suspended and deleted creators, creators without current terms', async () => {
    const d = await createMember(app, app.client(), { email: 'd@example.com', handle: 'creatord', name: 'Dee' });
    await app.ctx.db.query('UPDATE users SET creator_terms_version = $2 WHERE id = $1', [d.id, (await app.ctx.db.one('SELECT creator_terms_version AS v FROM users WHERE id = $1', [u.a.id])).v]);
    await video('DDDDDDDDDDD', d.id);
    await video('DDDDDDDDDD2', d.id, 'removed');
    await video('DDDDDDDDDD3', d.id, 'processing');
    await watch('DDDDDDDDDDD', '2026-10-10', 'x1', 5 * MIN, false); // not qualified
    await watch('DDDDDDDDDDD', '2026-09-30', 'x2', 500 * MIN); // the day before the period
    await watch('DDDDDDDDDDD', '2026-11-01', 'x3', 500 * MIN); // the day after
    await watch('DDDDDDDDDD2', '2026-10-10', 'x4', 500 * MIN); // removed video
    await watch('DDDDDDDDDD3', '2026-10-10', 'x5', 500 * MIN); // still processing
    const id = await batch({ label: 'Exclusions' });
    assert.ok(!('creatord' in (await shares(id))), 'none of that counts');

    await watch('DDDDDDDDDDD', '2026-10-10', 'x6', 5 * MIN); // one counted view
    assert.ok('creatord' in (await shares(id)));
    await app.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [d.id]);
    assert.ok(!('creatord' in (await shares(id))), 'suspended');
    await app.ctx.db.query(`UPDATE users SET status = 'active', creator_terms_version = NULL WHERE id = $1`, [d.id]);
    assert.ok(!('creatord' in (await shares(id))), 'terms not accepted');
    await app.ctx.db.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [d.id]);
    assert.ok(!('creatord' in (await shares(id))), 'deleted');
    await app.ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [d.id]);
    await app.ctx.db.query('DELETE FROM video_view_days WHERE video_id LIKE $1', ['DDDDDDDDDD%']);
  });

  test('posting books each share into the creator’s balance, once, and balances show it', async () => {
    const id = await batch({ label: 'October sponsor' });
    await rev.post(id, staff.id);
    const row = await rev.get(id);
    assert.equal(row.status, 'posted');
    assert.equal(Number(row.pool_minor), 700_000);
    assert.equal(Number(row.allocated_minor), 700_000);
    assert.ok(row.posted_at);
    const entries = (await app.ctx.db.query(`SELECT user_id, amount_minor, available_at, note FROM ledger_entries WHERE kind = 'revenue_share' AND ref_id = $1`, [id])).rows;
    assert.equal(entries.length, 3);
    assert.equal(entries.reduce((s, e) => s + Number(e.amount_minor), 0), 700_000);
    assert.ok(entries.every((e) => e.note === 'October sponsor'));
    const a = await app.ctx.monetization.balances(u.a.id);
    assert.equal(a.available, 420_000, 'revenue shares are available at once; there is no tip-style hold');
    assert.equal((await app.ctx.db.query('SELECT 1 FROM revenue_allocations WHERE batch_id = $1', [id])).rows.length, 3);
    const posted = await rev.preview(id);
    assert.equal(posted.posted, true);
    assert.equal(posted.rows.find((r) => r.handle === 'creatora').amountMinor, 420_000);

    await assert.rejects(() => rev.post(id, staff.id), (e) => e.status === 409);
    assert.equal((await app.ctx.db.query(`SELECT 1 FROM ledger_entries WHERE kind = 'revenue_share' AND ref_id = $1`, [id])).rows.length, 3, 'a second post adds nothing');
    const log = await app.ctx.db.one(`SELECT meta FROM audit_log WHERE action = 'revenue.batch_post' AND target_id = $1`, [id]);
    assert.deepEqual({ pool: log.meta.pool, creators: log.meta.creators }, { pool: 700_000, creators: 3 });
  });

  test('posting two at once books it once', async () => {
    const id = await batch({ label: 'Race' });
    const out = await Promise.allSettled([rev.post(id, staff.id), rev.post(id, staff.id)]);
    assert.equal(out.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await app.ctx.db.query(`SELECT 1 FROM ledger_entries WHERE kind = 'revenue_share' AND ref_id = $1`, [id])).rows.length, 3);
  });

  test('a batch with nobody to pay stays a draft instead of silently disappearing', async () => {
    const id = await batch({ label: 'Empty month', periodStart: '2025-01-01', periodEnd: '2025-01-31' });
    await assert.rejects(() => rev.post(id, staff.id), (e) => e.status === 422 && /nobody to pay/.test(e.fieldErrors._));
    assert.equal((await rev.get(id)).status, 'draft', 'the status change was rolled back with everything else');
    assert.equal((await rev.preview(id)).rows.length, 0);
  });

  test('a failure while booking leaves nothing half-done', async () => {
    const id = await batch({ label: 'Will fail' });
    const before = (await app.ctx.db.one('SELECT count(*)::int AS n FROM ledger_entries')).n;
    // Make the third creator's ledger line collide with an existing one, so the batch fails part-way through.
    await app.ctx.db.query(
      `INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'revenue_share', 1, 'INR', now(), 'revenue_batch', $3)`,
      [`user:${u.c.id}`, u.c.id, id],
    );
    await assert.rejects(() => rev.post(id, staff.id));
    assert.equal((await rev.get(id)).status, 'draft');
    assert.equal((await app.ctx.db.query(`SELECT 1 FROM revenue_allocations WHERE batch_id = $1`, [id])).rows.length, 0);
    assert.equal((await app.ctx.db.one('SELECT count(*)::int AS n FROM ledger_entries')).n, before + 1, 'only the line we planted exists');
  });

  test('an unknown batch is not found', async () => {
    assert.equal(await rev.get('not-a-uuid'), null);
    assert.equal(await rev.get('00000000-0000-4000-8000-000000000000'), null);
    await assert.rejects(() => rev.preview('00000000-0000-4000-8000-000000000000'), (e) => e.status === 404);
  });
});
