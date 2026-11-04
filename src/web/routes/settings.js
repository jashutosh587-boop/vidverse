import express from 'express';
import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { safeExternalUrl } from '../../lib/html.js';
import { checkbox, cleanText, parseInput } from '../../lib/validate.js';
import { dayString } from '../../lib/format.js';
import { limit } from '../middleware/limit.js';
import { COOKIES } from '../middleware/context.js';
import { requireUser } from '../guards.js';
import * as v from '../views/pages/settings.js';

const str = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const NOINDEX = (title) => ({ title, noindex: true });

const profileSchema = z.object({
  display_name: cleanText({ min: 1, max: 50, label: 'Your name' }),
  bio: cleanText({ max: 1000, multiline: true, label: 'The description' }),
  avatar_hue: z.coerce.number().int().min(0).max(35),
});

const labelSchema = cleanText({ max: 40, label: 'The link name' });

/** Up to four { label, url } pairs from the form. Both parts are needed, and the address must be https. */
export function parseLinks(body) {
  const links = [];
  const errors = {};
  for (let i = 1; i <= v.LINK_SLOTS; i++) {
    const rawLabel = str(body?.[`link_label_${i}`], 200);
    const rawUrl = str(body?.[`link_url_${i}`], 2100).trim();
    if (!rawLabel.trim() && !rawUrl) continue;
    const label = labelSchema.safeParse(rawLabel);
    if (!label.success || !label.data) {
      errors[`link_label_${i}`] = label.success ? 'Give the link a name.' : label.error.issues[0].message;
      continue;
    }
    const url = safeExternalUrl(rawUrl);
    if (!url || !url.startsWith('https://')) {
      errors[`link_url_${i}`] = 'Enter an address that starts with https://';
      continue;
    }
    links.push({ label: label.data, url });
  }
  return { links, errors };
}

