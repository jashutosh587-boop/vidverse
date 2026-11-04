import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, lastMail, makeAdmin, PASSWORD } from './helpers/users.js';
import { decryptString } from '../src/lib/crypto.js';
import { DETAILS_COOLOFF_MS } from '../src/services/monetization.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('balances and payouts', () => {
  let app;
  let mon;
  let ashaC;
  let asha;
  let ben;
  let boss;
  let second;

  const tip = async (cents = 100_000) => {
    // A completed tip, made through the same service the pages use.
    const payer = await app.ctx.db.one('SELECT * FROM users WHERE id = $1', [ben.id]);
    const { paymentId } = await mon.createTip({ payer, channelId: asha.id, amountMinor: cents });
    await mon.applyProviderEvent({ id: `e-${paymentId}`, rawType: 'test.paid', type: 'paid', providerRef: `test_${paymentId}`, amountMinor: cents, currency: 'INR', paidAt: null });
    return paymentId;
  };
  const balance = () => mon.balances(asha.id);
  const payoutRows = async () => (await app.ctx.db.query('SELECT * FROM payouts WHERE user_id = $1 ORDER BY requested_at', [asha.id])).rows;
  const entries = async (kind) => (await app.ctx.db.query('SELECT * FROM ledger_entries WHERE user_id = $1 AND kind = $2 ORDER BY id', [asha.id, kind])).rows;

  before(async () => {
    app = await startTestApp({ env: { PAYMENTS_PROVIDER: 'test' } });
    mon = app.ctx.monetization;
    ashaC = app.client();
    asha = await createMember(app, ashaC, { email: 'asha@example.com', handle: 'asha', name: 'Asha Rao' });
    ben = await createMember(app, app.client(), { email: 'ben@example.com', handle: 'ben', name: 'Ben Fox' });
    boss = await createMember(app, app.client(), { email: 'boss@example.com', handle: 'bossperson', name: 'Boss' });
    second = await createMember(app, app.client(), { email: 'second@example.com', handle: 'secondadmin', name: 'Second' });
    await makeAdmin(app, boss.id);
    await makeAdmin(app, second.id);
    await ashaC.post('/studio/terms', { agree: '1' });
    await tip(100_000); // Rs 1,000 -> Rs 900 to Asha after the 10% fee
    app.clock.advance(8 * DAY);
  });
  after(() => app.close());

  test('the payouts page explains what is missing before anything can be requested', async () => {
    const r = await ashaC.get('/studio/payouts');
    assert.equal(r.status, 200);
    assert.match(r.text, /₹900\.00/);
    assert.match(r.text, /Add where to send the money first/);
    assert.ok(!r.text.includes('action="/studio/payouts/request"'));
    assert.match(r.text, /Minimum payout/);
  });

  test('saving payout details needs the password, valid details and CSRF', async () => {
    let r = await ashaC.post('/studio/payouts/details', { method: 'upi', upi: 'asha@okbank', password: 'not it' });
    assert.equal(r.status, 422);
    assert.match(r.text, /That is not your password/);
    r = await ashaC.post('/studio/payouts/details', { method: 'upi', upi: 'nonsense', password: PASSWORD });
    assert.equal(r.status, 422);
    assert.match(r.text, /Enter a UPI address such as name@bank/);
    assert.ok(r.text.includes('value="nonsense"'), 'what was typed is kept');
    assert.ok(!r.text.includes(PASSWORD), 'the password is never echoed back');
    r = await ashaC.post('/studio/payouts/details', { method: 'upi', upi: 'asha@okbank', password: PASSWORD }, { csrf: false });
    assert.equal(r.status, 403);
    assert.equal(await mon.payoutProfile(asha.id), null);
    r = await ashaC.post('/studio/payouts/details', { method: 'bank', holder: '1', account: 'x', ifsc: 'y', password: PASSWORD });
    assert.equal(r.status, 422);
    assert.match(r.text, /9 to 18 digits/);
    assert.equal(await mon.payoutProfile(asha.id), null);
  });

  test('saved details are encrypted, shown back only in part, and an email warns the owner', async () => {
    const r = await ashaC.post('/studio/payouts/details', { method: 'upi', upi: 'asha.rao@okbank', password: PASSWORD });
    assert.equal(r.status, 303);
    const page = await ashaC.get('/studio/payouts');
    assert.match(page.text, /as••••@okbank/);
    assert.ok(!page.text.includes('asha.rao@okbank'), 'the full address is never shown again');
    assert.equal(page.text.split('Payout details saved.').length - 1, 1, 'the confirmation appears once, not twice');
    const row = await app.ctx.db.one('SELECT * FROM payout_profiles WHERE user_id = $1', [asha.id]);
    assert.ok(!row.details_enc.includes('asha.rao'));
    assert.deepEqual(JSON.parse(decryptString(app.config.encryptionKeys, row.details_enc, `payout:${asha.id}`)), { upi: 'asha.rao@okbank' });
    assert.throws(() => decryptString(app.config.encryptionKeys, row.details_enc, `payout:${ben.id}`), 'ciphertext is bound to its owner');
    const mail = lastMail(app, 'asha@example.com', /payout/i);
    assert.ok(mail, 'a warning email was sent');
    assert.ok(!mail.text.includes('asha.rao@okbank'), 'the email does not contain the full address either');
    const audit = await app.ctx.db.one(`SELECT meta FROM audit_log WHERE action = 'payout.details_changed' AND actor_id = $1`, [asha.id]);
    assert.equal(audit.meta.method, 'upi');
  });

  test('right after details change, payouts wait: a stolen session cannot cash out at once', async () => {
    const r = await ashaC.post('/studio/payouts/request', { payout_amount: '500' });
    assert.equal(r.status, 409);
    assert.match(r.text, /payouts wait \d+ more hours?/);
    assert.equal((await payoutRows()).length, 0);
    assert.equal((await balance()).available, 90_000);
    app.clock.advance(DETAILS_COOLOFF_MS - 60_000);
    assert.equal((await ashaC.post('/studio/payouts/request', { payout_amount: '500' })).status, 409, 'one minute early');
    app.clock.advance(120_000);
  });

  test('amounts that are not valid, below the minimum, or above the balance are refused', async () => {
    for (const [amount, pattern] of [['', /Enter an amount in rupees/], ['abc', /Enter an amount in rupees/], ['-5', /Enter an amount in rupees/], ['100', /minimum payout is ₹500\.00/], ['0', /minimum payout/], ['900.01', /withdraw up to ₹900\.00/], ['99999', /withdraw up to ₹900\.00/]]) {
      const r = await ashaC.post('/studio/payouts/request', { payout_amount: amount });
      assert.equal(r.status, 422, amount);
      assert.match(r.text, pattern, amount);
    }
    assert.equal((await payoutRows()).length, 0);
    assert.equal((await entries('payout_request')).length, 0);
  });

  test('a request takes the money out of the balance at once', async () => {
    const r = await ashaC.post('/studio/payouts/request', { payout_amount: '500' });
    assert.equal(r.status, 303);
    const [p] = await payoutRows();
    assert.equal(p.status, 'requested');
    assert.equal(Number(p.amount_minor), 50_000);
    assert.equal(p.display_hint, 'as••••@okbank');
    const [e] = await entries('payout_request');
    assert.equal(Number(e.amount_minor), -50_000);
    assert.equal(e.ref_id, p.id);
    assert.equal((await balance()).available, 40_000);
    const page = await ashaC.get('/studio/payouts');
    assert.match(page.text, /Waiting for review/);
    assert.ok(!page.text.includes('action="/studio/payouts/request"'), 'no second request form while one is open');
    assert.match(page.text, new RegExp(`action="/studio/payouts/${p.id}/cancel"`));
  });

  test('only one request can be open, and the service enforces it even if the page is bypassed', async () => {
    const r = await ashaC.post('/studio/payouts/request', { payout_amount: '500' });
    assert.equal(r.status, 409);
    assert.match(r.text, /already have a payout request open/);
    await assert.rejects(() => mon.requestPayout(asha.id, 50_000), (e) => e.status === 409);
    assert.equal((await payoutRows()).length, 1);
  });

  test('cancelling puts the amount back, once, and only the owner can cancel', async () => {
    const [p] = await payoutRows();
    const stranger = app.client();
    await createMember(app, stranger, { email: 'mal@example.com', handle: 'mallory', name: 'Mallory' });
    await stranger.post(`/studio/payouts/${p.id}/cancel`);
    assert.equal((await payoutRows())[0].status, 'requested', 'someone else cannot cancel it');
    await assert.rejects(() => mon.cancelPayout(ben.id, p.id), (e) => e.status === 409);

    const r = await ashaC.post(`/studio/payouts/${p.id}/cancel`);
    assert.equal(r.status, 303);
    assert.equal((await payoutRows())[0].status, 'cancelled');
    assert.equal((await balance()).available, 90_000);
    assert.equal((await entries('payout_reversal')).length, 1);
    await ashaC.post(`/studio/payouts/${p.id}/cancel`);
    assert.equal((await entries('payout_reversal')).length, 1, 'a second cancel adds nothing');
    assert.equal((await balance()).available, 90_000);
    assert.match((await ashaC.get('/studio/payouts')).text, /Cancelled/);
  });

  test('two requests at the same moment cannot both take the same money', async () => {
    const results = await Promise.allSettled([mon.requestPayout(asha.id, 90_000), mon.requestPayout(asha.id, 90_000), mon.requestPayout(asha.id, 90_000)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await balance()).available, 0);
    const open = (await payoutRows()).filter((p) => p.status === 'requested');
    assert.equal(open.length, 1);
  });

  test('staff can never approve, pay or decline their own request', async () => {
    // Make the creator an admin for a moment: the four-eyes rule must still hold.
    await makeAdmin(app, asha.id);
    const [open] = (await payoutRows()).filter((p) => p.status === 'requested');
    for (const act of [() => mon.approvePayout(open.id, asha.id), () => mon.markPayoutPaid(open.id, asha.id, 'UTR1'), () => mon.rejectPayout(open.id, asha.id, 'because'), () => mon.revealPayoutDetails(open.id, asha.id)]) {
      await assert.rejects(act, (e) => e.status === 409 || e.status === 404);
    }
    await app.ctx.db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [asha.id]);
    assert.equal((await payoutRows()).find((p) => p.id === open.id).status, 'requested');
  });

  test('approving, looking at the details (which is logged), and marking paid', async () => {
    const [open] = (await payoutRows()).filter((p) => p.status === 'requested');
    await mon.approvePayout(open.id, boss.id);
    assert.equal((await payoutRows()).find((p) => p.id === open.id).status, 'approved');
    await assert.rejects(() => mon.approvePayout(open.id, boss.id), (e) => e.status === 409);

    const seen = await mon.revealPayoutDetails(open.id, second.id);
    assert.deepEqual(seen, { method: 'upi', upi: 'asha.rao@okbank' });
    const log = await app.ctx.db.one(`SELECT actor_id, target_id FROM audit_log WHERE action = 'payout.reveal_details'`);
    assert.equal(log.actor_id, second.id);
    assert.equal(log.target_id, open.id);

    await assert.rejects(() => mon.markPayoutPaid(open.id, second.id, '  '), (e) => e.status === 422);
    await mon.markPayoutPaid(open.id, second.id, 'UTR-2026110412345');
    const paid = (await payoutRows()).find((p) => p.id === open.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paid_reference, 'UTR-2026110412345');
    assert.ok(paid.paid_at);

    const note = await app.ctx.db.one(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'payout' ORDER BY created_at DESC LIMIT 1`, [asha.id]);
    assert.deepEqual({ s: note.data.status, a: note.data.amountMinor }, { s: 'paid', a: 90_000 });
    const page = await ashaC.get('/studio/payouts');
    assert.match(page.text, /Paid/);
    assert.match(page.text, /UTR-2026110412345/);
    assert.equal((await mon.earnings(asha.id)).paidOut, 90_000);

    await assert.rejects(() => mon.markPayoutPaid(open.id, second.id, 'again'), (e) => e.status === 409);
    await assert.rejects(() => mon.rejectPayout(open.id, second.id, 'too late'), (e) => e.status === 409);
    await assert.rejects(() => mon.revealPayoutDetails(open.id, second.id), (e) => e.status === 404, 'details are not shown for finished payouts');
    assert.equal(await entries('payout_reversal').then((x) => x.length), 1, 'only the earlier cancel was reversed');
  });

  test('a declined request returns the money and tells the creator why', async () => {
    await tip(80_000); // +Rs 720
    app.clock.advance(8 * DAY);
    const id = await mon.requestPayout(asha.id, 50_000);
    await assert.rejects(() => mon.rejectPayout(id, boss.id, ''), (e) => e.status === 422);
    const before = (await balance()).available;
    await mon.rejectPayout(id, boss.id, 'The UPI address does not match your name.');
    assert.equal((await balance()).available, before + 50_000);
    const p = (await payoutRows()).find((x) => x.id === id);
    assert.equal(p.status, 'rejected');
    assert.equal(p.note, 'The UPI address does not match your name.');
    const page = await ashaC.get('/studio/payouts');
    assert.match(page.text, /Declined/);
    assert.match(page.text, /does not match your name/);
    const note = await app.ctx.db.one(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'payout' ORDER BY created_at DESC LIMIT 1`, [asha.id]);
    assert.equal(note.data.status, 'declined');
    const bell = await ashaC.get('/notifications');
    assert.match(bell.text, /payout of ₹500\.00 is now declined/);
  });

  test('the staff queue lists open requests oldest first, and filters by status', async () => {
    const id = await mon.requestPayout(asha.id, 50_000);
    const open = await mon.adminListPayouts({ status: 'open' });
    assert.deepEqual(open.items.map((x) => x.id), [id]);
    assert.equal(open.items[0].handle, 'asha');
    const paid = await mon.adminListPayouts({ status: 'paid' });
    assert.equal(paid.items.length, 1);
    assert.equal((await mon.adminListPayouts({ status: 'all' })).items.length, 4);
    assert.equal((await mon.adminListPayouts({ status: "paid' OR '1'='1" })).items.length, 1, 'an odd status value falls back safely');
    await mon.cancelPayout(asha.id, id);
  });

  test('payout details stored on a request do not change when the profile changes later', async () => {
    const id = await mon.requestPayout(asha.id, 50_000);
    app.clock.advance(HOUR);
    const r = await ashaC.post('/studio/payouts/details', { method: 'bank', holder: 'Asha Rao', account: '123456789012', ifsc: 'HDFC0001234', password: PASSWORD });
    assert.equal(r.status, 303);
    const seen = await mon.revealPayoutDetails(id, boss.id);
    assert.deepEqual(seen, { method: 'upi', upi: 'asha.rao@okbank' }, 'the request keeps the details it was made with');
    await mon.rejectPayout(id, boss.id, 'test cleanup');
    app.clock.advance(DETAILS_COOLOFF_MS);
  });

  test('balances always equal the sum of ledger entries, and the platform and creators add up to what was paid in', async () => {
    const all = (await app.ctx.db.query('SELECT * FROM ledger_entries')).rows;
    const sum = (rows) => rows.reduce((s, r) => s + Number(r.amount_minor), 0);
    const b = await balance();
    assert.equal(b.total, sum(all.filter((e) => e.user_id === asha.id)));
    const paidIn = Number((await app.ctx.db.one(`SELECT COALESCE(sum(amount_minor), 0) AS s FROM payments WHERE status = 'paid'`)).s);
    const paidOut = Number((await app.ctx.db.one(`SELECT COALESCE(sum(amount_minor), 0) AS s FROM payouts WHERE status = 'paid'`)).s);
    const owed = sum(all.filter((e) => e.user_id !== null));
    const platform = sum(all.filter((e) => e.user_id === null));
    assert.equal(paidIn, owed + platform + paidOut, 'every rupee paid in is either owed to a creator, kept as fee, or already paid out');
    const summary = await mon.platformSummary();
    assert.equal(summary.owedToCreators, owed);
    assert.equal(summary.platformEarned, platform);
  });

  test('an account with money or an open request cannot be deleted; settling it allows deletion and keeps the records', async () => {
    const blockers = await app.ctx.accounts.deletionBlockers(asha.id);
    assert.ok(blockers.some((b) => /money in your balance/.test(b)));
    const page = await ashaC.get('/settings/privacy');
    assert.match(page.text, /You cannot delete your account yet/);
    assert.ok(!page.text.includes('action="/settings/privacy/delete"'));
    const r = await ashaC.post('/settings/privacy/delete', { password: PASSWORD, confirm: 'DELETE' });
    assert.equal(r.status, 422);
    assert.equal((await app.ctx.db.one('SELECT status FROM users WHERE id = $1', [asha.id])).status, 'active');
  });
});
