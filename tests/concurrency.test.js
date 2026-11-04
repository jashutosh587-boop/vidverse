import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, REAL_POSTGRES } from './helpers/app.js';
import { createMember, makeAdmin } from './helpers/users.js';

/*
 * Races that only exist when several database connections really work at the same instant.
 *
 * The embedded test database has one connection, so it runs everything one statement after another and can never
 * show a race. A real Postgres server does. These tests therefore run only when TEST_DATABASE_URL points at one
 * (see docs/TESTING.md); otherwise they are reported as skipped, not as passed.
 *
 * Every test fires a burst of identical calls with Promise.all and then checks the books, not the replies:
 * what was written, how many times, and whether the totals still add up.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BURST = 8;
const skip = REAL_POSTGRES ? false : 'needs a real Postgres server: set TEST_DATABASE_URL (see docs/TESTING.md)';

describe('money, counts and sign-ups under real concurrency', { skip }, () => {
  let app;
  let mon;
  let analytics;
  let owner;
  let fan;
  let boss;
  let second;
  let seq = 0;

  const q = (sql, params) => app.ctx.db.query(sql, params);
  const one = (sql, params) => app.ctx.db.one(sql, params);

  async function addVideo(id, duration = 20_000) {
    await q(
      `INSERT INTO videos (id, owner_id, title, description, tags, status, visibility, duration_ms, comments_enabled, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, '', '{}'::text[], 'ready', 'public', $4, true, $5, $5, $5)`,
      [id, owner.id, `Video ${id}`, duration, app.clock.now()],
    );
    return one('SELECT * FROM videos WHERE id = $1', [id]);
  }

  /** A creator with Rs 900 available and payout details old enough to be used. */
  async function fundedCreator(tag) {
    const c = app.client();
    const m = await createMember(app, c, { email: `${tag}@example.com`, handle: tag, name: `Creator ${tag}` });
    await c.post('/studio/terms', { agree: '1' });
    const payer = await one('SELECT * FROM users WHERE id = $1', [fan.id]);
    const { paymentId } = await mon.createTip({ payer, channelId: m.id, amountMinor: 100_000 });
    await mon.applyProviderEvent({ id: `fund-${tag}`, rawType: 'test.paid', type: 'paid', providerRef: `test_${paymentId}`, amountMinor: 100_000, currency: 'INR', paidAt: null });
    app.clock.advance(8 * DAY);
    await mon.savePayoutProfile(m.id, { method: 'upi', upi: `${tag}@okbank` });
    app.clock.advance(25 * HOUR);
    assert.equal((await mon.balances(m.id)).available, 90_000, 'set-up: Rs 900 is available');
    return m;
  }

  const settled = (results) => ({
    ok: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    failed: results.filter((r) => r.status === 'rejected').map((r) => r.reason),
  });

  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'test' } });
    mon = app.ctx.monetization;
    analytics = app.ctx.analytics;
    owner = await createMember(app, app.client(), { email: 'owner@example.com', handle: 'owner' });
    fan = await createMember(app, app.client(), { email: 'fan@example.com', handle: 'fanny' });
    boss = await createMember(app, app.client(), { email: 'boss@example.com', handle: 'bossperson' });
    second = await createMember(app, app.client(), { email: 'second@example.com', handle: 'secondadmin' });
    await makeAdmin(app, boss.id);
    await makeAdmin(app, second.id);
  });
  after(() => app?.close());

  test('this really is a Postgres server with separate connections', async () => {
    assert.equal(app.engine, 'postgres');
    const { rows } = await q('SELECT pg_backend_pid() AS pid FROM generate_series(1, 1)');
    const pids = new Set((await Promise.all(Array.from({ length: 6 }, () => q('SELECT pg_sleep(0.05), pg_backend_pid() AS pid')))).map((r) => r.rows[0].pid));
    assert.ok(rows.length === 1 && pids.size > 1, `six overlapping queries used ${pids.size} connection(s)`);
  });

  describe('views and watch time', () => {
    test('a burst of first reports from one anonymous viewer is one viewing, not many', async () => {
      const video = await addVideo('RACEVIEW001');
      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () => analytics.recordHeartbeat({ video, userId: null, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test', positionMs: 12_000, deltaMs: 12_000 })),
      );
      assert.deepEqual(settled(results).failed, [], 'no report fails');
      const v = await one('SELECT views, watch_ms, retention_n FROM videos WHERE id = $1', [video.id]);
      const days = (await q('SELECT watch_ms, qualified FROM video_view_days WHERE video_id = $1', [video.id])).rows;
      assert.equal(days.length, 1, 'one viewer, one row');
      assert.equal(days[0].watch_ms, 12_000);
      assert.equal(v.watch_ms, 12_000, `the video was credited ${v.watch_ms} ms, the viewer's own row says 12000`);
      assert.equal(v.views, 1);
      assert.equal(v.retention_n, 1);
    });

    test('the same burst from a signed-in viewer does not inflate their history, their daily total or the video', async () => {
      const video = await addVideo('RACEVIEW002');
      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () => analytics.recordHeartbeat({ video, userId: fan.id, ip: '203.0.113.8', userAgent: 'Mozilla/5.0 test', positionMs: 12_000, deltaMs: 12_000 })),
      );
      assert.deepEqual(settled(results).failed, []);
      const v = await one('SELECT views, watch_ms FROM videos WHERE id = $1', [video.id]);
      const h = await one('SELECT watched_ms FROM watch_history WHERE user_id = $1 AND video_id = $2', [fan.id, video.id]);
      const d = await one('SELECT watch_ms FROM user_watch_days WHERE user_id = $1', [fan.id]);
      assert.equal(v.watch_ms, 12_000);
      assert.equal(v.views, 1);
      assert.equal(h.watched_ms, 12_000);
      assert.equal(d.watch_ms, 12_000);
    });

    test('many viewers at once are all counted: the guard is per viewer, not a global lock that drops people', async () => {
      const video = await addVideo('RACEVIEW003');
      const results = await Promise.allSettled(
        Array.from({ length: BURST }, (_, i) => analytics.recordHeartbeat({ video, userId: null, ip: `198.51.100.${i + 1}`, userAgent: 'Mozilla/5.0 test', positionMs: 12_000, deltaMs: 12_000 })),
      );
      assert.deepEqual(settled(results).failed, []);
      const v = await one('SELECT views, watch_ms FROM videos WHERE id = $1', [video.id]);
      assert.equal(v.views, BURST);
      assert.equal(v.watch_ms, BURST * 12_000);
    });
  });

  describe('payouts', () => {
    test('a burst of payout requests creates one request and takes the money once', async () => {
      const m = await fundedCreator(`payer${++seq}`);
      const results = await Promise.allSettled(Array.from({ length: BURST }, () => mon.requestPayout(m.id, 90_000)));
      const { ok } = settled(results);
      // The books first: whatever the losing requests are told, the money must leave the balance exactly once.
      const rows = (await q('SELECT status, amount_minor FROM payouts WHERE user_id = $1', [m.id])).rows;
      assert.equal(rows.length, 1, 'one request exists');
      const taken = await q(`SELECT amount_minor FROM ledger_entries WHERE user_id = $1 AND kind = 'payout_request'`, [m.id]);
      assert.deepEqual(taken.rows.map((r) => Number(r.amount_minor)), [-90_000]);
      const bal = await mon.balances(m.id);
      assert.equal(bal.available, 0, 'the balance is exactly empty, never negative');
      assert.equal(bal.total, 0);
      assert.equal(ok.length, 1, 'exactly one request is accepted');
    });

    test('the requests that lose a burst are told a request is already open, not something confusing', async () => {
      const m = await fundedCreator(`payer${++seq}`);
      const { ok, failed } = settled(await Promise.allSettled(Array.from({ length: BURST }, () => mon.requestPayout(m.id, 90_000))));
      assert.equal(ok.length, 1);
      assert.ok(failed.every((e) => e.status === 409 && /already have a payout request open/.test(e.message)), `got: ${failed.map((e) => `${e.status} ${e.message}`).join(' | ')}`);
    });

    test('staff paying and declining the same request at the same moment: one wins, and the books agree with the winner', async () => {
      const m = await fundedCreator(`payer${++seq}`);
      const id = await mon.requestPayout(m.id, 90_000);
      const calls = [];
      for (let i = 0; i < 4; i++) {
        calls.push(mon.markPayoutPaid(id, i % 2 ? boss.id : second.id, `UTR${i}`));
        calls.push(mon.rejectPayout(id, i % 2 ? second.id : boss.id, `reason ${i}`));
      }
      const { ok } = settled(await Promise.allSettled(calls));
      assert.equal(ok.length, 1, 'exactly one decision is recorded');
      const p = await one('SELECT status FROM payouts WHERE id = $1', [id]);
      const reversals = (await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE ref_id = $1 AND kind = 'payout_reversal'`, [id])).rows[0].n;
      const bal = await mon.balances(m.id);
      if (p.status === 'paid') {
        assert.equal(reversals, 0, 'paid out, so the money is not also returned to the balance');
        assert.equal(bal.available, 0);
      } else {
        assert.equal(p.status, 'rejected');
        assert.equal(reversals, 1, 'declined, so it is returned exactly once');
        assert.equal(bal.available, 90_000);
      }
    });

    test('cancelling the same request many times at once returns the money once', async () => {
      const m = await fundedCreator(`payer${++seq}`);
      const id = await mon.requestPayout(m.id, 90_000);
      const { ok } = settled(await Promise.allSettled(Array.from({ length: BURST }, () => mon.cancelPayout(m.id, id))));
      assert.equal(ok.length, 1);
      const reversals = (await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE ref_id = $1 AND kind = 'payout_reversal'`, [id])).rows[0].n;
      assert.equal(reversals, 1);
      assert.equal((await mon.balances(m.id)).available, 90_000);
    });
  });

  describe('payment notifications', () => {
    async function newTip(tag, amount = 50_000) {
      const c = app.client();
      const m = await createMember(app, c, { email: `${tag}@example.com`, handle: tag });
      await c.post('/studio/terms', { agree: '1' });
      const payer = await one('SELECT * FROM users WHERE id = $1', [fan.id]);
      const { paymentId } = await mon.createTip({ payer, channelId: m.id, amountMinor: amount });
      return { creator: m, paymentId, amount };
    }
    const event = (t, id) => ({ id, rawType: 'test.paid', type: 'paid', providerRef: `test_${t.paymentId}`, amountMinor: t.amount, currency: 'INR', paidAt: null });

    test('the same event delivered many times at once credits the creator once', async () => {
      const t = await newTip(`tipper${++seq}`);
      const { ok, failed } = settled(await Promise.allSettled(Array.from({ length: BURST }, () => mon.applyProviderEvent(event(t, `same-${t.paymentId}`)))));
      assert.deepEqual(failed, [], 'no delivery fails (the provider would retry a failure)');
      assert.equal(ok.filter((r) => r.result === 'credited').length, 1);
      assert.ok(ok.filter((r) => r.result !== 'credited').every((r) => r.result === 'duplicate'));
      const credits = (await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE ref_id = $1`, [t.paymentId])).rows[0].n;
      assert.equal(credits, 2, 'one creator entry and one platform fee entry');
      assert.equal((await mon.balances(t.creator.id)).total, 45_000);
    });

    test('the same payment announced under many different event ids at once is still credited once, without any delivery failing', async () => {
      const t = await newTip(`tipper${++seq}`);
      const { ok, failed } = settled(await Promise.allSettled(Array.from({ length: BURST }, (_, i) => mon.applyProviderEvent(event(t, `diff-${i}-${t.paymentId}`)))));
      assert.deepEqual(failed, [], 'no delivery fails');
      assert.equal(ok.filter((r) => r.result === 'credited').length, 1);
      assert.ok(ok.filter((r) => r.result !== 'credited').every((r) => r.result === 'already_paid'));
      assert.equal((await mon.balances(t.creator.id)).total, 45_000);
    });

    test('platform and creators still add up to everything that was paid in', async () => {
      const row = await one(`SELECT COALESCE(sum(amount_minor), 0)::bigint AS total FROM ledger_entries WHERE kind IN ('tip_net', 'tip_fee')`);
      const paid = await one(`SELECT COALESCE(sum(amount_minor), 0)::bigint AS total FROM payments WHERE status = 'paid'`);
      assert.equal(Number(row.total), Number(paid.total));
    });
  });

  describe('background jobs', () => {
    test('workers claiming at once hand every job to exactly one of them', async () => {
      const jobs = app.ctx.jobs;
      await q(`UPDATE jobs SET status = 'done' WHERE status = 'queued'`);
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await jobs.enqueue('race.test', { i }));
      const claimed = await Promise.all(Array.from({ length: 12 }, () => jobs.claim()));
      const got = claimed.filter(Boolean).map((j) => j.id);
      assert.equal(got.length, 5, 'all five are handed out');
      assert.equal(new Set(got).size, 5, 'and none twice');
      const rows = (await q(`SELECT attempts FROM jobs WHERE kind = 'race.test'`)).rows;
      assert.ok(rows.every((r) => r.attempts === 1));
    });

    test('a worker is not made to wait for a job another worker is busy claiming: it takes the next one', async () => {
      const jobs = app.ctx.jobs;
      await q(`UPDATE jobs SET status = 'done' WHERE status = 'queued'`);
      const first = await jobs.enqueue('race.skip', { n: 1 });
      const next = await jobs.enqueue('race.skip', { n: 2 });
      // Another worker is in the middle of taking the first job: it holds that row's lock and has not finished.
      const pg = (await import('pg')).default;
      const busy = new pg.Client({ connectionString: app.databaseUrl });
      await busy.connect();
      await busy.query('BEGIN');
      await busy.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [first]);
      let claim;
      try {
        claim = jobs.claim();
        const got = await Promise.race([claim, new Promise((resolve) => setTimeout(() => resolve('waited'), 2500))]);
        assert.notEqual(got, 'waited', 'the claim waited for the busy worker instead of moving on');
        assert.equal(got?.id, next, 'it took the next job');
      } finally {
        await busy.query('ROLLBACK');
        await busy.end();
        await claim?.catch(() => {});
      }
    });

    test('the same job queued many times at once exists once', async () => {
      const results = await Promise.all(Array.from({ length: BURST }, () => app.ctx.jobs.enqueue('race.dedupe', {}, { dedupeKey: 'only-one-of-me' })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await one(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = 'only-one-of-me'`)).n, 1);
    });
  });

  describe('accounts and follows', () => {
    test('many sign-ups with one email at once make one account, and nobody sees an error page', async () => {
      const clients = Array.from({ length: BURST }, () => app.client());
      const email = `same${++seq}@example.com`;
      const replies = await Promise.all(clients.map((c, i) => c.post('/signup', { displayName: 'Same Person', handle: `samey${seq}x${i}`, email, password: 'correct horse battery staple', adult: '1', terms: '1' })));
      assert.ok(replies.every((r) => r.status < 500), `statuses: ${replies.map((r) => r.status).join(',')}`);
      const n = (await one('SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)', [email])).n;
      assert.equal(n, 1);
    });

    test('many sign-ups wanting one handle at once make one account; the rest are told it is taken', async () => {
      const clients = Array.from({ length: BURST }, () => app.client());
      const handle = `wanted${++seq}`;
      const replies = await Promise.all(clients.map((c, i) => c.post('/signup', { displayName: 'Handle Fan', handle, email: `hf${seq}x${i}@example.com`, password: 'correct horse battery staple', adult: '1', terms: '1' })));
      assert.ok(replies.every((r) => r.status < 500), `statuses: ${replies.map((r) => r.status).join(',')}`);
      assert.equal((await one('SELECT count(*)::int AS n FROM users WHERE lower(handle) = lower($1)', [handle])).n, 1);
      assert.equal(replies.filter((r) => /handle is taken/i.test(r.text)).length, BURST - 1);
    });

    test('subscribing many times at once leaves one subscription', async () => {
      const engagement = app.ctx.engagement;
      const results = await Promise.allSettled(Array.from({ length: BURST }, () => engagement.subscribe(fan.id, owner.id)));
      assert.deepEqual(settled(results).failed, []);
      assert.equal(await engagement.subscriberCount(owner.id), 1);
    });
  });
});
