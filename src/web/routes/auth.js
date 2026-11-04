import express from 'express';
import { ValidationError } from '../../lib/errors.js';
import { safeLocalPath } from '../../lib/html.js';
import { emailSchema, parseInput } from '../../lib/validate.js';
import { limit } from '../middleware/limit.js';
import { COOKIES } from '../middleware/context.js';
import { ABSOLUTE_MS } from '../../services/sessions.js';
import * as v from '../views/pages/auth.js';

const GENERIC_LOGIN_ERROR = 'That email address and password do not match, or the account is temporarily locked after too many attempts. Try again, or reset your password.';

export function authRoutes(ctx) {
  const r = express.Router();
  const authLimit = limit(ctx, { name: 'auth', limit: 30, windowMs: 15 * 60_000 });
  const signupLimit = limit(ctx, { name: 'signup', limit: 10, windowMs: 60 * 60_000 });
  const resetLimit = limit(ctx, { name: 'reset', limit: 8, windowMs: 60 * 60_000 });
  const mfaLimit = limit(ctx, { name: 'mfa', limit: 12, windowMs: 15 * 60_000 });

  const startSession = (res, token) => res.setCookie(COOKIES.session, token, { maxAge: ABSOLUTE_MS / 1000 });
  const signedInRedirect = (req, res, next) => (req.user ? res.redirect(303, '/') : next());

  r.get('/login', signedInRedirect, (req, res) => res.page(v.loginPage(req, { next: safeLocalPath(req.query.next, '/') }), { title: 'Sign in', noindex: true }));

  r.post('/login', authLimit, async (req, res) => {
    const next = safeLocalPath(req.body.next, '/');
    const parsed = parseInput(emailSchema, req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
    const email = parsed.errors ? '' : parsed.data;
    const fail = (error, extra = {}) => res.status(401).page(v.loginPage(req, { values: { email: typeof req.body.email === 'string' ? req.body.email.slice(0, 254) : '' }, error, next, ...extra }), { title: 'Sign in', noindex: true });
    if (!email || !password) return fail(GENERIC_LOGIN_ERROR);

    if (req.session) await ctx.sessions.destroy(req.session.token);
    const out = await ctx.auth.login({ email, password, ip: req.ip, userAgent: req.get('user-agent') });
    switch (out.result) {
      case 'ok':
        startSession(res, out.token);
        return res.redirect(303, next);
      case 'mfa':
        startSession(res, out.token);
        res.setCookie(COOKIES.flash, '', { maxAge: 0 });
        return res.redirect(303, `/login/mfa?next=${encodeURIComponent(next)}`);
      case 'unverified':
        return fail('Confirm your email address first. The link is in the email we sent when you signed up.', { needsVerify: true });
      case 'suspended':
        return fail(`This account is suspended${out.reason ? `: ${out.reason}` : ''}. You can write to us from the contact page.`);
      default:
        return fail(GENERIC_LOGIN_ERROR);
    }
  });

  r.get('/login/mfa', (req, res) => {
    if (!req.mfaPending) return res.redirect(303, '/login');
    return res.page(v.mfaPage(req, {}), { title: 'Enter your code', noindex: true });
  });

  r.post('/login/mfa', mfaLimit, async (req, res) => {
    if (!req.mfaPending) return res.redirect(303, '/login');
    const next = safeLocalPath(req.query.next, '/');
    const out = await ctx.auth.completeMfa({ pendingToken: req.mfaPending.token, code: String(req.body.code ?? '').slice(0, 40), ip: req.ip, userAgent: req.get('user-agent') });
    if (out.result === 'ok') {
      startSession(res, out.token);
      return res.redirect(303, next);
    }
    if (out.result === 'expired') {
      res.flash('error', 'That sign-in took too long. Start again.');
      return res.redirect(303, '/login');
    }
    return res.status(401).page(v.mfaPage(req, { error: 'That code is not right, or it was already used. Try the next code, or a recovery code.' }), { title: 'Enter your code', noindex: true });
  });

  r.post('/logout', async (req, res) => {
    if (req.session) await ctx.sessions.destroy(req.session.token);
    if (req.mfaPending) await ctx.sessions.destroy(req.mfaPending.token);
    res.expireCookie(COOKIES.session);
    res.flash('info', 'You are signed out.');
    res.redirect(303, '/');
  });

  r.get('/signup', signedInRedirect, (req, res) => res.page(v.signupPage(req, {}), { title: 'Create your account', noindex: true }));

  r.post('/signup', signupLimit, async (req, res) => {
    const { data, errors } = ctx.auth.parseSignup(req.body);
    const values = { displayName: String(req.body.displayName ?? '').slice(0, 50), handle: String(req.body.handle ?? '').slice(0, 30), email: String(req.body.email ?? '').slice(0, 254), adult: req.body.adult, terms: req.body.terms };
    const again = (errs) => res.status(422).page(v.signupPage(req, { values, errors: errs }), { title: 'Create your account', noindex: true });
    if (errors) return again(errors);
    try {
      await ctx.auth.signup(data, { ip: req.ip });
    } catch (e) {
      if (e instanceof ValidationError) return again(e.fieldErrors);
      throw e;
    }
    return res.page(v.checkInboxPage(), { title: 'Check your inbox', noindex: true });
  });

  r.get('/verify-email', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const valid = !!(await ctx.auth.peekVerification(token));
    res.status(valid ? 200 : 400).page(v.verifyEmailPage(req, { token, valid }), { title: 'Confirm your email address', noindex: true });
  });

  r.post('/verify-email', authLimit, async (req, res) => {
    const out = await ctx.auth.verifyEmail(typeof req.body.token === 'string' ? req.body.token : '');
    if (!out.ok) return res.status(400).page(v.verifyEmailPage(req, { token: '', valid: false }), { title: 'Confirm your email address', noindex: true });
    res.flash('success', 'Email address confirmed. You can sign in now.');
    return res.redirect(303, req.user ? '/' : '/login');
  });

  r.post('/resend-verification', async (req, res) => {
    if (req.user) await ctx.auth.resendVerification(req.user.id);
    res.flash('info', 'If your address still needs confirming, we sent a new link.');
    res.redirect(303, '/');
  });

  r.post('/resend-verification-public', resetLimit, async (req, res) => {
    const parsed = parseInput(emailSchema, req.body.email);
    if (!parsed.errors) await ctx.auth.resendVerificationForEmail(parsed.data);
    res.flash('info', 'If that address still needs confirming, we sent a new link.');
    res.redirect(303, '/login');
  });

  r.get('/forgot-password', (req, res) => res.page(v.forgotPage(req, {}), { title: 'Reset your password', noindex: true }));

  r.post('/forgot-password', resetLimit, async (req, res) => {
    const parsed = parseInput(emailSchema, req.body.email);
    if (parsed.errors) return res.status(422).page(v.forgotPage(req, { values: { email: String(req.body.email ?? '').slice(0, 254) }, errors: { email: parsed.errors._ ?? 'Enter a valid email address.' } }), { title: 'Reset your password', noindex: true });
    await ctx.auth.requestPasswordReset(parsed.data);
    return res.page(v.forgotSentPage(), { title: 'Check your inbox', noindex: true });
  });

  r.get('/reset-password', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const valid = !!(await ctx.auth.peekReset(token));
    res.status(valid ? 200 : 400).page(v.resetPage(req, { token, valid }), { title: 'Choose a new password', noindex: true });
  });

  r.post('/reset-password', authLimit, async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
    try {
      const out = await ctx.auth.resetPassword(token, password);
      if (!out.ok) return res.status(400).page(v.resetPage(req, { token: '', valid: false }), { title: 'Choose a new password', noindex: true });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(422).page(v.resetPage(req, { token, valid: true, errors: e.fieldErrors }), { title: 'Choose a new password', noindex: true });
      throw e;
    }
    res.expireCookie(COOKIES.session);
    res.flash('success', 'Password changed. Sign in with the new one.');
    return res.redirect(303, '/login');
  });

  return r;
}
