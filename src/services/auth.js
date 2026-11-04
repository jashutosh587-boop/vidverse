import { z } from 'zod';
import { LEGAL_VERSION } from '../config.js';
import {
  hashPassword,
  verifyPassword,
  verifyDummy,
  needsRehash,
  randomToken,
  sha256Hex,
  encryptString,
  decryptString,
} from '../lib/crypto.js';
import { newTotpSecret, verifyTotp, totpStep, otpauthUri, newRecoveryCodes } from '../lib/totp.js';
import { passwordProblems } from '../lib/password-policy.js';
import { ValidationError, HttpError } from '../lib/errors.js';
import { emailSchema, handleSchema, cleanText, checkbox, parseInput } from '../lib/validate.js';
import * as emails from './emails.js';

const HOUR = 3600 * 1000;
const VERIFY_TTL = 24 * HOUR;
const RESET_TTL = HOUR;
export const FAIL_LIMIT = 5;

const signupSchema = z.object({
  email: emailSchema,
  password: z.string({ error: 'Choose a password.' }).max(128, 'Use at most 128 characters.'),
  handle: handleSchema,
  displayName: cleanText({ min: 1, max: 50, label: 'Your name' }),
  adult: checkbox.refine((v) => v === true, 'You must be 18 or older to use this site.'),
  terms: checkbox.refine((v) => v === true, 'Accept the Terms and the Privacy Policy to continue.'),
});

const isUniqueViolation = (e, name) => e?.code === '23505' && (!name || String(e.constraint ?? '').includes(name));

