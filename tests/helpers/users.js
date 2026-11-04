import { hotp, totpStep } from '../../src/lib/totp.js';

export const PASSWORD = 'correct horse battery staple';

/** The newest email sent to an address, optionally the first whose text matches a pattern. */
export function lastMail(app, to, pattern = null) {
  return [...app.ctx.mailer.sent].reverse().find((m) => m.to === to && (!pattern || pattern.test(m.text)));
}

export async function login(client, email, password = PASSWORD) {
  return client.post('/login', { email, password });
}

/**
 * Signs up through the real form, reads the confirmation email, confirms the address and signs in.
 * Returns { id, email, handle }.
 */
export async function createMember(app, client, { email, handle, name = 'Test Person', password = PASSWORD, verify = true, signIn = true } = {}) {
  const r = await client.post('/signup', { displayName: name, handle, email, password, adult: '1', terms: '1' });
  if (![200, 303].includes(r.status)) throw new Error(`signup failed with ${r.status}: ${r.text.slice(0, 300)}`);
  if (verify) {
    const mail = lastMail(app, email, /verify-email\?token=/);
    if (!mail) throw new Error('no confirmation email was sent');
    const token = /verify-email\?token=([\w-]+)/.exec(mail.text)[1];
    const v = await client.post('/verify-email', { token });
    if (![200, 303].includes(v.status)) throw new Error(`verify failed with ${v.status}: ${v.text.slice(0, 200)}`);
  }
  if (signIn) {
    const l = await login(client, email, password);
    if (l.status !== 303) throw new Error(`login failed with ${l.status}: ${l.text.slice(0, 200)}`);
  }
  const row = await app.ctx.db.one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  return { id: row.id, email, handle };
}

/** The code an authenticator app would show at the app's current (fake) time. */
export const totpCodeNow = (app, secret, offsetSteps = 0) => hotp(secret, totpStep(app.clock.now().getTime()) + offsetSteps);

export async function makeAdmin(app, userId) {
  await app.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
}
