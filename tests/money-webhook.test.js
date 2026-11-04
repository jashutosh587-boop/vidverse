import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestApp } from './helpers/app.js';
import { createMember } from './helpers/users.js';
import { createRazorpayProvider, ProviderError } from '../src/services/payments/razorpay.js';

const SECRET = 'whsec_unit_test_secret';
const KEY_ID = 'rzp_test_unitkey';
const KEY_SECRET = 'unit_key_secret';

const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const linkEvent = (event, linkId, { amountPaid = 10_000, currency = 'INR', paymentId = 'pay_unit1', createdAt = 1_793_700_000 } = {}) =>
  JSON.stringify({ entity: 'event', account_id: 'acc_x', event, created_at: createdAt, payload: { payment_link: { entity: { id: linkId, amount: 10_000, amount_paid: amountPaid, currency, status: event.split('.')[1] } }, payment: { entity: { id: paymentId } } } });

describe('Razorpay: creating the payment link and receiving the signed webhook', () => {
  let app;
  let benC;
  let asha;
  let calls;
  let razorpayAnswer;

  async function post(body, { event = `evt_${crypto.randomUUID()}`, signature = sign(body), headers = {} } = {}) {
    const h = { 'content-type': 'application/json', ...headers };
    if (signature !== null) h['x-razorpay-signature'] = signature;
    if (event !== null) h['x-razorpay-event-id'] = event;
    const res = await fetch(`${app.baseUrl}/webhooks/razorpay`, { method: 'POST', headers: h, body });
    return { status: res.status, body: await res.json().catch(() => null), event };
  }
  const ledgerCount = async () => (await app.ctx.db.one('SELECT count(*)::int AS n FROM ledger_entries')).n;
  const payment = (id) => app.ctx.db.one('SELECT * FROM payments WHERE id = $1', [id]);

  async function startTip(amount = '100') {
    const r = await benC.post('/support/@asha', { preset: amount });
    return { r, id: /\/support\/continue\/([0-9a-f-]{36})$/.exec(r.location ?? '')?.[1] };
  }

  before(async () => {
    calls = [];
    let links = 0;
    razorpayAnswer = () => {
      links += 1;
      return { status: 200, json: { id: `plink_${links}`, short_url: `https://rzp.io/i/abc${links}`, status: 'created' } };
    };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
      const a = razorpayAnswer();
      return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } });
    };
    app = await startTestApp({
      env: { PAYMENTS_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET },
      ctx: { fetch: fakeFetch },
    });
    const ashaC = app.client();
    benC = app.client();
    asha = await createMember(app, ashaC, { email: 'asha@example.com', handle: 'asha', name: 'Asha Rao' });
    await createMember(app, benC, { email: 'ben@example.com', handle: 'ben', name: 'Ben Fox' });
    await ashaC.post('/studio/terms', { agree: '1' });
  });
  after(() => app.close());

  test('starting a tip creates one payment link with the right amount, reference and return address', async () => {
    const { r, id } = await startTip('100');
    assert.equal(r.status, 303);
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(c.url, 'https://api.razorpay.com/v1/payment_links/');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.authorization, `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`);
    assert.equal(c.body.amount, 10_000);
    assert.equal(c.body.currency, 'INR');
    assert.equal(c.body.reference_id, id);
    assert.equal(c.body.callback_url, `${app.baseUrl}/support/thanks/${id}`);
    assert.equal(c.body.accept_partial, false);
    assert.deepEqual(c.body.notify, { sms: false, email: false }, 'Razorpay does not text or email the payer on our behalf');
    assert.ok(Number.isInteger(c.body.expire_by) && c.body.expire_by * 1000 > app.clock.now().getTime());
    assert.ok(c.body.description.length <= 500);
    assert.ok(!JSON.stringify(c.body).includes('ben@example.com'), 'no personal details are sent to the provider');
    const p = await payment(id);
    assert.equal(p.provider, 'razorpay');
    assert.equal(p.provider_ref, 'plink_1');
    assert.equal(p.checkout_url, 'https://rzp.io/i/abc1');
    assert.equal(p.status, 'created');
  });

  test('the payer is sent to the provider’s https page, and the practice checkout does not exist', async () => {
    const id = (await app.ctx.db.one(`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`)).id;
    const page = await benC.get(`/support/continue/${id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /href="https:\/\/rzp\.io\/i\/abc1"/);
    assert.match(page.text, /Razorpay/);
    assert.ok(!/Practice mode/.test(page.text));
    assert.equal((await benC.get(`/support/test-checkout/${id}`)).status, 404);
    assert.equal((await benC.post(`/support/test-checkout/${id}/pay`)).status, 404);
    assert.match((await benC.get('/support/@asha')).text, /Razorpay/);
    assert.ok(!/Practice mode/.test((await benC.get('/support/@asha')).text));
  });

  test('the webhook refuses a missing, wrong or forged signature and credits nothing', async () => {
    const id = (await app.ctx.db.one(`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`)).id;
    const body = linkEvent('payment_link.paid', 'plink_1');
    const before = await ledgerCount();
    for (const signature of [null, '', 'deadbeef', sign(body, 'someone else’s secret'), sign(`${body} `), sign(body).toUpperCase().replace(/^./, 'g')]) {
      const r = await post(body, { signature });
      assert.equal(r.status, 400, String(signature));
    }
    assert.equal((await post(body, { event: null })).status, 400, 'no event id');
    assert.equal((await post('not json at all')).status, 400);
    assert.equal((await post('')).status, 400);
    assert.equal((await post(body.replace('10000', '1'), { signature: sign(body) })).status, 400, 'a changed body no longer matches its signature');
    assert.equal(await ledgerCount(), before);
    assert.equal((await payment(id)).status, 'created');
  });

  test('the webhook needs no cookies and no CSRF token, and only answers POST', async () => {
    assert.equal((await fetch(`${app.baseUrl}/webhooks/razorpay`)).status, 404);
    const body = linkEvent('payment_link.paid', 'plink_unknown');
    const r = await post(body);
    assert.equal(r.status, 200, 'a validly signed event is accepted without a session');
    assert.equal(r.body.result, 'unknown');
  });

  test('a correctly signed "paid" event credits the creator once, with the platform fee', async () => {
    const id = (await app.ctx.db.one(`SELECT id FROM payments ORDER BY created_at DESC LIMIT 1`)).id;
    const thanksBefore = await benC.get(`/support/thanks/${id}`);
    assert.match(thanksBefore.text, /Waiting for the payment to be confirmed/);
    const body = linkEvent('payment_link.paid', 'plink_1', { createdAt: Math.floor(app.clock.now().getTime() / 1000) });
    const r = await post(body, { event: 'evt_paid_1' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, result: 'credited' });
    const p = await payment(id);
    assert.equal(p.status, 'paid');
    assert.equal(p.provider_payment_id, 'pay_unit1');
    const rows = (await app.ctx.db.query(`SELECT kind, amount_minor, user_id FROM ledger_entries WHERE ref_id = $1 ORDER BY kind`, [id])).rows;
    assert.deepEqual(rows.map((x) => [x.kind, Number(x.amount_minor)]), [['tip_fee', 1000], ['tip_net', 9000]]);
    assert.equal((await benC.get(`/support/thanks/${id}`)).text.includes('Thank you'), true);
    assert.equal((await benC.get(`/api/support/${id}/status`)).json().status, 'paid');
  });

  test('the same event arriving again, or the same payment under a new event id, changes nothing', async () => {
    const before = await ledgerCount();
    const body = linkEvent('payment_link.paid', 'plink_1');
    const again = await post(body, { event: 'evt_paid_1' });
    assert.deepEqual(again.body, { ok: true, result: 'duplicate' });
    const renamed = await post(body, { event: 'evt_paid_2' });
    assert.deepEqual(renamed.body, { ok: true, result: 'already_paid' });
    assert.equal(await ledgerCount(), before);
  });

  test('a payment for the wrong amount or currency is not credited and is written to the audit log', async () => {
    const { id } = await startTip('250');
    const ref = (await payment(id)).provider_ref;
    for (const [event, opts] of [['evt_short', { amountPaid: 100 }], ['evt_usd', { amountPaid: 25_000, currency: 'USD' }]]) {
      const r = await post(linkEvent('payment_link.paid', ref, opts), { event });
      assert.equal(r.status, 200);
      assert.equal(r.body.result, 'mismatch', event);
    }
    assert.equal((await payment(id)).status, 'created');
    const logs = (await app.ctx.db.query(`SELECT meta FROM audit_log WHERE action = 'payment.amount_mismatch' AND target_id = $1`, [id])).rows;
    assert.equal(logs.length, 2);
    assert.deepEqual({ expected: logs[0].meta.expected, got: logs[0].meta.got }, { expected: 25_000, got: 100 });
    // The right amount still works afterwards.
    const ok = await post(linkEvent('payment_link.paid', ref, { amountPaid: 25_000 }), { event: 'evt_right' });
    assert.equal(ok.body.result, 'credited');
  });

  test('expired and cancelled links close the tip; money that still arrives afterwards is credited, because it was received', async () => {
    const a = await startTip('50');
    const b = await startTip('50');
    const refOf = async (id) => (await payment(id)).provider_ref;
    assert.equal((await post(linkEvent('payment_link.expired', await refOf(a.id)))).body.result, 'expired');
    assert.equal((await post(linkEvent('payment_link.cancelled', await refOf(b.id)))).body.result, 'cancelled');
    assert.equal((await payment(a.id)).status, 'expired');
    assert.equal((await payment(b.id)).status, 'failed');
    assert.match((await benC.get(`/support/thanks/${a.id}`)).text, /not completed/);
    const late = await post(linkEvent('payment_link.paid', await refOf(a.id), { amountPaid: 5000 }));
    assert.equal(late.body.result, 'credited');
    assert.equal((await payment(a.id)).status, 'paid');
  });

  test('events we do not act on are acknowledged so the provider stops retrying them', async () => {
    const r = await post(JSON.stringify({ event: 'payment.captured', payload: {} }));
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'ignored');
    const partial = await post(linkEvent('payment_link.partially_paid', 'plink_1'));
    assert.equal(partial.body.result, 'ignored');
  });

  test('if our side fails halfway, nothing is half-booked, and the provider’s retry then succeeds', async () => {
    const { id } = await startTip('100');
    const ref = (await payment(id)).provider_ref;
    const before = await ledgerCount();
    const real = app.ctx.notifications.create;
    app.ctx.notifications.create = async () => {
      throw new Error('simulated failure after the ledger was written');
    };
    let r;
    try {
      r = await post(linkEvent('payment_link.paid', ref), { event: 'evt_retry' });
    } finally {
      app.ctx.notifications.create = real;
    }
    assert.equal(r.status, 500, 'a 5xx makes the provider send the event again');
    assert.equal((await payment(id)).status, 'created', 'the payment is not marked paid');
    assert.equal(await ledgerCount(), before, 'no ledger line was kept');
    assert.equal((await app.ctx.db.one(`SELECT count(*)::int AS n FROM webhook_events WHERE event_id = 'evt_retry'`)).n, 0, 'the event is not recorded as seen');
    const retry = await post(linkEvent('payment_link.paid', ref), { event: 'evt_retry' });
    assert.deepEqual(retry.body, { ok: true, result: 'credited' });
    assert.equal(await ledgerCount(), before + 2);
  });

  test('if the provider is down, the tip fails cleanly and the payer is told they were not charged', async () => {
    const saved = razorpayAnswer;
    const count = async (status) => (await app.ctx.db.one('SELECT count(*)::int AS n FROM payments WHERE status = $1', [status])).n;
    const failed0 = await count('failed');
    const open0 = await count('created');
    razorpayAnswer = () => ({ status: 503, json: { error: { description: 'down' } } });
    try {
      const { r } = await startTip('100');
      assert.equal(r.status, 502);
      assert.match(r.text, /could not reach the payment provider/);
      assert.match(r.text, /not been charged/);
      assert.equal(await count('failed'), failed0 + 1, 'the attempt is recorded as failed');
      razorpayAnswer = () => ({ status: 200, json: { id: 'plink_x', short_url: 'http://insecure.example/pay' } });
      const insecure = await startTip('100');
      assert.equal(insecure.r.status, 502, 'a payment page that is not https is never used');
      razorpayAnswer = () => ({ status: 200, json: { id: 'plink_x2' } });
      assert.equal((await startTip('100')).r.status, 502, 'an answer without a payment page is never used');
      assert.equal(await count('failed'), failed0 + 3);
      assert.equal(await count('created'), open0, 'no half-made tip is left open');
    } finally {
      razorpayAnswer = saved;
    }
  });

  test('a link whose address is not https is never offered to the payer', async () => {
    const { id } = await startTip('100');
    await app.ctx.db.query(`UPDATE payments SET checkout_url = 'javascript:alert(1)' WHERE id = $1`, [id]);
    const r = await benC.get(`/support/continue/${id}`);
    assert.equal(r.status, 303);
    assert.equal(r.location, `/support/thanks/${id}`);
    await app.ctx.db.query(`UPDATE payments SET checkout_url = 'http://evil.example/' WHERE id = $1`, [id]);
    assert.equal((await benC.get(`/support/continue/${id}`)).status, 303, 'plain http outside practice mode is refused');
  });

  test('the books balance after all of that', async () => {
    const sum = async (where) => Number((await app.ctx.db.one(`SELECT COALESCE(sum(amount_minor), 0) AS s FROM ledger_entries WHERE ${where}`)).s);
    const paid = Number((await app.ctx.db.one(`SELECT COALESCE(sum(amount_minor), 0) AS s FROM payments WHERE status = 'paid'`)).s);
    assert.equal((await sum('user_id IS NOT NULL')) + (await sum('user_id IS NULL')), paid);
    assert.equal(await sum(`user_id = '${asha.id}'`), paid - (await sum('user_id IS NULL')));
  });
});

describe('the Razorpay adapter on its own', () => {
  const make = (config = {}) => createRazorpayProvider({ fetch: async () => new Response('{}'), config: { payments: { razorpay: { keyId: 'k', keySecret: 's', webhookSecret: SECRET, apiBase: 'https://api.razorpay.com', ...config } } } });

  test('readWebhook returns null without a secret configured, even for a body signed with an empty secret', () => {
    const provider = make({ webhookSecret: null });
    const body = Buffer.from(linkEvent('payment_link.paid', 'plink_a'));
    assert.equal(provider.readWebhook({ rawBody: body, headers: { 'x-razorpay-signature': sign(body, ''), 'x-razorpay-event-id': 'e' } }), null);
  });

  test('readWebhook reads the amount and time from the signed body, never from anywhere else', () => {
    const provider = make();
    const body = Buffer.from(linkEvent('payment_link.paid', 'plink_a', { amountPaid: 12_345, createdAt: 1_793_700_000, paymentId: 'pay_zz' }));
    const e = provider.readWebhook({ rawBody: body, headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_z' } });
    assert.deepEqual({ id: e.id, type: e.type, ref: e.providerRef, amount: e.amountMinor, cur: e.currency, pay: e.providerPaymentId, at: e.paidAt.toISOString() }, { id: 'evt_z', type: 'paid', ref: 'plink_a', amount: 12_345, cur: 'INR', pay: 'pay_zz', at: new Date(1_793_700_000_000).toISOString() });
  });

  test('a non-buffer body is refused', () => {
    const provider = make();
    assert.equal(provider.readWebhook({ rawBody: linkEvent('payment_link.paid', 'p'), headers: {} }), null);
    assert.equal(provider.readWebhook({ rawBody: undefined, headers: {} }), null);
  });

  test('ProviderError carries the status for the logs', () => {
    const e = new ProviderError('x', { status: 429 });
    assert.equal(e.status, 429);
    assert.equal(e.name, 'ProviderError');
  });
});