export function createAuthService(ctx) {
  const { db, config, clock, mailer, sessions, audit, log } = ctx;
  const mailCtx = { siteName: config.siteName, baseUrl: config.baseUrl };

  /** Fire and forget: the response must not depend on how fast the mail server is (that would leak whether an address exists). */
  const sendInBackground = (to, message) => {
    mailer.send({ to, ...message }).catch((e) => log.error('email failed', { err: e }));
  };

  async function issueToken(userId, purpose, ttlMs) {
    const token = randomToken(32);
    await db.query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
    await db.query('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256Hex(token),
      userId,
      purpose,
      new Date(clock().getTime() + ttlMs),
    ]);
    return token;
  }

  async function peekToken(token, purpose) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    return db.one(
      `SELECT user_id FROM email_tokens WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3`,
      [sha256Hex(token), purpose, clock()],
    );
  }

  /** Single use: two requests with the same token cannot both succeed. */
  async function consumeToken(token, purpose) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = await db.one(
      `UPDATE email_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id`,
      [sha256Hex(token), purpose, clock()],
    );
    return row?.user_id ?? null;
  }

  /** Counts a failed password or second-step attempt and locks the account with growing delays. */
  async function recordFailure(userId) {
    const now = clock();
    await db.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2
                                  THEN $3::timestamptz + (LEAST(60, power(2, failed_logins + 1 - $2)) * interval '1 minute')
                                  ELSE locked_until END
        WHERE id = $1`,
      [userId, FAIL_LIMIT, now],
    );
  }

  const clearFailures = (userId) => db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [userId]);

  const hueFor = (handle) => parseInt(sha256Hex(handle).slice(0, 4), 16) % 36;

  return {
    LEGAL_VERSION,
    /**
     * Checks the sign-up form. When something is wrong, the password rules are checked too, so the person sees every
     * mistake at once instead of fixing one and meeting the next on the following try.
     */
    parseSignup: (body) => {
      const out = parseInput(signupSchema, body);
      if (out.errors && !out.errors.password && typeof body?.password === 'string') {
        const problems = passwordProblems(body.password, { email: String(body.email ?? '').toLowerCase(), handle: String(body.handle ?? '') });
        if (problems.length) out.errors.password = problems[0];
      }
      return out;
    },

    /**
     * Creates the account (unverified) and emails a confirmation link. If the address already has an
     * account, nothing is created and that address is told so by email; the caller shows the same
     * "check your inbox" page either way, so the form cannot be used to find out who has an account.
     */
    async signup({ email, password, handle, displayName }, meta = {}) {
      const problems = passwordProblems(password, { email, handle });
      if (problems.length) throw new ValidationError({ password: problems[0] });
      const hash = await hashPassword(password, config.passwordCost); // always, so timing does not reveal existing addresses

      if (await db.one('SELECT 1 AS x FROM users WHERE lower(email) = $1', [email])) {
        sendInBackground(email, emails.alreadyRegisteredEmail(mailCtx));
        return { status: 'exists' };
      }
      if (await db.one('SELECT 1 AS x FROM users WHERE lower(handle) = $1', [handle])) throw new ValidationError({ handle: 'That handle is taken. Try another.' });

      const now = clock();
      let user;
      try {
        user = await db.one(
          `INSERT INTO users (email, password_hash, handle, display_name, avatar_hue, adult_confirmed_at, terms_version, terms_accepted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING id, display_name`,
          [email, hash, handle, displayName, hueFor(handle), now, LEGAL_VERSION],
        );
      } catch (e) {
        if (isUniqueViolation(e, 'handle')) throw new ValidationError({ handle: 'That handle is taken. Try another.' });
        if (isUniqueViolation(e, 'email')) return { status: 'exists' };
        throw e;
      }
      const token = await issueToken(user.id, 'verify', VERIFY_TTL);
      sendInBackground(email, emails.verifyEmail({ ...mailCtx, token, displayName: user.display_name }));
      await audit.record(user.id, 'user.signup', { targetType: 'user', targetId: user.id, ip: meta.ip });
      return { status: 'created', userId: user.id };
    },

    peekVerification: (token) => peekToken(token, 'verify'),

    async verifyEmail(token) {
      const userId = await consumeToken(token, 'verify');
      if (!userId) return { ok: false };
      await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [userId, clock()]);
      return { ok: true, userId };
    },

    async resendVerification(userId) {
      const user = await db.one('SELECT id, email, display_name, email_verified_at, status FROM users WHERE id = $1', [userId]);
      if (!user || user.email_verified_at || user.status !== 'active') return false;
      const token = await issueToken(user.id, 'verify', VERIFY_TTL);
      sendInBackground(user.email, emails.verifyEmail({ ...mailCtx, token, displayName: user.display_name }));
      return true;
    },

    /** Resend by address, from the sign-in page. Same answer whether or not the address exists. */
    async resendVerificationForEmail(email) {
      const user = await db.one('SELECT id FROM users WHERE lower(email) = $1 AND email_verified_at IS NULL AND status = $2', [email, 'active']);
      if (user) await this.resendVerification(user.id);
    },

    /**
     * result: ok | mfa | invalid | locked | unverified | suspended
     * 'invalid' and 'locked' are shown with the same wording, and an unknown address costs the same time as a wrong password.
     */
    async login({ email, password, ip, userAgent }) {
      const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
      const now = clock();
      if (!user || user.status === 'deleted') {
        await verifyDummy(password, config.passwordCost);
        return { result: 'invalid' };
      }
      if (user.locked_until && new Date(user.locked_until) > now) {
        await verifyDummy(password, config.passwordCost);
        return { result: 'locked' };
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        await recordFailure(user.id);
        return { result: 'invalid' };
      }
      if (user.status === 'suspended') return { result: 'suspended', reason: user.suspended_reason };
      if (!user.email_verified_at) return { result: 'unverified' };

      if (needsRehash(user.password_hash, config.passwordCost)) {
        await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password, config.passwordCost)]);
      }
      if (user.totp_enabled_at) {
        const pending = await sessions.create(user.id, { stage: 'mfa', ip, userAgent });
        return { result: 'mfa', token: pending.token };
      }
      await clearFailures(user.id);
      await db.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [user.id, now]);
      const s = await sessions.create(user.id, { ip, userAgent });
      return { result: 'ok', token: s.token, userId: user.id };
    },

    /** Second step: a 6-digit code from the authenticator app, or one of the printed recovery codes. */
    async completeMfa({ pendingToken, code, ip, userAgent }) {
      const found = await sessions.lookup(pendingToken);
      if (!found || found.session.stage !== 'mfa') return { result: 'expired' };
      const row = await db.one('SELECT id, totp_secret_enc, totp_last_step, recovery_codes, failed_logins, locked_until FROM users WHERE id = $1', [found.user.id]);
      const now = clock();
      if (!row.totp_secret_enc || (row.locked_until && new Date(row.locked_until) > now)) return { result: 'invalid' };

      const secret = decryptString(config.encryptionKeys, row.totp_secret_enc, `totp:${row.id}`);
      const entered = String(code ?? '').replace(/[\s-]/g, '').toLowerCase();
      let ok = false;
      const step = verifyTotp(secret, entered, now.getTime(), Number(row.totp_last_step));
      if (step !== null) {
        // Atomic: a code that was already used (even a moment ago, even in parallel) is refused.
        const upd = await db.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [row.id, step]);
        ok = upd.rowCount === 1;
      } else if (/^[a-z0-9]{10}$/.test(entered)) {
        const hash = sha256Hex(`${entered.slice(0, 5)}-${entered.slice(5)}`);
        const upd = await db.query(`UPDATE users SET recovery_codes = recovery_codes - $2::text WHERE id = $1 AND recovery_codes ? $2::text`, [row.id, hash]);
        ok = upd.rowCount === 1;
      }
      if (!ok) {
        await recordFailure(row.id);
        return { result: 'invalid' };
      }
      await clearFailures(row.id);
      await sessions.destroy(pendingToken);
      await db.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [row.id, now]);
      const s = await sessions.create(row.id, { ip, userAgent });
      return { result: 'ok', token: s.token, userId: row.id };
    },

    async requestPasswordReset(email) {
      const user = await db.one(`SELECT id, status FROM users WHERE lower(email) = $1`, [email]);
      if (!user || user.status === 'deleted') return;
      const token = await issueToken(user.id, 'reset', RESET_TTL);
      sendInBackground(email, emails.resetEmail({ ...mailCtx, token }));
    },

    peekReset: (token) => peekToken(token, 'reset'),

    async resetPassword(token, newPassword) {
      const peek = await peekToken(token, 'reset');
      if (!peek) return { ok: false };
      const user = await db.one('SELECT id, email, handle FROM users WHERE id = $1', [peek.user_id]);
      const problems = passwordProblems(newPassword, { email: user.email, handle: user.handle });
      if (problems.length) throw new ValidationError({ password: problems[0] });
      const hash = await hashPassword(newPassword, config.passwordCost);
      const userId = await consumeToken(token, 'reset');
      if (!userId) return { ok: false };
      await db.tx(async () => {
        // Proving control of the inbox also confirms the address.
        await db.query(
          `UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, $3) WHERE id = $1`,
          [userId, hash, clock()],
        );
        await sessions.destroyAllForUser(userId);
      });
      sendInBackground(user.email, emails.passwordChangedEmail(mailCtx));
      await audit.record(userId, 'user.password_reset', { targetType: 'user', targetId: userId });
      return { ok: true };
    },

    /** Needs the current password. Signs out every other device and keeps this one. */
    async changePassword(userId, currentPassword, newPassword, keepSessionId) {
      const user = await db.one('SELECT id, email, handle, password_hash FROM users WHERE id = $1', [userId]);
      if (!(await verifyPassword(currentPassword ?? '', user.password_hash))) throw new ValidationError({ current: 'That is not your current password.' });
      const problems = passwordProblems(newPassword, { email: user.email, handle: user.handle });
      if (problems.length) throw new ValidationError({ password: problems[0] });
      const hash = await hashPassword(newPassword, config.passwordCost);
      await db.tx(async () => {
        await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
        await sessions.destroyAllForUser(userId, keepSessionId);
      });
      sendInBackground(user.email, emails.passwordChangedEmail(mailCtx));
      await audit.record(userId, 'user.password_change', { targetType: 'user', targetId: userId });
    },

    async verifyCurrentPassword(userId, password) {
      const user = await db.one('SELECT password_hash FROM users WHERE id = $1', [userId]);
      return !!user && (await verifyPassword(password ?? '', user.password_hash));
    },

    // ---- Two-step sign-in (authenticator app) ----

    /** Creates a pending secret. It only counts once a valid code proves the phone has it. */
    async beginTotpSetup(userId) {
      const user = await db.one('SELECT email, totp_enabled_at FROM users WHERE id = $1', [userId]);
      if (user.totp_enabled_at) throw new HttpError(409, 'Two-step sign-in is already on.');
      const secret = newTotpSecret();
      await db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [userId, encryptString(config.encryptionKeys, secret, `totp:${userId}`)]);
      return { secret, uri: otpauthUri({ secret, account: user.email, issuer: config.siteName }) };
    },

    async pendingTotpSetup(userId) {
      const user = await db.one('SELECT email, totp_secret_enc, totp_enabled_at FROM users WHERE id = $1', [userId]);
      if (!user.totp_secret_enc || user.totp_enabled_at) return null;
      const secret = decryptString(config.encryptionKeys, user.totp_secret_enc, `totp:${userId}`);
      return { secret, uri: otpauthUri({ secret, account: user.email, issuer: config.siteName }) };
    },

    /** Returns the recovery codes (shown once; only their hashes are kept), or null if the code is wrong. */
    async confirmTotpSetup(userId, code) {
      const user = await db.one('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1', [userId]);
      if (!user.totp_secret_enc || user.totp_enabled_at) return null;
      const secret = decryptString(config.encryptionKeys, user.totp_secret_enc, `totp:${userId}`);
      const step = verifyTotp(secret, String(code ?? '').replace(/\s/g, ''), clock().getTime(), 0);
      if (step === null) return null;
      const codes = newRecoveryCodes(10);
      await db.query('UPDATE users SET totp_enabled_at = $2, totp_last_step = $3, recovery_codes = $4 WHERE id = $1', [
        userId,
        clock(),
        step,
        JSON.stringify(codes.map((c) => sha256Hex(c))),
      ]);
      await audit.record(userId, 'user.totp_enabled', { targetType: 'user', targetId: userId });
      return codes;
    },

    /** Replaces the recovery codes. The old ones stop working. Returns the new codes, shown once, or null if two-step is off. */
    async regenerateRecoveryCodes(userId) {
      const user = await db.one('SELECT totp_enabled_at FROM users WHERE id = $1', [userId]);
      if (!user?.totp_enabled_at) return null;
      const codes = newRecoveryCodes(10);
      await db.query('UPDATE users SET recovery_codes = $2 WHERE id = $1', [userId, JSON.stringify(codes.map((c) => sha256Hex(c)))]);
      await audit.record(userId, 'user.recovery_codes_regenerated', { targetType: 'user', targetId: userId });
      return codes;
    },

    async recoveryCodesLeft(userId) {
      const user = await db.one('SELECT recovery_codes FROM users WHERE id = $1', [userId]);
      return Array.isArray(user?.recovery_codes) ? user.recovery_codes.length : 0;
    },

    async disableTotp(userId) {
      await db.query(`UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0, recovery_codes = '[]' WHERE id = $1`, [userId]);
      await audit.record(userId, 'user.totp_disabled', { targetType: 'user', targetId: userId });
    },

    stepNow: () => totpStep(clock().getTime()),
  };
}
