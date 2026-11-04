import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers/app.js';
import { createMember, login, makeAdmin, PASSWORD } from './helpers/users.js';
import { parseLinks } from '../src/web/routes/settings.js';

const flashOf = (html) => /class="flash flash-(?:success|error|info)"[^>]*>([^<]*)</.exec(html)?.[1];
const errorsOf = (html) => [...html.matchAll(/class="field-error"[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('profile and viewing settings', () => {
  let app;
  let c;
  let me;

  before(async () => {
    app = await startTestApp();
    c = app.client();
    me = await createMember(app, c, { email: 'asha@example.com', handle: 'asha', name: 'Asha Verma' });
  });
  after(() => app.close());

  test('the settings pages are for signed-in people only, and send everyone else to sign in', async () => {
    const anon = app.client();
    for (const p of ['/settings', '/settings/profile', '/settings/security', '/settings/preferences', '/settings/privacy']) {
      const r = await anon.get(p);
      assert.equal(r.status, 303, p);
      assert.match(r.location, /^\/login/, p);
    }
    for (const p of ['/settings/profile', '/settings/preferences', '/settings/privacy/export', '/settings/privacy/delete']) {
      assert.equal((await anon.post(p, {})).status, 303, `POST ${p}`);
    }
    assert.equal((await c.get('/settings')).location, '/settings/profile');
  });

  test('a confirmation message appears once, at the top, on every settings page that shows one', async () => {
    // found by the browser test: "Saved." and the security page's confirmations were printed twice
    const count = (text) => (text.match(/class="flash flash-success"/g) ?? []).length;
    assert.equal((await c.post('/settings/preferences', { autoplay: '1', daily_limit: '' })).status, 303);
    assert.equal(count((await c.get('/settings/preferences')).text), 1, 'viewing settings');
    assert.equal((await c.post('/settings/profile', { display_name: 'Asha Verma', bio: '', avatar_hue: '17' })).status, 303);
    assert.equal(count((await c.get('/settings/profile')).text), 1, 'profile');
    assert.equal((await c.post('/settings/security/sessions/revoke-others', {})).status, 303);
    const security = (await c.get('/settings/security')).text;
    assert.equal(count(security), 1, 'password and security');
    assert.equal(count((await c.get('/settings/security')).text), 0, 'and it is gone on the next visit');
  });

  test('name, description, colour and links are saved, shown on the channel page, and shown back in the form', async () => {
    const r = await c.post('/settings/profile', {
      display_name: '  Asha   Verma Studio ',
      bio: 'Line one\r\nLine two\u0000 with a <b>tag</b>',
      avatar_hue: '17',
      link_label_1: 'My shop',
      link_url_1: 'https://shop.example.com/asha?ref=vv',
      link_label_2: 'Donate',
      link_url_2: 'https://pages.example.org/donate',
    });
    assert.equal(r.status, 303);
    const row = await app.ctx.db.one('SELECT display_name, bio, avatar_hue, support_links FROM users WHERE id = $1', [me.id]);
    assert.equal(row.display_name, 'Asha Verma Studio');
    assert.equal(row.bio, 'Line one\nLine two with a <b>tag</b>');
    assert.equal(row.avatar_hue, 17);
    assert.deepEqual(row.support_links, [{ label: 'My shop', url: 'https://shop.example.com/asha?ref=vv' }, { label: 'Donate', url: 'https://pages.example.org/donate' }]);
    const form = (await c.get('/settings/profile')).text;
    assert.match(flashOf(form) ?? '', /Saved\./);
    assert.ok(form.includes('value="Asha Verma Studio"') && form.includes('value="https://shop.example.com/asha?ref=vv"'));
    const page = (await app.client().get('/@asha/about')).text;
    assert.ok(page.includes('Asha Verma Studio'));
    assert.match(page, /<a href="https:\/\/shop\.example\.com\/asha\?ref=vv" target="_blank" rel="noopener noreferrer nofollow ugc">My shop<\/a>/);
    assert.ok(!page.includes('<b>tag</b>'), 'markup typed into a description is shown as text');
    assert.ok(page.includes('&lt;b&gt;tag&lt;/b&gt;'));
  });

  test('every rule is enforced on the server, the form keeps what was typed, and nothing is half-saved', async () => {
    const before = await app.ctx.db.one('SELECT display_name, bio, support_links FROM users WHERE id = $1', [me.id]);
    const cases = [
      [{ display_name: '' }, /name/i],
      [{ display_name: 'x'.repeat(51) }, /50|long/i],
      [{ bio: 'x'.repeat(1001) }, /1000|long/i],
      [{ link_label_1: 'Shop', link_url_1: 'http://insecure.example.com' }, /https/],
      [{ link_label_1: 'Shop', link_url_1: 'javascript:alert(1)' }, /https/],
      [{ link_label_1: 'Shop', link_url_1: 'https://user:pass@example.com/' }, /https/],
      [{ link_label_1: 'Shop', link_url_1: 'ftp://example.com/x' }, /https/],
      [{ link_label_1: 'Shop', link_url_1: '//example.com/x' }, /https/],
      [{ link_label_1: '', link_url_1: 'https://example.com/ok' }, /name/i],
      [{ link_label_1: 'x'.repeat(41), link_url_1: 'https://example.com/ok' }, /40|long/i],
    ];
    for (const [patch, expected] of cases) {
      const r = await c.post('/settings/profile', { display_name: 'Changed Name', bio: 'Changed bio', avatar_hue: '3', ...patch });
      assert.equal(r.status, 422, JSON.stringify(patch).slice(0, 60));
      assert.match(errorsOf(r.text).join(' | '), expected, JSON.stringify(patch).slice(0, 60));
    }
    const typed = await c.post('/settings/profile', { display_name: 'Typed Name', bio: 'Typed bio', avatar_hue: '3', link_label_1: 'Shop', link_url_1: 'http://nope.example.com' });
    assert.ok(typed.text.includes('value="Typed Name"') && typed.text.includes('Typed bio') && typed.text.includes('value="http://nope.example.com"'));
    assert.deepEqual(await app.ctx.db.one('SELECT display_name, bio, support_links FROM users WHERE id = $1', [me.id]), before);
  });

  test('colours outside the palette and fifth links are not accepted', async () => {
    for (const hue of ['-1', '36', 'abc', '1.5']) {
      assert.equal((await c.post('/settings/profile', { display_name: 'Asha', bio: '', avatar_hue: hue })).status, 422, hue);
    }
    const { links } = parseLinks({ link_label_1: 'a', link_url_1: 'https://a.example', link_label_2: 'b', link_url_2: 'https://b.example', link_label_3: 'c', link_url_3: 'https://c.example', link_label_4: 'd', link_url_4: 'https://d.example', link_label_5: 'e', link_url_5: 'https://e.example' });
    assert.equal(links.length, 4);
    assert.deepEqual(parseLinks({ link_label_1: '   ', link_url_1: '  ' }), { links: [], errors: {} });
  });

  test('autoplay and the daily reminder are saved; the reminder must be between 10 minutes and a day, or empty', async () => {
    assert.equal((await c.post('/settings/preferences', { daily_limit: '90' })).status, 303);
    let row = await app.ctx.db.one('SELECT autoplay, daily_limit_minutes FROM users WHERE id = $1', [me.id]);
    assert.deepEqual([row.autoplay, row.daily_limit_minutes], [false, 90], 'an unticked box means off');
    assert.equal((await c.post('/settings/preferences', { autoplay: '1', daily_limit: '' })).status, 303);
    row = await app.ctx.db.one('SELECT autoplay, daily_limit_minutes FROM users WHERE id = $1', [me.id]);
    assert.deepEqual([row.autoplay, row.daily_limit_minutes], [true, null]);
    for (const bad of ['5', '1441', 'abc', '10.5', '-30']) {
      const r = await c.post('/settings/preferences', { autoplay: '1', daily_limit: bad });
      assert.equal(r.status, 422, bad);
      assert.ok(errorsOf(r.text).length > 0, bad);
    }
    assert.equal((await app.ctx.db.one('SELECT daily_limit_minutes FROM users WHERE id = $1', [me.id])).daily_limit_minutes, null);
  });

  test('another person’s settings can not be changed by sending their id', async () => {
    const other = app.client();
    const them = await createMember(app, other, { email: 'rohan@example.com', handle: 'rohan', name: 'Rohan' });
    await c.post('/settings/profile', { display_name: 'Still Asha', bio: '', avatar_hue: '1', id: them.id, user_id: them.id, handle: 'rohan', email: 'x@y.co' });
    assert.equal((await app.ctx.db.one('SELECT display_name FROM users WHERE id = $1', [them.id])).display_name, 'Rohan');
    assert.deepEqual(await app.ctx.db.one('SELECT handle, email FROM users WHERE id = $1', [me.id]), { handle: 'asha', email: 'asha@example.com' });
  });
});

describe('downloading your data', () => {
  let app;
  let c;
  let me;
  let other;
  let oc;
  let fan;
  let fc;
  const MARK = { totp: 'TOTP-SECRET-CIPHERTEXT-MARKER', recovery: 'RECOVERY-CODE-HASH-MARKER', payout: 'PAYOUT-DETAILS-CIPHERTEXT-MARKER' };
  const q = (sql, params) => app.ctx.db.query(sql, params);

  before(async () => {
    app = await startTestApp();
    c = app.client();
    oc = app.client();
    fc = app.client();
    me = await createMember(app, c, { email: 'asha@example.com', handle: 'asha', name: 'Asha Verma' });
    other = await createMember(app, oc, { email: 'rohan.private@example.com', handle: 'rohan', name: 'Rohan' });
    fan = await createMember(app, fc, { email: 'fan.private@example.com', handle: 'fanny', name: 'Fanny' });
    const video = (id, owner, vis = 'public') => q(`INSERT INTO videos (id, owner_id, title, description, status, visibility, published_at, duration_ms) VALUES ($1, $2, $3, 'About ' || $3, 'ready', $4, now(), 60000)`, [id, owner, `Title ${id}`, vis]);
    await video('MINEPUBLIC1', me.id);
    await video('MINEPRIVATE', me.id, 'private');
    await video('THEIRVIDEO1', other.id);
    const mine = (await q(`INSERT INTO comments (video_id, user_id, body) VALUES ('THEIRVIDEO1', $1, 'My own comment') RETURNING id`, [me.id])).rows[0].id;
    await q(`INSERT INTO comments (video_id, user_id, body) VALUES ('MINEPUBLIC1', $1, 'Rohan comment on my video')`, [other.id]);
    await q(`INSERT INTO comments (video_id, user_id, parent_id, body) VALUES ('THEIRVIDEO1', $1, $2, 'Rohan reply to me')`, [other.id, mine]);
    await q(`INSERT INTO video_votes (user_id, video_id, value) VALUES ($1, 'THEIRVIDEO1', 1), ($2, 'MINEPUBLIC1', 1)`, [me.id, other.id]);
    await q(`INSERT INTO subscriptions (subscriber_id, channel_id, notify) VALUES ($1, $2, true), ($3, $1, false)`, [me.id, other.id, fan.id]);
    await q(`INSERT INTO watch_later (user_id, video_id) VALUES ($1, 'THEIRVIDEO1')`, [me.id]);
    await q(`INSERT INTO watch_history (user_id, video_id, position_ms, watched_ms) VALUES ($1, 'THEIRVIDEO1', 30000, 45000)`, [me.id]);
    await q(`INSERT INTO user_watch_days (user_id, day, watch_ms) VALUES ($1, '2026-11-03', 600000)`, [me.id]);
    await q(`INSERT INTO notifications (user_id, kind, data) VALUES ($1, 'comment', '{"note":"someone commented"}')`, [me.id]);
    await q(`INSERT INTO contact_messages (user_id, email, subject, body) VALUES ($1, 'asha@example.com', 'Hello', 'A message to support')`, [me.id]);
    await q(`INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1, 'video', 'THEIRVIDEO1', 'spam', 'looks like spam')`, [me.id]);
    await q(`INSERT INTO payments (payer_id, channel_id, video_id, amount_minor, currency, fee_minor, net_minor, provider, status, message, anonymous, paid_at) VALUES ($1, $2, 'THEIRVIDEO1', 10000, 'INR', 1000, 9000, 'test', 'paid', 'Great work', false, now())`, [me.id, other.id]);
    await q(`INSERT INTO payments (payer_id, channel_id, amount_minor, currency, fee_minor, net_minor, provider, status, message, anonymous, paid_at) VALUES ($1, $2, 5000, 'INR', 500, 4500, 'test', 'paid', 'Secret admirer note', true, now())`, [fan.id, me.id]);
    await q(`INSERT INTO payments (payer_id, channel_id, amount_minor, currency, fee_minor, net_minor, provider, status, message, anonymous, paid_at) VALUES ($1, $2, 3000, 'INR', 300, 2700, 'test', 'paid', 'Named supporter', false, now())`, [other.id, me.id]);
    await q(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'tip_net', 4500, 'INR', now(), 'payment', 'p1')`, [`user:${me.id}`, me.id]);
    await q(`INSERT INTO payout_profiles (user_id, method, details_enc, display_hint) VALUES ($1, 'upi', $2, 'as••••@okbank')`, [me.id, MARK.payout]);
    await q(`INSERT INTO payouts (user_id, amount_minor, currency, status, method, details_enc, display_hint) VALUES ($1, 1000, 'INR', 'rejected', 'upi', $2, 'as••••@okbank')`, [me.id, MARK.payout]);
    await q(`UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now(), recovery_codes = $3::jsonb WHERE id = $1`, [me.id, MARK.totp, JSON.stringify([{ hash: MARK.recovery, used: false }])]);
    await q(`UPDATE users SET support_links = '[{"label":"Shop","url":"https://shop.example.com/"}]'::jsonb, bio = 'Bio text' WHERE id = $1`, [me.id]);
  });
  after(() => app.close());

  const exportJson = async (client = c) => {
    const r = await client.post('/settings/privacy/export', {});
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return { r, data: JSON.parse(r.text) };
  };

  test('is a file download that nothing may keep a copy of, named for the site and the day', async () => {
    const { r, data } = await exportJson();
    assert.match(r.header('content-type'), /^application\/json; charset=utf-8/);
    assert.equal(r.header('content-disposition'), 'attachment; filename="vidverse-data-2026-11-04.json"');
    assert.match(r.header('cache-control'), /no-store/);
    assert.equal(data.format, 'vidverse-export-1');
    assert.equal(data.exportedAt, '2026-11-04T10:00:00.000Z');
  });

  test('has what the site holds about the person: account, videos, comments, reactions, history, messages and money', async () => {
    const { data } = await exportJson();
    assert.deepEqual([data.account.email, data.account.handle, data.account.display_name, data.account.bio], ['asha@example.com', 'asha', 'Asha Verma', 'Bio text']);
    assert.equal(data.account.two_step_enabled, true);
    assert.equal(data.account.subscribers, 1);
    assert.deepEqual(data.account.support_links, [{ label: 'Shop', url: 'https://shop.example.com/' }]);
    assert.deepEqual(data.videos.map((v) => v.id).sort(), ['MINEPRIVATE', 'MINEPUBLIC1'], 'private videos too: they are theirs');
    assert.deepEqual(data.comments.map((x) => x.body), ['My own comment']);
    assert.deepEqual(data.likes_and_dislikes.map((v) => [v.video_id, v.value]), [['THEIRVIDEO1', 1]]);
    assert.deepEqual(data.subscriptions.map((s) => [s.channel_handle, s.notify]), [['rohan', true]]);
    assert.deepEqual(data.saved_for_later.map((s) => s.video_id), ['THEIRVIDEO1']);
    assert.deepEqual(data.watch_history.map((h) => [h.video_id, h.position_ms, h.watched_ms]), [['THEIRVIDEO1', 30000, 45000]]);
    assert.equal(Number(data.watch_time_by_day[0].watch_ms), 600000);
    assert.equal(data.notifications.length, 1);
    assert.deepEqual(data.messages_to_support.map((m) => m.subject), ['Hello']);
    assert.deepEqual(data.reports_you_filed.map((x) => x.reason), ['spam']);
    assert.equal(data.signed_in_devices.length, 1);
    assert.ok(data.security_and_account_actions.some((a) => a.action === 'auth.login' || /login|signup|verify/.test(a.action)), JSON.stringify(data.security_and_account_actions.map((a) => a.action)));
    assert.deepEqual(data.money.tips_you_sent.map((t) => [Number(t.amount_minor), t.message]), [[10000, 'Great work']]);
    assert.equal(data.money.balance_entries.length, 1);
    assert.equal(data.money.payouts.length, 1);
    assert.deepEqual([data.money.payout_details.method, data.money.payout_details.display_hint], ['upi', 'as••••@okbank']);
  });

  test('leaves out secrets, other people’s details and anything that is not about this person', async () => {
    const { r } = await exportJson();
    const text = r.text;
    const hash = (await app.ctx.db.one('SELECT password_hash FROM users WHERE id = $1', [me.id])).password_hash;
    for (const secret of [hash, MARK.totp, MARK.recovery, MARK.payout, 'password_hash', 'totp_secret', 'recovery_codes', 'details_enc']) assert.ok(!text.includes(secret), `the export contains ${secret}`);
    assert.ok(!/"id":\s*"[0-9a-f]{64}"/.test(text), 'no session identifiers');
    for (const private_ of ['rohan.private@example.com', 'fan.private@example.com', 'Rohan comment on my video', 'Rohan reply to me']) assert.ok(!text.includes(private_), `the export contains ${private_}`);
    const { data } = await exportJson();
    const received = data.money.tips_you_received;
    assert.equal(received.length, 2);
    const anonymous = received.find((t) => t.message === 'Secret admirer note');
    assert.equal(anonymous.from_handle, null, 'an anonymous tip stays anonymous, even to the person who got it');
    assert.equal(received.find((t) => t.message === 'Named supporter').from_handle, 'rohan');
    assert.ok(data.signed_in_devices.every((d) => !('token' in d) && !('id' in d)));
  });

  test('is available to the signed-in person about themselves only', async () => {
    assert.equal((await app.client().post('/settings/privacy/export', {})).status, 303);
    assert.equal((await c.post('/settings/privacy/export', { id: other.id, user_id: other.id }, { csrf: false })).status, 403, 'a form without a token is refused');
    const { data } = await exportJson(oc);
    assert.equal(data.account.handle, 'rohan');
    assert.ok(!JSON.stringify(data).includes('asha@example.com'));
    assert.equal((await app.ctx.db.one(`SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'user.export'`, [me.id])).n >= 3, true, 'each export is on record');
  });

  test('three an hour, so the export cannot be used to hammer the database', async () => {
    const limited = await startTestApp({ env: { RATE_LIMITS: 'true' } });
    try {
      const lc = limited.client();
      await createMember(limited, lc, { email: 'a@example.com', handle: 'aaaa' });
      for (let i = 0; i < 3; i++) assert.equal((await lc.post('/settings/privacy/export', {})).status, 200, `export ${i}`);
      assert.equal((await lc.post('/settings/privacy/export', {})).status, 429);
    } finally {
      await limited.close();
    }
  });
});

describe('deleting an account', () => {
  let app;
  const q = (sql, params) => app.ctx.db.query(sql, params);
  const one = (sql, params) => app.ctx.db.one(sql, params);
  const count = async (sql, params) => Number((await one(`SELECT count(*)::int AS n FROM (${sql}) t`, params)).n);

  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  const video = (id, owner, title = `Title ${id}`) => q(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at, duration_ms) VALUES ($1, $2, $3, 'ready', 'public', now(), 60000)`, [id, owner, title]);
  const del = (client, fields = {}) => client.post('/settings/privacy/delete', { password: PASSWORD, confirm: 'DELETE', ...fields });

  describe('what stops it', () => {
    let c;
    let me;
    before(async () => {
      c = app.client();
      me = await createMember(app, c, { email: 'blocked@example.com', handle: 'blocked' });
    });

    test('a wrong password or a missing DELETE changes nothing', async () => {
      for (const fields of [{ password: 'wrong password here' }, { confirm: 'delete' }, { confirm: '' }, { password: '' }]) {
        const r = await del(c, fields);
        assert.equal(r.status, 422, JSON.stringify(fields));
        assert.ok(errorsOf(r.text).length > 0, JSON.stringify(fields));
      }
      assert.equal((await one('SELECT status FROM users WHERE id = $1', [me.id])).status, 'active');
      assert.equal((await c.get('/settings/privacy')).status, 200, 'still signed in');
    });

    test('money in the balance stops it, and the page says why', async () => {
      await q(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'tip_net', 4500, 'INR', now(), 'payment', 'b1')`, [`user:${me.id}`, me.id]);
      const page = await c.get('/settings/privacy');
      assert.match(page.text, /You still have money in your balance/);
      const r = await del(c);
      assert.equal(r.status, 422);
      assert.match(r.text, /You still have money in your balance/);
      assert.equal((await one('SELECT status FROM users WHERE id = $1', [me.id])).status, 'active');
    });

    test('a payout that is not finished stops it, even when the balance is zero', async () => {
      await q(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'payout_request', -4500, 'INR', now(), 'payout', 'b2')`, [`user:${me.id}`, me.id]);
      await q(`INSERT INTO payouts (user_id, amount_minor, currency, status, method, details_enc, display_hint) VALUES ($1, 4500, 'INR', 'requested', 'upi', 'x', 'hint')`, [me.id]);
      const r = await del(c);
      assert.equal(r.status, 422);
      assert.match(r.text, /payout request that is not finished/);
      await q(`UPDATE payouts SET status = 'paid', paid_at = now() WHERE user_id = $1`, [me.id]);
      assert.deepEqual(await app.ctx.accounts.deletionBlockers(me.id), [], 'once it is paid the way is clear');
    });

    test('the only administrator can not delete themselves and leave the site without one', async () => {
      const ac = app.client();
      const admin = await createMember(app, ac, { email: 'boss@example.com', handle: 'boss' });
      await makeAdmin(app, admin.id);
      const r = await del(ac);
      assert.equal(r.status, 422);
      assert.match(r.text, /only administrator/);
      const spare = await createMember(app, app.client(), { email: 'second@example.com', handle: 'second', signIn: false });
      await makeAdmin(app, spare.id);
      assert.equal((await del(ac)).status, 303);
    });
  });

  describe('what it does', () => {
    let c;
    let leaver;
    let oc;
    let other;
    let fc;
    let fan;
    const FILE = (id) => path.join(app.ctx.storage.videoDir(id), 'source.bin');

    before(async () => {
      c = app.client();
      oc = app.client();
      fc = app.client();
      leaver = await createMember(app, c, { email: 'leaver@example.com', handle: 'leaver', name: 'Leaving Person' });
      other = await createMember(app, oc, { email: 'stays@example.com', handle: 'stays', name: 'Staying Person' });
      fan = await createMember(app, fc, { email: 'fan@example.com', handle: 'thefan', name: 'The Fan' });
      await video('LEAVERVID01', leaver.id, 'Leaver video');
      await video('STAYSVIDEO1', other.id, 'Staying video');
      for (const id of ['LEAVERVID01']) {
        fs.mkdirSync(app.ctx.storage.videoDir(id), { recursive: true });
        fs.writeFileSync(FILE(id), 'bytes');
      }
      const mine = (await q(`INSERT INTO comments (video_id, user_id, body) VALUES ('STAYSVIDEO1', $1, 'Leaver comment') RETURNING id`, [leaver.id])).rows[0].id;
      await q(`INSERT INTO comments (video_id, user_id, parent_id, body) VALUES ('STAYSVIDEO1', $1, $2, 'Reply to the leaver')`, [other.id, mine]);
      await q(`INSERT INTO comments (video_id, user_id, body) VALUES ('LEAVERVID01', $1, 'Comment under the leaver video')`, [other.id]);
      await q(`INSERT INTO comments (video_id, user_id, body) VALUES ('STAYSVIDEO1', $1, 'Unrelated comment that stays')`, [fan.id]);
      await q(`INSERT INTO video_votes (user_id, video_id, value) VALUES ($1, 'STAYSVIDEO1', 1), ($2, 'STAYSVIDEO1', 1)`, [leaver.id, fan.id]);
      await q(`UPDATE videos SET likes = 2, comment_count = 3 WHERE id = 'STAYSVIDEO1'`);
      await q(`INSERT INTO subscriptions (subscriber_id, channel_id) VALUES ($1, $2), ($3, $1)`, [leaver.id, other.id, fan.id]);
      await q(`INSERT INTO watch_history (user_id, video_id) VALUES ($1, 'STAYSVIDEO1')`, [leaver.id]);
      await q(`INSERT INTO watch_later (user_id, video_id) VALUES ($1, 'STAYSVIDEO1')`, [leaver.id]);
      await q(`INSERT INTO user_watch_days (user_id, day, watch_ms) VALUES ($1, '2026-11-03', 1000)`, [leaver.id]);
      await q(`INSERT INTO notifications (user_id, kind) VALUES ($1, 'policy')`, [leaver.id]);
      await q(`INSERT INTO contact_messages (user_id, email, subject, body) VALUES ($1, 'leaver@example.com', 'Hi', 'Message body'), (NULL, 'LEAVER@example.com', 'From before signing up', 'Another body')`, [leaver.id]);
      await q(`INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, 'video', 'STAYSVIDEO1', 'spam')`, [leaver.id]);
      await q(`INSERT INTO payments (id, payer_id, channel_id, video_id, amount_minor, currency, fee_minor, net_minor, provider, status, message, anonymous, paid_at) VALUES ('11111111-1111-4111-8111-111111111111', $1, $2, 'STAYSVIDEO1', 10000, 'INR', 1000, 9000, 'test', 'paid', 'Great work', false, now())`, [leaver.id, other.id]);
      await q(`INSERT INTO payments (id, payer_id, channel_id, video_id, amount_minor, currency, fee_minor, net_minor, provider, status, message, anonymous, paid_at) VALUES ('22222222-2222-4222-8222-222222222222', $1, $2, 'LEAVERVID01', 5000, 'INR', 500, 4500, 'test', 'paid', 'For the leaver', false, now())`, [fan.id, leaver.id]);
      await q(`INSERT INTO ledger_entries (account, user_id, kind, amount_minor, currency, available_at, ref_type, ref_id) VALUES ($1, $2, 'tip_net', 4500, 'INR', now(), 'payment', '22222222-2222-4222-8222-222222222222'), ($1, $2, 'payout_request', -4500, 'INR', now(), 'payout', 'old')`, [`user:${leaver.id}`, leaver.id]);
      await q(`INSERT INTO payout_profiles (user_id, method, details_enc, display_hint) VALUES ($1, 'upi', 'ENCRYPTED', 'le••••@okbank')`, [leaver.id]);
      await q(`INSERT INTO payouts (user_id, amount_minor, currency, status, method, details_enc, display_hint, paid_at, paid_reference) VALUES ($1, 4500, 'INR', 'paid', 'upi', 'ENCRYPTED', 'le••••@okbank', now(), 'UTR123')`, [leaver.id]);
      await q(`UPDATE users SET totp_secret_enc = 'ENC', totp_enabled_at = now(), recovery_codes = '[{"hash":"h","used":false}]'::jsonb, bio = 'Some bio', support_links = '[{"label":"Shop","url":"https://shop.example.com/"}]'::jsonb WHERE id = $1`, [leaver.id]);
      await q('INSERT INTO email_tokens (id, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + interval \'1 day\')', ['a'.repeat(64), leaver.id, 'reset']).catch(() => {});
    });

    test('with the right password and the word DELETE, the person is signed out and told', async () => {
      assert.equal(fs.existsSync(FILE('LEAVERVID01')), true);
      const sessionCookie = c.cookie('__Host-vv_sid');
      const r = await del(c);
      assert.equal(r.status, 303);
      assert.equal(r.location, '/');
      assert.equal(c.cookie('__Host-vv_sid'), undefined, 'the session cookie is cleared');
      const stale = app.client();
      stale.setCookie('__Host-vv_sid', sessionCookie);
      assert.equal((await stale.get('/settings/profile')).status, 303, 'the old cookie no longer works');
      assert.match(flashOf((await c.get('/')).text) ?? '', /Your account has been deleted/);
    });

    test('the account is left as an empty marker: no name, no email, no password, no secrets', async () => {
      const u = await one('SELECT * FROM users WHERE id = $1', [leaver.id]);
      assert.equal(u.status, 'deleted');
      assert.equal(u.display_name, 'Deleted account');
      assert.match(u.email, /^deleted-[0-9a-f-]{36}@deleted\.invalid$/);
      assert.match(u.handle, /^deleted-[0-9a-f]{10}$/);
      assert.equal(u.password_hash, '!');
      for (const col of ['bio']) assert.equal(u[col], '');
      assert.deepEqual([u.email_verified_at, u.totp_secret_enc, u.totp_enabled_at, u.suspended_reason], [null, null, null, null]);
      assert.deepEqual([u.recovery_codes, u.support_links], [[], []]);
      assert.ok(u.deleted_at);
      assert.equal(await count('SELECT 1 FROM sessions WHERE user_id = $1', [leaver.id]), 0);
      assert.equal(await count('SELECT 1 FROM email_tokens WHERE user_id = $1', [leaver.id]), 0);
    });

    test('their videos, the files behind them, and everything on those videos are gone', async () => {
      assert.equal(await count(`SELECT 1 FROM videos WHERE owner_id = $1`, [leaver.id]), 0);
      assert.equal(fs.existsSync(app.ctx.storage.videoDir('LEAVERVID01')), false, 'the files on disk are removed too');
      assert.equal(await count(`SELECT 1 FROM comments WHERE video_id = 'LEAVERVID01'`), 0);
      assert.equal((await c.get('/watch/LEAVERVID01')).status, 404);
      assert.equal((await app.client().get('/@leaver')).status, 404);
    });

    test('what they wrote or did on other people’s pages is removed, and the counts there are put right', async () => {
      assert.equal(await count(`SELECT 1 FROM comments WHERE user_id = $1`, [leaver.id]), 0);
      assert.equal(await count(`SELECT 1 FROM comments WHERE body = 'Reply to the leaver'`), 0, 'the replies under a removed comment go with it');
      assert.equal(await count(`SELECT 1 FROM comments WHERE body = 'Unrelated comment that stays'`), 1);
      const v = await one(`SELECT likes, comment_count FROM videos WHERE id = 'STAYSVIDEO1'`);
      assert.deepEqual([v.likes, v.comment_count], [1, 1], 'counted again from what is left, not guessed');
      for (const t of ['video_votes', 'watch_history', 'watch_later', 'user_watch_days', 'notifications']) assert.equal(await count(`SELECT 1 FROM ${t} WHERE user_id = $1`, [leaver.id]), 0, t);
      assert.equal(await count('SELECT 1 FROM subscriptions WHERE subscriber_id = $1 OR channel_id = $1', [leaver.id]), 0);
      assert.equal(await count(`SELECT 1 FROM contact_messages WHERE lower(email) = 'leaver@example.com' OR user_id = $1`, [leaver.id]), 0, 'including a message sent before the account existed');
      assert.deepEqual(await one(`SELECT reporter_id FROM reports WHERE target_id = 'STAYSVIDEO1'`), { reporter_id: null }, 'the report stays, so moderators can still act on it, but it no longer names anyone');
    });

    test('money records the law makes us keep are kept without the person', async () => {
      const sent = await one(`SELECT payer_id, anonymous, message, amount_minor FROM payments WHERE id = '11111111-1111-4111-8111-111111111111'`);
      assert.deepEqual([sent.payer_id, sent.anonymous, sent.message, Number(sent.amount_minor)], [null, true, null, 10000]);
      const got = await one(`SELECT channel_id, video_id, amount_minor FROM payments WHERE id = '22222222-2222-4222-8222-222222222222'`);
      assert.deepEqual([got.channel_id, got.video_id, Number(got.amount_minor)], [leaver.id, null, 5000]);
      assert.equal(await count('SELECT 1 FROM ledger_entries WHERE user_id = $1', [leaver.id]), 2, 'the ledger is append-only');
      assert.equal(await count('SELECT 1 FROM payout_profiles WHERE user_id = $1', [leaver.id]), 0, 'bank or UPI details are deleted');
      const payout = await one('SELECT details_enc, display_hint, paid_reference, amount_minor FROM payouts WHERE user_id = $1', [leaver.id]);
      assert.deepEqual([payout.details_enc, payout.display_hint, payout.paid_reference, Number(payout.amount_minor)], ['', 'removed', 'UTR123', 4500]);
    });

    test('the deletion is on record, other people are untouched, and the address and handle can be used again', async () => {
      assert.equal(await count(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'user.delete'`, [leaver.id]), 1);
      assert.deepEqual(await one('SELECT display_name, email, status FROM users WHERE id = $1', [other.id]), { display_name: 'Staying Person', email: 'stays@example.com', status: 'active' });
      assert.equal((await login(app.client(), 'leaver@example.com')).status, 401, 'the old password no longer signs anyone in');
      const again = app.client();
      const fresh = await createMember(app, again, { email: 'leaver@example.com', handle: 'leaver', name: 'New Person' });
      assert.notEqual(fresh.id, leaver.id);
    });

    test('doing it twice, or from a stale page, is harmless', async () => {
      const second = await del(c);
      assert.equal(second.status, 303);
      assert.match(second.location, /^\/login/);
      assert.equal(await count(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'user.delete'`, [leaver.id]), 1);
    });
  });
});
