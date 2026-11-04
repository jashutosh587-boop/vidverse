import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, makeAdmin } from './helpers/users.js';

const DAY = 86_400_000;
const idFrom = (location, prefix) => new RegExp(`^${prefix}([0-9a-f-]{36})$`).exec(location ?? '')?.[1];
const ledger = async (app, where = 'TRUE', params = []) => (await app.ctx.db.query(`SELECT * FROM ledger_entries WHERE ${where} ORDER BY id`, params)).rows;
const total = (rows) => rows.reduce((s, r) => s + Number(r.amount_minor), 0);

describe('tips with the practice provider', () => {
  let app;
  let ashaC;
  let benC;
  let asha;
  let ben;
  let admin;

  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'test' } });
    ashaC = app.client();
    benC = app.client();
    asha = await createMember(app, ashaC, { email: 'asha@example.com', handle: 'asha', name: 'Asha Rao' });
    ben = await createMember(app, benC, { email: 'ben@example.com', handle: 'ben', name: 'Ben Fox' });
    admin = await createMember(app, app.client(), { email: 'root@example.com', handle: 'rootadmin', name: 'Root' });
    await makeAdmin(app, admin.id);
    await ashaC.post('/studio/terms', { agree: '1' });
  });
  after(() => app.close());

  async function startTip(client, fields = {}, handle = 'asha') {
    const r = await client.post(`/support/@${handle}`, { preset: '100', ...fields });
    return { r, id: idFrom(r.location, '/support/continue/') };
  }

  test('a signed-out visitor is sent to sign in and brought back', async () => {
    const r = await app.client().get('/support/@asha');
    assert.equal(r.status, 303);
    assert.equal(r.location, `/login?next=${encodeURIComponent('/support/@asha')}`);
  });

  test('the tip page shows amounts, the fee, the holding period and that this is practice mode', async () => {
    const r = await benC.get('/support/@asha');
    assert.equal(r.status, 200);
    assert.match(r.text, /Support Asha Rao/);
    for (const amount of ['₹50', '₹100', '₹250', '₹500', '₹1,000']) assert.ok(r.text.includes(`<span>${amount}</span>`), amount);
    assert.match(r.text, /keeps 10%/);
    assert.match(r.text, /7-day holding period/);
    assert.match(r.text, /Practice mode/);
    assert.ok(!/name="preset"[^>]*checked/.test(r.text), 'no amount is pre-selected');
    assert.equal(r.header('cache-control'), 'no-store');
  });

  test('a channel whose owner has not accepted the creator terms cannot receive tips', async () => {
    await createMember(app, app.client(), { email: 'cara@example.com', handle: 'cara', name: 'Cara' });
    assert.equal((await benC.get('/support/@cara')).status, 404);
    assert.equal((await benC.post('/support/@cara', { preset: '100' })).status, 404);
  });

  test('unknown, deleted and suspended channels are not found, and you cannot tip yourself', async () => {
    assert.equal((await benC.get('/support/@nobody')).status, 404);
    const own = await ashaC.get('/support/@asha');
    assert.equal(own.status, 400);
    assert.match(own.text, /cannot tip your own channel/);
    assert.equal((await ashaC.post('/support/@asha', { preset: '100' })).status, 400);
    await app.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [asha.id]);
    assert.equal((await benC.get('/support/@asha')).status, 404);
    await app.ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [asha.id]);
  });

  test('missing, malformed and out-of-range amounts are refused with a message, and nothing is created', async () => {
    const before = (await app.ctx.db.one('SELECT count(*)::int AS n FROM payments')).n;
    const cases = [
      [{ preset: '', amount: '' }, /Choose an amount/],
      [{ preset: '', amount: 'abc' }, /Enter an amount in rupees/],
      [{ preset: '', amount: '-50' }, /Enter an amount in rupees/],
      [{ preset: '', amount: '12.345' }, /Enter an amount in rupees/],
      [{ preset: '', amount: '5' }, /between ₹20\.00 and ₹50,000\.00/],
      [{ preset: '', amount: '50001' }, /between ₹20\.00 and ₹50,000\.00/],
      [{ preset: '', amount: '1e9' }, /Enter an amount in rupees/],
    ];
    for (const [fields, pattern] of cases) {
      const { r } = await startTip(benC, fields);
      assert.equal(r.status, 422, JSON.stringify(fields));
      assert.match(r.text, pattern, JSON.stringify(fields));
    }
    assert.equal((await app.ctx.db.one('SELECT count(*)::int AS n FROM payments')).n, before);
  });

  test('a typed amount wins over a ticked preset', async () => {
    const { r, id } = await startTip(benC, { preset: '100', amount: '75' });
    assert.equal(r.status, 303);
    const p = await app.ctx.db.one('SELECT amount_minor, fee_minor, net_minor FROM payments WHERE id = $1', [id]);
    assert.deepEqual({ a: p.amount_minor, f: p.fee_minor, n: p.net_minor }, { a: 7500, f: 750, n: 6750 });
    await app.ctx.db.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [id]);
  });

  test('a message over 140 characters is refused and the form keeps what was typed', async () => {
    const { r } = await startTip(benC, { message: 'x'.repeat(141) });
    assert.equal(r.status, 422);
    assert.match(r.text, /at most 140 characters/);
  });

  test('the whole flow: pay, get credited once, the creator sees it, and every rupee is accounted for', async () => {
    const { r, id } = await startTip(benC, { message: 'Loved the last video', anonymous: '' });
    assert.equal(r.status, 303);
    assert.ok(id);

    // Starting a tip moves no money.
    assert.equal((await ledger(app, 'user_id = $1', [asha.id])).length, 0);
    const created = await app.ctx.db.one('SELECT * FROM payments WHERE id = $1', [id]);
    assert.equal(created.status, 'created');
    assert.equal(created.provider, 'test');
    assert.equal(created.provider_ref, `test_${id}`);
    assert.equal(created.payer_id, ben.id);
    assert.equal(created.channel_id, asha.id);

    // The page between our form and the provider is a link, not a redirect (our policy only lets forms post to this site).
    const cont = await benC.get(`/support/continue/${id}`);
    assert.equal(cont.status, 200);
    assert.match(cont.text, /Continue to payment/);
    const target = /data-checkout="([^"]+)"/.exec(cont.text)[1].replace(/&amp;/g, '&');
    assert.equal(new URL(target).pathname, `/support/test-checkout/${id}`);
    assert.match(cont.header('content-security-policy'), /form-action 'self'/);

    const checkout = await benC.get(`/support/test-checkout/${id}`);
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /Nothing here charges anyone/);

    // Waiting page before payment.
    const waiting = await benC.get(`/support/thanks/${id}`);
    assert.match(waiting.text, /Waiting for the payment to be confirmed/);
    assert.match(waiting.text, new RegExp(`data-support-status="${id}"`));

    const paid = await benC.post(`/support/test-checkout/${id}/pay`);
    assert.equal(paid.status, 303);
    assert.equal(paid.location, `/support/thanks/${id}`);

    const thanks = await benC.get(`/support/thanks/${id}`);
    assert.match(thanks.text, /Thank you/);
    assert.match(thanks.text, /They will see your name/);
    assert.match(thanks.text, /data-support-status=""/, 'no polling once the tip is settled');

    const row = await app.ctx.db.one('SELECT * FROM payments WHERE id = $1', [id]);
    assert.equal(row.status, 'paid');
    assert.ok(row.paid_at);

    const entries = await ledger(app, `ref_type = 'payment' AND ref_id = $1`, [id]);
    assert.equal(entries.length, 2);
    const net = entries.find((e) => e.kind === 'tip_net');
    const fee = entries.find((e) => e.kind === 'tip_fee');
    assert.equal(net.account, `user:${asha.id}`);
    assert.equal(Number(net.amount_minor), 9000);
    assert.equal(fee.account, 'platform');
    assert.equal(fee.user_id, null);
    assert.equal(Number(fee.amount_minor), 1000);
    assert.equal(total(entries), Number(row.amount_minor), 'what was paid equals what the creator and the platform received');
    assert.equal(new Date(net.available_at).getTime(), new Date(row.paid_at).getTime() + 7 * DAY);

    // The creator is told, and sees the tip with the name and message.
    const note = await app.ctx.db.one(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'tip'`, [asha.id]);
    assert.equal(note.data.from, 'Ben Fox');
    const earn = await ashaC.get('/studio/earnings');
    assert.equal(earn.status, 200);
    assert.match(earn.text, /Ben Fox/);
    assert.match(earn.text, /Loved the last video/);
    assert.match(earn.text, /₹90\.00/);
    assert.equal(earn.header('cache-control'), 'no-store');
  });

  test('pressing Pay again, or the provider sending the same event again, credits nothing more', async () => {
    const id = (await app.ctx.db.one(`SELECT id FROM payments WHERE status = 'paid' ORDER BY created_at DESC LIMIT 1`)).id;
    const before = await ledger(app);
    const again = await benC.post(`/support/test-checkout/${id}/pay`);
    assert.equal(again.status, 303);
    assert.equal((await ledger(app)).length, before.length);
    const replay = await app.ctx.monetization.applyProviderEvent({ id: `test-paid-${id}`, rawType: 'test.paid', type: 'paid', providerRef: `test_${id}`, amountMinor: 10_000, currency: 'INR', paidAt: null });
    assert.equal(replay.result, 'duplicate');
    // A different event id for the same payment is also harmless.
    const other = await app.ctx.monetization.applyProviderEvent({ id: 'another-event', rawType: 'x', type: 'paid', providerRef: `test_${id}`, amountMinor: 10_000, currency: 'INR', paidAt: null });
    assert.equal(other.result, 'already_paid');
    assert.equal((await ledger(app)).length, before.length);
  });

  test('the balance is pending for the holding period and becomes available after it', async () => {
    const mon = app.ctx.monetization;
    let b = await mon.balances(asha.id);
    assert.deepEqual({ available: b.available, pending: b.pending }, { available: 0, pending: 9000 });
    app.clock.advance(7 * DAY - 60_000);
    b = await mon.balances(asha.id);
    assert.equal(b.available, 0, 'one minute early');
    app.clock.advance(120_000);
    b = await mon.balances(asha.id);
    assert.deepEqual({ available: b.available, pending: b.pending }, { available: 9000, pending: 0 });
  });

  test('an anonymous tip hides the name, and hostile text in a message is shown as text', async () => {
    const { id } = await startTip(benC, { preset: '250', message: '<script>alert(1)</script> <img src=x onerror=alert(2)>', anonymous: '1' });
    await benC.post(`/support/test-checkout/${id}/pay`);
    assert.match((await benC.get(`/support/thanks/${id}`)).text, /They will see Anonymous/);
    const earn = (await ashaC.get('/studio/earnings')).text;
    assert.ok(!earn.includes('<script>alert(1)'), 'script tag must be escaped');
    assert.ok(!earn.includes('<img src=x'), 'tag must be escaped');
    assert.match(earn, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const rows = earn.split('<tr>').filter((x) => x.includes('alert(1)'));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /Anonymous/);
    assert.ok(!rows[0].includes('Ben Fox'));
    // The payer is still recorded for our own books.
    const p = await app.ctx.db.one('SELECT payer_id, anonymous FROM payments WHERE id = $1', [id]);
    assert.equal(p.payer_id, ben.id);
    assert.equal(p.anonymous, true);
  });

  test('only the payer can see a tip’s pages or poll its status', async () => {
    const id = (await app.ctx.db.one(`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`)).id;
    for (const client of [ashaC, await (async () => { const c = app.client(); await createMember(app, c, { email: 'dev@example.com', handle: 'devon', name: 'Devon' }); return c; })()]) {
      for (const path of [`/support/thanks/${id}`, `/support/continue/${id}`, `/support/test-checkout/${id}`, `/api/support/${id}/status`]) {
        assert.equal((await client.get(path)).status, 404, path);
      }
      assert.equal((await client.post(`/support/test-checkout/${id}/pay`)).status, 404);
    }
    assert.equal((await app.client().get(`/api/support/${id}/status`)).status, 401);
    const mine = await benC.get(`/api/support/${id}/status`);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json(), { status: 'paid' });
    assert.equal(mine.header('cache-control'), 'no-store');
    assert.equal((await benC.get('/api/support/not-an-id/status')).status, 404);
  });

  test('cancelling at the checkout marks the tip failed and credits nothing', async () => {
    const before = (await ledger(app)).length;
    const { id } = await startTip(benC, { preset: '50' });
    const c = await benC.post(`/support/test-checkout/${id}/cancel`);
    assert.equal(c.status, 303);
    assert.equal((await app.ctx.db.one('SELECT status FROM payments WHERE id = $1', [id])).status, 'failed');
    assert.equal((await ledger(app)).length, before);
    assert.match((await benC.get(`/support/thanks/${id}`)).text, /not completed/);
    assert.equal((await benC.get(`/support/continue/${id}`)).status, 303, 'nothing left to continue to');
  });

  test('the checkout needs a signed-in payer, and the forms need the CSRF token', async () => {
    const { id } = await startTip(benC, { preset: '50' });
    assert.equal((await app.client().get(`/support/test-checkout/${id}`)).status, 303);
    const noCsrf = await benC.post(`/support/test-checkout/${id}/pay`, {}, { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal((await app.ctx.db.one('SELECT status FROM payments WHERE id = $1', [id])).status, 'created');
    const noCsrfTip = await benC.post('/support/@asha', { preset: '100' }, { csrf: false });
    assert.equal(noCsrfTip.status, 403);
    await benC.post(`/support/test-checkout/${id}/cancel`);
  });

  test('a person cannot leave piles of unpaid tips open', async () => {
    const c = app.client();
    await createMember(app, c, { email: 'eve@example.com', handle: 'eve', name: 'Eve' });
    for (let i = 0; i < 5; i++) assert.equal((await startTip(c, { preset: '50' })).r.status, 303);
    const sixth = await startTip(c, { preset: '50' });
    assert.equal(sixth.r.status, 429);
    assert.match(sixth.r.text, /several tips waiting/);
  });

  test('unpaid tips expire, so a stuck tip does not count against the person for ever', async () => {
    const stale = (await startTip(benC, { preset: '50' })).id;
    app.clock.advance(4 * DAY);
    const n = await app.ctx.monetization.expireStale();
    assert.ok(n >= 1);
    assert.equal((await app.ctx.db.one('SELECT status FROM payments WHERE id = $1', [stale])).status, 'expired');
    assert.equal((await app.ctx.db.one(`SELECT status FROM payments WHERE status = 'paid' LIMIT 1`)).status, 'paid', 'paid tips are untouched');
  });

  test('a tip can name one of the creator’s videos, and not anyone else’s', async () => {
    const mk = (id, owner, vis = 'public') => app.ctx.db.query(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at) VALUES ($1, $2, $3, 'ready', $4, now())`, [id, owner, `Title ${id}`, vis]);
    await mk('AAAAAAAAAAA', asha.id);
    await mk('BBBBBBBBBBB', ben.id);
    await mk('CCCCCCCCCCC', asha.id, 'private');
    const page = await benC.get('/support/@asha?video=AAAAAAAAAAA');
    assert.match(page.text, /for the video <a href="\/watch\/AAAAAAAAAAA">Title AAAAAAAAAAA/);
    for (const v of ['BBBBBBBBBBB', 'CCCCCCCCCCC', 'nope', '../etc']) {
      assert.ok(!/for the video/.test((await benC.get(`/support/@asha?video=${encodeURIComponent(v)}`)).text), v);
    }
    const { id } = await startTip(benC, { preset: '50', video: 'BBBBBBBBBBB' });
    assert.equal((await app.ctx.db.one('SELECT video_id FROM payments WHERE id = $1', [id])).video_id, null, 'a video that is not the creator’s is dropped');
    const ok = await startTip(benC, { preset: '50', video: 'AAAAAAAAAAA' });
    assert.equal((await app.ctx.db.one('SELECT video_id FROM payments WHERE id = $1', [ok.id])).video_id, 'AAAAAAAAAAA');
    await benC.post(`/support/test-checkout/${id}/cancel`);
    await benC.post(`/support/test-checkout/${ok.id}/cancel`);
  });

  test('the statement CSV has every ledger line, a byte-order mark, and text cells that cannot run as formulas', async () => {
    const paid = (await app.ctx.db.one(`SELECT id FROM payments WHERE status = 'paid' ORDER BY paid_at LIMIT 1`)).id;
    await app.ctx.monetization.refundPayment(paid, admin.id, '=HYPERLINK("http://example.org","click")');
    const r = await ashaC.get('/studio/earnings.csv');
    assert.equal(r.status, 200);
    assert.match(r.header('content-type'), /^text\/csv/);
    assert.match(r.header('content-disposition'), /^attachment; filename="vidverse-statement-2026-1[01]-\d\d\.csv"$/);
    assert.deepEqual([...r.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a UTF-8 byte-order mark so Excel reads it correctly');
    const lines = r.text.slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines[0], 'Date (UTC),What,Amount,Currency,Available from (UTC),Reference,Note');
    const mine = (await ledger(app, 'user_id = $1', [asha.id])).length;
    assert.equal(lines.length - 1, mine);
    assert.ok(lines.some((l) => l.includes(',tip_net,90.00,INR,')));
    const refund = lines.find((l) => l.includes(',refund,'));
    assert.match(refund, /,-90\.00,INR,/, 'amounts are plain numbers');
    assert.ok(refund.includes(`"'=HYPERLINK(""http://example.org"",""click"")"`), refund);
    assert.equal((await app.client().get('/studio/earnings.csv')).status, 303);
    assert.equal((await benC.get('/studio/earnings.csv')).text.split('\r\n').filter(Boolean).length, 1, 'someone else sees only their own (empty) statement');
  });

  test('a refund is booked in the same bucket as the tip, once, and the books still balance', async () => {
    const mon = app.ctx.monetization;
    const paid = (await app.ctx.db.one(`SELECT id, amount_minor FROM payments WHERE status = 'refunded' LIMIT 1`));
    const rows = await ledger(app, `ref_type = 'payment' AND ref_id = $1`, [paid.id]);
    assert.equal(rows.length, 4, 'tip_net, tip_fee, and the two refund lines');
    assert.equal(total(rows), 0, 'a refunded tip nets to nothing');
    const tipNet = rows.find((r) => r.kind === 'tip_net');
    const refundNet = rows.find((r) => r.kind === 'refund' && r.user_id === asha.id);
    assert.equal(new Date(refundNet.available_at).getTime(), new Date(tipNet.available_at).getTime());
    await assert.rejects(() => mon.refundPayment(paid.id, admin.id, 'again'), (e) => e.status === 409);
    await assert.rejects(() => mon.refundPayment(paid.id, admin.id, ''), (e) => e.status === 422);
    const s = await mon.platformSummary();
    assert.ok(s.platformEarned >= 0);
  });

  test('the ledger cannot be edited or erased, even by the application’s own database login', async () => {
    const some = (await ledger(app))[0];
    await assert.rejects(() => app.ctx.db.query('UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1', [some.id]), /append-only/);
    await assert.rejects(() => app.ctx.db.query('DELETE FROM ledger_entries WHERE id = $1', [some.id]), /append-only/);
    await assert.rejects(() => app.ctx.db.query('TRUNCATE ledger_entries'), /append-only/);
    await assert.rejects(
      () => app.ctx.db.query(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, $3, 5, 'INR', now(), $4, $5)`, [some.account, some.user_id, some.kind, some.ref_type, some.ref_id]),
      /unique|duplicate/i,
      'the same payment cannot be booked twice',
    );
  });

  test('the database refuses a payment whose fee and net do not add up to the amount', async () => {
    await assert.rejects(
      () => app.ctx.db.query(`INSERT INTO payments (channel_id, amount_minor, currency, fee_minor, net_minor, provider) VALUES ($1, 1000, 'INR', 100, 800, 'test')`, [asha.id]),
      /check/i,
    );
  });
});

describe('money switched off', () => {
  let app;
  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'off' } });
  });
  after(() => app.close());

  test('there are no tip, earnings or payout pages, and the studio does not link to them', async () => {
    const c = app.client();
    await createMember(app, c, { email: 'asha@example.com', handle: 'asha', name: 'Asha' });
    await c.post('/studio/terms', { agree: '1' });
    assert.equal(app.ctx.monetization, null);
    for (const path of ['/support/@asha', '/studio/earnings', '/studio/earnings.csv', '/studio/payouts']) assert.equal((await c.get(path)).status, 404, path);
    const studio = await c.get('/studio');
    assert.equal(studio.status, 200);
    assert.ok(!studio.text.includes('/studio/earnings'));
    assert.ok(!studio.text.includes('/studio/payouts'));
    const channel = await c.get('/@asha');
    assert.ok(!channel.text.includes('/support/@asha'));
    assert.equal((await c.post('/webhooks/razorpay', {})).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/webhooks/razorpay`, { method: 'POST', body: '{}' })).status, 403, 'unknown POST routes are not reachable without the CSRF token');
  });
});
