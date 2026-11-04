import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, lastMail, login, totpCodeNow, PASSWORD } from './helpers/users.js';
import { sha256Hex } from '../src/lib/crypto.js';

const MIN = 60_000;
const DAY = 86_400_000;
const COOKIE = '__Host-vv_sid';
const errorText = (html) => /class="flash flash-error"[^>]*>([^<]*)</.exec(html)?.[1] ?? /class="field-error"[^>]*>([^<]*)</.exec(html)?.[1];
let counter = 0;
const nextEmail = () => `person${++counter}@example.com`;

describe('sign-up and email confirmation', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  const form = (over = {}) => ({ displayName: 'Meera Joshi', handle: 'meera.j', email: 'meera@example.com', password: PASSWORD, adult: '1', terms: '1', ...over });

  test('a new account starts unconfirmed; the password is stored only as a hash and the emailed token only as a digest', async () => {
    const c = app.client();
    const r = await c.post('/signup', form());
    assert.equal(r.status, 200);
    assert.match(r.text, /Check your inbox/);
    const u = await app.ctx.db.one(`SELECT * FROM users WHERE email = 'meera@example.com'`);
    assert.equal(u.email_verified_at, null);
    assert.ok(!u.password_hash.includes(PASSWORD) && u.password_hash.length > 40);
    const mail = lastMail(app, 'meera@example.com', /verify-email/);
    const token = /verify-email\?token=([\w-]+)/.exec(mail.text)[1];
    const row = await app.ctx.db.one('SELECT token_hash FROM email_tokens WHERE user_id = $1', [u.id]);
    assert.equal(row.token_hash, sha256Hex(token));
    assert.notEqual(row.token_hash, token);
    assert.equal((await app.ctx.db.one(`SELECT terms_version FROM users WHERE id = $1`, [u.id])).terms_version, app.ctx.auth.LEGAL_VERSION);
  });

  test('signing in is refused until the address is confirmed, and says why', async () => {
    const c = app.client();
    const r = await login(c, 'meera@example.com');
    assert.equal(r.status, 401);
    assert.match(r.text, /Confirm your email address first/);
    assert.equal(c.cookie(COOKIE), undefined, 'no session was started');
  });

  test('opening the link does not use it up (mail scanners open links); pressing the button does, once', async () => {
    const c = app.client();
    const token = /verify-email\?token=([\w-]+)/.exec(lastMail(app, 'meera@example.com', /verify-email/).text)[1];
    assert.equal((await c.get(`/verify-email?token=${token}`)).status, 200);
    assert.equal((await c.get(`/verify-email?token=${token}`)).status, 200, 'still valid after being opened');
    const ok = await c.post('/verify-email', { token });
    assert.equal(ok.status, 303);
    assert.equal(ok.location, '/login');
    assert.equal((await c.post('/verify-email', { token })).status, 400, 'a second use fails');
    assert.equal((await c.get(`/verify-email?token=${token}`)).status, 400);
    assert.equal((await login(c, 'meera@example.com')).status, 303);
  });

  test('tokens that are made up, too short or from the wrong purpose are refused', async () => {
    const c = app.client();
    for (const t of ['', 'abc', 'x'.repeat(43), 'a'.repeat(300)]) assert.equal((await c.post('/verify-email', { token: t })).status, 400, t.slice(0, 10));
    await c.post('/forgot-password', { email: 'meera@example.com' });
    const resetToken = /reset-password\?token=([\w-]+)/.exec(lastMail(app, 'meera@example.com', /reset-password/).text)[1];
    assert.equal((await c.post('/verify-email', { token: resetToken })).status, 400, 'a reset token cannot confirm an address');
  });

  test('a confirmation link expires after a day', async () => {
    const c = app.client();
    await c.post('/signup', form({ handle: 'slow.one', email: 'slow@example.com' }));
    const token = /verify-email\?token=([\w-]+)/.exec(lastMail(app, 'slow@example.com', /verify-email/).text)[1];
    app.clock.advance(25 * 60 * MIN);
    assert.equal((await c.post('/verify-email', { token })).status, 400);
    await c.post('/resend-verification-public', { email: 'slow@example.com' });
    const fresh = /verify-email\?token=([\w-]+)/.exec(lastMail(app, 'slow@example.com', /verify-email/).text)[1];
    assert.notEqual(fresh, token);
    assert.equal((await c.post('/verify-email', { token: fresh })).status, 303);
  });

  test('signing up again with an address that has an account looks identical and creates nothing', async () => {
    const before = (await app.ctx.db.one('SELECT count(*)::int AS n FROM users')).n;
    const c = app.client();
    const r = await c.post('/signup', form({ handle: 'someone.else' }));
    assert.equal(r.status, 200);
    assert.match(r.text, /Check your inbox/);
    assert.equal((await app.ctx.db.one('SELECT count(*)::int AS n FROM users')).n, before);
    assert.match(lastMail(app, 'meera@example.com').subject + lastMail(app, 'meera@example.com').text, /already|account/i, 'the owner is told by email');
  });

  test('every rule on the form is enforced on the server', async () => {
    const c = app.client();
    const cases = [
      [{ password: 'short1!' }, /at least 10/],
      [{ password: 'password' }, /common|at least 10/],
      [{ password: 'qwertyuiop' }, /common/],
      [{ email: 'kavita.rao@example.com', password: 'my-kavita.rao-pass-2026' }, /email name/],
      [{ password: 'a'.repeat(200) }, /at most 128/],
      [{ handle: 'ab' }, /./],
      [{ handle: 'admin' }, /./],
      [{ handle: 'has space' }, /./],
      [{ handle: 'meera.j' }, /taken/],
      [{ handle: 'MEERA.J' }, /taken/],
      [{ email: 'not-an-email' }, /valid email/],
      [{ displayName: '   ' }, /required/],
      [{ displayName: 'x'.repeat(51) }, /at most 50/],
      [{ adult: undefined }, /18 or older/],
      [{ terms: undefined }, /Terms/],
    ];
    for (const [over, expected] of cases) {
      const fields = { ...form({ email: nextEmail(), handle: `ok${++counter}x` }), ...over };
      for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
      const r = await c.post('/signup', fields);
      assert.equal(r.status, 422, JSON.stringify(over));
      assert.match(r.text, expected, JSON.stringify(over));
    }
    assert.equal((await app.ctx.db.query(`SELECT 1 FROM users WHERE handle = 'admin'`)).rows.length, 0);
  });

  test('every mistake is shown at once: a weak password is named even while a box is unticked', async () => {
    // found by the browser test: the password rule used to appear only after the unticked boxes were fixed
    const fields = form({ email: nextEmail(), handle: `allatonce${++counter}`, password: 'short' });
    delete fields.adult;
    delete fields.terms;
    const r = await app.client().post('/signup', fields);
    assert.equal(r.status, 422);
    assert.match(r.text, /at least 10 characters/);
    assert.match(r.text, /18 or older/);
    assert.match(r.text, /Accept the Terms/);
    // and a password that mentions the person's own email name is caught in the same pass
    const second = form({ email: 'rajesh.kumar@example.com', handle: `own${++counter}x`, password: 'rajesh.kumar-2026-ok' });
    delete second.adult;
    const r2 = await app.client().post('/signup', second);
    assert.equal(r2.status, 422);
    assert.match(r2.text, /email name/);
  });

  test('the form keeps what was typed (except the password) when it has a problem', async () => {
    const r = await app.client().post('/signup', form({ email: 'keep@example.com', handle: 'keepme', displayName: 'Keep <Me>', password: 'short' }));
    assert.equal(r.status, 422);
    assert.ok(r.text.includes('value="keep@example.com"'));
    assert.ok(r.text.includes('value="Keep &lt;Me&gt;"'));
    assert.ok(!r.text.includes('value="short"'));
  });
});