export function settingsRoutes(ctx) {
  const r = express.Router();
  const sensitive = limit(ctx, { name: 'reauth', limit: 10, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });
  const exportLimit = limit(ctx, { name: 'export', limit: 3, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });
  const codeLimit = limit(ctx, { name: 'mfa-setup', limit: 12, windowMs: 15 * 60_000, key: (req) => req.user?.id ?? req.ip });

  r.use('/settings', requireUser);

  r.get('/settings', (req, res) => res.redirect(303, '/settings/profile'));

  // ------------------------------------------------------------------ profile

  const profileValues = (user) => ({ display_name: user.display_name, bio: user.bio, avatar_hue: user.avatar_hue, links: Array.isArray(user.support_links) ? user.support_links : [] });

  r.get('/settings/profile', (req, res) => res.page(v.profilePage(req, { values: profileValues(req.user) }), NOINDEX('Settings')));

  r.post('/settings/profile', async (req, res) => {
    const body = { ...req.body, avatar_hue: req.body?.avatar_hue ?? req.user.avatar_hue };
    const { data, errors } = parseInput(profileSchema, body);
    const { links, errors: linkErrors } = parseLinks(req.body);
    const all = { ...(errors ?? {}), ...linkErrors };
    if (Object.keys(all).length) {
      const typed = { display_name: str(req.body?.display_name, 100), bio: str(req.body?.bio, 1200), avatar_hue: body.avatar_hue, links: [1, 2, 3, 4].map((i) => ({ label: str(req.body?.[`link_label_${i}`], 100), url: str(req.body?.[`link_url_${i}`], 2100) })) };
      return res.status(422).page(v.profilePage(req, { values: typed, errors: all }), NOINDEX('Settings'));
    }
    await ctx.accounts.updateProfile(req.user.id, { displayName: data.display_name, bio: data.bio, avatarHue: data.avatar_hue, supportLinks: links });
    res.flash('success', 'Saved.');
    return res.redirect(303, '/settings/profile');
  });

  // ------------------------------------------------------------------ password, two-step sign-in, devices

  async function securityModel(req, extra = {}) {
    const [sessions, codesLeft] = await Promise.all([ctx.sessions.listForUser(req.user.id), req.user.totp_enabled_at ? ctx.auth.recoveryCodesLeft(req.user.id) : 0]);
    return { sessions, twoStep: { enabled: Boolean(req.user.totp_enabled_at), codesLeft }, now: ctx.clock(), ...extra };
  }
  const showSecurity = async (req, res, extra = {}, status = 200) => res.status(status).page(v.securityPage(req, await securityModel(req, extra)), NOINDEX('Password and security'));

  r.get('/settings/security', (req, res) => showSecurity(req, res));

  r.post('/settings/security/password', sensitive, async (req, res) => {
    const password = str(req.body.password, 128);
    if (password !== str(req.body.confirm, 128)) return showSecurity(req, res, { errors: { confirm: 'The two passwords do not match.' } }, 422);
    try {
      await ctx.auth.changePassword(req.user.id, str(req.body.current, 128), password, req.session.id);
    } catch (e) {
      if (e instanceof ValidationError) return showSecurity(req, res, { errors: e.fieldErrors }, 422);
      throw e;
    }
    res.flash('success', 'Password changed. Your other devices were signed out.');
    return res.redirect(303, '/settings/security');
  });

  r.post('/settings/security/2fa/start', sensitive, async (req, res) => {
    await ctx.auth.beginTotpSetup(req.user.id);
    res.redirect(303, '/settings/security/2fa');
  });

  const showSetup = async (req, res, error = '', status = 200) => {
    const setup = await ctx.auth.pendingTotpSetup(req.user.id);
    if (!setup) return res.redirect(303, '/settings/security');
    res.set('Cache-Control', 'no-store');
    return res.status(status).page(v.totpSetupPage(req, { setup, error }), NOINDEX('Set up two-step verification'));
  };
  r.get('/settings/security/2fa', (req, res) => showSetup(req, res));

  r.post('/settings/security/2fa/confirm', codeLimit, async (req, res) => {
    const codes = await ctx.auth.confirmTotpSetup(req.user.id, str(req.body.code, 20));
    if (!codes) return showSetup(req, res, 'That code did not work. Check that your phone’s clock is right, then type the newest code.', 422);
    res.set('Cache-Control', 'no-store');
    return res.page(v.recoveryCodesPage(req, { codes, headline: 'Two-step verification is on' }), NOINDEX('Recovery codes'));
  });

  r.post('/settings/security/2fa/recovery', sensitive, async (req, res) => {
    if (!(await ctx.auth.verifyCurrentPassword(req.user.id, str(req.body.password, 128)))) return showSecurity(req, res, { errors: { recoveryPassword: 'That is not your password.' } }, 422);
    const codes = await ctx.auth.regenerateRecoveryCodes(req.user.id);
    if (!codes) return res.redirect(303, '/settings/security');
    res.set('Cache-Control', 'no-store');
    return res.page(v.recoveryCodesPage(req, { codes, headline: 'New recovery codes' }), NOINDEX('Recovery codes'));
  });

  r.post('/settings/security/2fa/disable', sensitive, async (req, res) => {
    if (!(await ctx.auth.verifyCurrentPassword(req.user.id, str(req.body.password, 128)))) return showSecurity(req, res, { errors: { disablePassword: 'That is not your password.' } }, 422);
    await ctx.auth.disableTotp(req.user.id);
    res.flash('success', 'Two-step verification is off.');
    return res.redirect(303, '/settings/security');
  });

  r.post('/settings/security/sessions/revoke', async (req, res) => {
    const id = str(req.body.id, 80);
    if (id && id === req.session.id) {
      await ctx.sessions.destroy(req.session.token);
      res.expireCookie(COOKIES.session);
      return res.redirect(303, '/login');
    }
    if (/^[0-9a-f]{64}$/.test(id)) await ctx.sessions.destroyById(req.user.id, id);
    res.flash('success', 'That device is signed out.');
    return res.redirect(303, '/settings/security');
  });

  r.post('/settings/security/sessions/revoke-others', async (req, res) => {
    await ctx.sessions.destroyAllForUser(req.user.id, req.session.id);
    res.flash('success', 'Your other devices are signed out.');
    return res.redirect(303, '/settings/security');
  });

  // ------------------------------------------------------------------ viewing preferences

  const prefValues = (u) => ({ autoplay: u.autoplay, daily_limit: u.daily_limit_minutes ?? '' });
  r.get('/settings/preferences', (req, res) => res.page(v.preferencesPage(req, { values: prefValues(req.user) }), NOINDEX('Viewing settings')));

  const prefSchema = z.object({
    autoplay: checkbox,
    daily_limit: z.preprocess(
      (x) => (typeof x === 'string' && x.trim() === '' ? null : x),
      z.union([z.null(), z.coerce.number({ error: 'Enter a number of minutes, or leave it empty.' }).int('Use a whole number of minutes.').min(10, 'Use at least 10 minutes.').max(1440, 'A day has 1,440 minutes.')]),
    ),
  });
  r.post('/settings/preferences', async (req, res) => {
    const { data, errors } = parseInput(prefSchema, req.body);
    if (errors) return res.status(422).page(v.preferencesPage(req, { values: { autoplay: req.body?.autoplay === '1', daily_limit: str(req.body?.daily_limit, 10) }, errors }), NOINDEX('Viewing settings'));
    await ctx.accounts.setPreferences(req.user.id, { autoplay: data.autoplay, dailyLimitMinutes: data.daily_limit });
    res.flash('success', 'Saved.');
    return res.redirect(303, '/settings/preferences');
  });

  // ------------------------------------------------------------------ your data

  r.get('/settings/privacy', async (req, res) => res.page(v.privacyPage(req, { blockers: await ctx.accounts.deletionBlockers(req.user.id) }), NOINDEX('Your data')));

  r.post('/settings/privacy/export', exportLimit, async (req, res) => {
    const data = await ctx.accounts.exportData(req.user.id);
    await ctx.audit.record(req.user.id, 'user.export', { targetType: 'user', targetId: req.user.id, ip: req.ip });
    const name = `${ctx.config.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-data-${dayString(ctx.clock())}.json`;
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.send(JSON.stringify(data, null, 2));
  });

  r.post('/settings/privacy/delete', sensitive, async (req, res) => {
    const errors = {};
    if (!(await ctx.auth.verifyCurrentPassword(req.user.id, str(req.body.password, 128)))) errors.password = 'That is not your password.';
    if (str(req.body.confirm, 20).trim() !== 'DELETE') errors.confirm = 'Type DELETE in capital letters.';
    const blockers = await ctx.accounts.deletionBlockers(req.user.id);
    if (Object.keys(errors).length || blockers.length) return res.status(422).page(v.privacyPage(req, { blockers, errors }), NOINDEX('Your data'));
    await ctx.accounts.deleteAccount(req.user.id, { ip: req.ip });
    res.expireCookie(COOKIES.session);
    res.flash('info', 'Your account has been deleted.');
    return res.redirect(303, '/');
  });

  return r;
}

export const settingsMount = { attach: (app, ctx) => app.use(settingsRoutes(ctx)) };