describe('signing in, locking and signing out', () => {
  let app;
  let c;
  let me;
  before(async () => {
    app = await startTestApp();
    c = app.client();
    me = await createMember(app, c, { email: 'ravi@example.com', handle: 'ravi', signIn: false });
  });
  after(() => app.close());

  test('the same message is shown for a wrong password and for an address that has no account', async () => {
    const wrong = await login(app.client(), 'ravi@example.com', 'wrong password here');
    const unknown = await login(app.client(), 'nobody@example.com', 'wrong password here');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(errorText(wrong.text), errorText(unknown.text));
    assert.ok(errorText(wrong.text));
  });

  test('five wrong passwords lock the account for a minute, and the right password does not unlock it early', async () => {
    const other = app.client();
    for (let i = 0; i < 5; i++) assert.equal((await login(other, 'ravi@example.com', `wrong password ${i}`)).status, 401);
    const locked = await login(other, 'ravi@example.com');
    assert.equal(locked.status, 401, 'the correct password is refused while locked');
    assert.equal(errorText(locked.text), errorText((await login(other, 'ravi@example.com', 'nope nope nope')).text), 'locked looks the same as wrong');
    app.clock.advance(61_000);
    assert.equal((await login(other, 'ravi@example.com')).status, 303, 'works after the wait');
    const u = await app.ctx.db.one('SELECT failed_logins, locked_until FROM users WHERE id = $1', [me.id]);
    assert.deepEqual({ f: u.failed_logins, l: u.locked_until }, { f: 0, l: null }, 'a good sign-in clears the count');
  });

  test('the lock grows when someone keeps guessing after each wait: 1, 2, then 4 minutes', async () => {
    const other = app.client();
    const lockMinutes = async () => (new Date((await app.ctx.db.one('SELECT locked_until FROM users WHERE id = $1', [me.id])).locked_until) - app.clock.now()) / MIN;
    for (let i = 0; i < 5; i++) await login(other, 'ravi@example.com', `bad password ${i}`);
    assert.equal(await lockMinutes(), 1);
    for (let i = 0; i < 3; i++) await login(other, 'ravi@example.com', `guess during the lock ${i}`);
    assert.equal(await lockMinutes(), 1, 'guesses while locked do not make it longer (and are not checked)');
    app.clock.advance(MIN + 1000);
    await login(other, 'ravi@example.com', 'another bad guess');
    assert.equal(await lockMinutes(), 2);
    app.clock.advance(2 * MIN + 1000);
    await login(other, 'ravi@example.com', 'and another bad guess');
    assert.equal(await lockMinutes(), 4);
    app.clock.advance(4 * MIN + 1000);
    assert.equal((await login(other, 'ravi@example.com')).status, 303);
  });

  test('the session cookie is __Host- prefixed, HttpOnly, Secure and SameSite, and only a digest is stored', async () => {
    const fresh = app.client();
    const r = await login(fresh, 'ravi@example.com');
    const header = r.headers.getSetCookie().find((l) => l.startsWith(`${COOKIE}=`));
    assert.ok(header, 'a session cookie was set');
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(part), part);
    assert.ok(!/Domain=/i.test(header), 'no Domain attribute (required by the __Host- prefix)');
    const token = fresh.cookie(COOKIE);
    assert.ok((await app.ctx.db.one('SELECT 1 AS x FROM sessions WHERE id = $1', [sha256Hex(token)])));
    assert.equal((await app.ctx.db.query('SELECT 1 FROM sessions WHERE id = $1', [token])).rows.length, 0, 'the cookie value itself is not in the table');
  });

  test('a session id set before sign-in is not kept (no session fixation)', async () => {
    const fresh = app.client();
    fresh.setCookie(COOKIE, 'A'.repeat(43));
    await login(fresh, 'ravi@example.com');
    assert.notEqual(fresh.cookie(COOKIE), 'A'.repeat(43));
    assert.equal((await fresh.get('/settings/profile')).status, 200);
  });

  test('signing out ends the session on the server, so a copied cookie stops working', async () => {
    const a = app.client();
    await login(a, 'ravi@example.com');
    const stolen = a.cookie(COOKIE);
    assert.equal((await a.get('/settings/profile')).status, 200);
    assert.equal((await a.post('/logout')).status, 303);
    const thief = app.client();
    thief.setCookie(COOKIE, stolen);
    const r = await thief.get('/settings/profile');
    assert.equal(r.status, 303);
    assert.match(r.location, /^\/login/);
  });

  test('a signed-out request needs a CSRF token, and one from another session is refused', async () => {
    const a = app.client();
    assert.equal((await a.post('/login', { email: 'ravi@example.com', password: PASSWORD }, { csrf: false })).status, 403);
    assert.equal((await a.post('/login', { email: 'ravi@example.com', password: PASSWORD }, { csrf: 'x'.repeat(43) })).status, 403);
    const b = app.client();
    const tokenOfB = await b.csrfToken();
    assert.equal((await a.post('/login', { email: 'ravi@example.com', password: PASSWORD }, { csrf: tokenOfB })).status, 403, 'tokens are tied to the browser they were issued to');
    assert.equal((await a.post('/login', { email: 'ravi@example.com', password: PASSWORD }, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await a.post('/login', { email: 'ravi@example.com', password: PASSWORD }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });

  test('only addresses on this site are followed after sign-in', async () => {
    const cases = [
      ['/studio', '/studio'],
      ['https://evil.example/', '/'],
      ['//evil.example/', '/'],
      ['/\\evil.example', '/'],
      ['javascript:alert(1)', '/'],
      ['/%2f%2fevil.example', '/'],
      ['', '/'],
    ];
    for (const [next, expected] of cases) {
      const fresh = app.client();
      const r = await fresh.post('/login', { email: 'ravi@example.com', password: PASSWORD, next });
      assert.equal(r.status, 303, next);
      assert.equal(new URL(r.location, app.baseUrl).origin, new URL(app.baseUrl).origin, `next=${next} stays on this site`);
      if (!next.includes('%')) assert.equal(r.location, expected, `next=${next}`);
    }
  });

  test('a session ends after 14 idle days, and a busy one still ends after 60', async () => {
    const idle = app.client();
    await login(idle, 'ravi@example.com');
    app.clock.advance(15 * DAY);
    assert.equal((await idle.get('/settings/profile')).status, 303, 'idle too long');

    const busy = app.client();
    await login(busy, 'ravi@example.com');
    for (let day = 7; day <= 56; day += 7) {
      app.clock.advance(7 * DAY);
      assert.equal((await busy.get('/settings/profile')).status, 200, `still in on day ${day}`);
    }
    app.clock.advance(7 * DAY); // day 63
    assert.equal((await busy.get('/settings/profile')).status, 303, 'the absolute limit applies even to an active session');
  });

  test('a suspended person cannot sign in and is told why', async () => {
    await app.ctx.db.query(`UPDATE users SET status = 'suspended', suspended_reason = 'Spam' WHERE id = $1`, [me.id]);
    const r = await login(app.client(), 'ravi@example.com');
    assert.equal(r.status, 401);
    assert.match(r.text, /suspended: Spam/);
    await app.ctx.db.query(`UPDATE users SET status = 'active', suspended_reason = NULL WHERE id = $1`, [me.id]);
  });

  test('the signed-in pages cannot be stored by browsers or shared caches', async () => {
    const a = app.client();
    await login(a, 'ravi@example.com');
    for (const path of ['/settings/profile', '/settings/security', '/studio', '/history']) {
      const r = await a.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.header('cache-control') ?? '', /no-store/, path);
    }
  });
});

describe('password reset and changing a password', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  const tokenFrom = (to) => /reset-password\?token=([\w-]+)/.exec(lastMail(app, to, /reset-password/).text)[1];

  test('asking for a reset looks the same whether or not the address has an account, and only real accounts get mail', async () => {
    const c = app.client();
    await createMember(app, app.client(), { email: 'dev@example.com', handle: 'devika', signIn: false });
    const sentBefore = app.ctx.mailer.sent.length;
    const known = await c.post('/forgot-password', { email: 'dev@example.com' });
    const unknown = await c.post('/forgot-password', { email: 'ghost@example.com' });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(known.text.replace(/csrf-token" content="[^"]+"/, '').replace(/value="[^"]*"/g, '').replace(/nonce="[^"]*"/g, ''), unknown.text.replace(/csrf-token" content="[^"]+"/, '').replace(/value="[^"]*"/g, '').replace(/nonce="[^"]*"/g, ''));
    await new Promise((r) => setTimeout(r, 30));
    const added = app.ctx.mailer.sent.slice(sentBefore);
    assert.deepEqual(added.map((m) => m.to), ['dev@example.com']);
    assert.equal((await c.post('/forgot-password', { email: 'not an email' })).status, 422);
  });

  test('a weak new password is refused without using up the link; a good one works once, signs everyone out and confirms the address', async () => {
    const c = app.client();
    await createMember(app, app.client(), { email: 'gita@example.com', handle: 'gita1', verify: false, signIn: false });
    await c.post('/forgot-password', { email: 'gita@example.com' });
    const token = tokenFrom('gita@example.com');
    assert.equal((await c.get(`/reset-password?token=${token}`)).status, 200);
    assert.equal((await c.post('/reset-password', { token, password: 'short' })).status, 422);
    assert.equal((await c.post('/reset-password', { token, password: 'password1234' })).status, 422);

    const oldSession = app.client();
    await app.ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE email = 'gita@example.com'`);
    await login(oldSession, 'gita@example.com');
    assert.equal((await oldSession.get('/settings/profile')).status, 200);

    const newPassword = 'plum-orchard-laptop-77';
    const ok = await c.post('/reset-password', { token, password: newPassword });
    assert.equal(ok.status, 303);
    assert.equal((await c.post('/reset-password', { token, password: 'another-good-pass-12' })).status, 400, 'single use');
    assert.equal((await oldSession.get('/settings/profile')).status, 303, 'other devices are signed out');
    assert.equal((await login(app.client(), 'gita@example.com', PASSWORD)).status, 401, 'the old password is gone');
    assert.equal((await login(app.client(), 'gita@example.com', newPassword)).status, 303);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(lastMail(app, 'gita@example.com', /password/i), 'a notice that the password changed was sent');
  });

  test('a reset link works for an hour, a newer link replaces the older one, and a reset clears a lock', async () => {
    const c = app.client();
    await createMember(app, app.client(), { email: 'hari@example.com', handle: 'hari1', signIn: false });
    await c.post('/forgot-password', { email: 'hari@example.com' });
    const first = tokenFrom('hari@example.com');
    await c.post('/forgot-password', { email: 'hari@example.com' });
    const second = tokenFrom('hari@example.com');
    assert.notEqual(first, second);
    assert.equal((await c.get(`/reset-password?token=${first}`)).status, 400, 'the older link is replaced');
    for (let i = 0; i < 5; i++) await login(app.client(), 'hari@example.com', `bad guess number ${i}`);
    assert.equal((await login(app.client(), 'hari@example.com')).status, 401, 'locked');
    app.clock.advance(59 * MIN);
    assert.equal((await c.get(`/reset-password?token=${second}`)).status, 200);
    assert.equal((await c.post('/reset-password', { token: second, password: 'fresh-orchard-pass-88' })).status, 303);
    assert.equal((await login(app.client(), 'hari@example.com', 'fresh-orchard-pass-88')).status, 303, 'the lock is cleared');

    await c.post('/forgot-password', { email: 'hari@example.com' });
    const late = tokenFrom('hari@example.com');
    app.clock.advance(61 * MIN);
    assert.equal((await c.post('/reset-password', { token: late, password: 'yet-another-pass-99' })).status, 400, 'expired');
  });

  test('changing the password needs the current one, and signs out the other devices but not this one', async () => {
    const mine = app.client();
    const other = app.client();
    await createMember(app, mine, { email: 'isha@example.com', handle: 'isha1' });
    await login(other, 'isha@example.com');
    const body = { current: PASSWORD, password: 'new-mango-orchard-55', confirm: 'new-mango-orchard-55' };
    assert.equal((await mine.post('/settings/security/password', { ...body, current: 'not my password' })).status, 422);
    assert.equal((await mine.post('/settings/security/password', { ...body, confirm: 'different-one-here-44' })).status, 422);
    assert.equal((await mine.post('/settings/security/password', { ...body, password: 'tiny', confirm: 'tiny' })).status, 422);
    assert.equal((await mine.post('/settings/security/password', body)).status, 303);
    assert.equal((await mine.get('/settings/profile')).status, 200, 'this device stays signed in');
    assert.equal((await other.get('/settings/profile')).status, 303, 'the other one does not');
    assert.equal((await login(app.client(), 'isha@example.com', 'new-mango-orchard-55')).status, 303);
  });
});

describe('two-step verification', () => {
  let app;
  let c;
  let me;
  let secret;
  let codes;
  before(async () => {
    app = await startTestApp();
    c = app.client();
    me = await createMember(app, c, { email: 'tara@example.com', handle: 'tara1' });
  });
  after(() => app.close());

  test('setting it up needs a correct code from the phone, shows ten recovery codes once, and stores the secret encrypted', async () => {
    await c.post('/settings/security/2fa/start');
    secret = (await app.ctx.auth.pendingTotpSetup(me.id)).secret;
    const page = await c.get('/settings/security/2fa');
    assert.equal(page.status, 200);
    assert.match(page.header('cache-control'), /no-store/);
    assert.match(page.text, /<svg/, 'a QR code is drawn on the page itself');
    assert.equal((await c.post('/settings/security/2fa/confirm', { code: '000000' })).status, 422);
    assert.equal((await app.ctx.db.one('SELECT totp_enabled_at FROM users WHERE id = $1', [me.id])).totp_enabled_at, null);

    const ok = await c.post('/settings/security/2fa/confirm', { code: totpCodeNow(app, secret) });
    assert.equal(ok.status, 200);
    assert.match(ok.header('cache-control'), /no-store/);
    codes = [...ok.text.matchAll(/<code>([a-z2-9]{5}-[a-z2-9]{5})<\/code>/g)].map((m) => m[1]);
    assert.equal(new Set(codes).size, 10);
    const row = await app.ctx.db.one('SELECT totp_secret_enc, recovery_codes FROM users WHERE id = $1', [me.id]);
    assert.ok(!row.totp_secret_enc.includes(secret), 'the secret is not stored in the clear');
    assert.ok(!JSON.stringify(row.recovery_codes).includes(codes[0]), 'recovery codes are stored as digests');
    assert.equal((await c.post('/settings/security/2fa/start')).status, 409, 'cannot start again while it is on');
  });

  test('after the password, a code is needed; a wrong one is refused, a right one signs in, and the same code cannot be used twice', async () => {
    app.clock.advance(31_000);
    const d = app.client();
    const step1 = await login(d, 'tara@example.com');
    assert.equal(step1.status, 303);
    assert.match(step1.location, /^\/login\/mfa/);
    assert.equal((await d.get('/settings/profile')).status, 303, 'a half-signed-in browser sees nothing private');
    assert.equal((await d.post('/login/mfa', { code: '123456' })).status, 401);
    const good = totpCodeNow(app, secret);
    const ok = await d.post('/login/mfa', { code: good });
    assert.equal(ok.status, 303);
    assert.equal((await d.get('/settings/profile')).status, 200);

    const replay = app.client();
    await login(replay, 'tara@example.com');
    assert.equal((await replay.post('/login/mfa', { code: good })).status, 401, 'a code that was just used is refused');
    assert.equal((await replay.post('/login/mfa', { code: totpCodeNow(app, secret, 1) })).status, 303, 'the next code is fine');
  });

  test('the second step has its own time limit', async () => {
    const d = app.client();
    await login(d, 'tara@example.com');
    app.clock.advance(11 * MIN);
    const r = await d.post('/login/mfa', { code: totpCodeNow(app, secret) });
    assert.equal(r.status, 303);
    assert.equal(r.location, '/login');
  });

  test('wrong second-step codes count toward the lock', async () => {
    app.clock.advance(31_000);
    const d = app.client();
    await login(d, 'tara@example.com');
    for (let i = 0; i < 5; i++) await d.post('/login/mfa', { code: '000001' });
    assert.equal((await d.post('/login/mfa', { code: totpCodeNow(app, secret) })).status, 401, 'locked even for the right code');
    app.clock.advance(2 * MIN);
  });

  test('a recovery code signs in once and then is gone', async () => {
    app.clock.advance(31_000);
    const d = app.client();
    await login(d, 'tara@example.com');
    assert.equal((await d.post('/login/mfa', { code: codes[0].toUpperCase() })).status, 303, 'capitals and spaces do not matter');
    const again = app.client();
    await login(again, 'tara@example.com');
    assert.equal((await again.post('/login/mfa', { code: codes[0] })).status, 401);
    assert.equal((await d.get('/settings/security')).text.match(/You have (\d+) unused recovery/)[1], '9');
  });

  test('new recovery codes and turning it off both need the password, and replace or remove everything', async () => {
    assert.equal((await c.post('/settings/security/2fa/recovery', { password: 'wrong' })).status, 422);
    const fresh = await c.post('/settings/security/2fa/recovery', { password: PASSWORD });
    assert.equal(fresh.status, 200);
    const newCodes = [...fresh.text.matchAll(/<code>([a-z2-9]{5}-[a-z2-9]{5})<\/code>/g)].map((m) => m[1]);
    assert.equal(newCodes.length, 10);
    app.clock.advance(31_000);
    const d = app.client();
    await login(d, 'tara@example.com');
    assert.equal((await d.post('/login/mfa', { code: codes[1] })).status, 401, 'the old codes stopped working');

    assert.equal((await c.post('/settings/security/2fa/disable', { password: 'wrong' })).status, 422);
    assert.equal((await c.post('/settings/security/2fa/disable', { password: PASSWORD })).status, 303);
    const row = await app.ctx.db.one('SELECT totp_secret_enc, totp_enabled_at, recovery_codes FROM users WHERE id = $1', [me.id]);
    assert.deepEqual({ s: row.totp_secret_enc, t: row.totp_enabled_at, r: row.recovery_codes }, { s: null, t: null, r: [] });
    assert.equal((await login(app.client(), 'tara@example.com')).status, 303, 'plain sign-in again');
  });
});

describe('devices', () => {
  test('the list shows this person’s devices only, and signing one out affects only that one', async () => {
    const app = await startTestApp();
    try {
      const a1 = app.client();
      const a2 = app.client();
      const b = app.client();
      await createMember(app, a1, { email: 'uma@example.com', handle: 'uma1' });
      await login(a2, 'uma@example.com');
      await createMember(app, b, { email: 'veer@example.com', handle: 'veer1' });
      const mine = await app.ctx.db.query(`SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle = 'uma1')`);
      const theirs = await app.ctx.db.one(`SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle = 'veer1')`);
      assert.equal(mine.rows.length, 2);
      // Veer tries to sign out one of Uma's devices by id: nothing happens to it.
      await b.post('/settings/security/sessions/revoke', { id: mine.rows[0].id });
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle = 'uma1')`)).rows.length, 2);
      // Uma signs out everything else.
      await a1.post('/settings/security/sessions/revoke-others');
      assert.equal((await a1.get('/settings/profile')).status, 200);
      assert.equal((await a2.get('/settings/profile')).status, 303);
      assert.equal((await b.get('/settings/profile')).status, 200);
      assert.ok(theirs.id);
    } finally {
      await app.close();
    }
  });
});
