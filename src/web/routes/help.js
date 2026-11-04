import express from 'express';
import { z } from 'zod';
import { LEGAL_VERSION } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { safeLocalPath } from '../../lib/html.js';
import { cleanText, emailSchema, parseInput } from '../../lib/validate.js';
import { limit } from '../middleware/limit.js';
import { requireUser } from '../guards.js';
import * as v from '../views/pages/help.js';

const contactSchema = z.object({
  topic: z.enum(v.TOPIC_IDS, { error: 'Choose a topic.' }),
  subject: cleanText({ min: 1, max: 120, label: 'Subject' }),
  message: cleanText({ min: 10, max: 5000, multiline: true, label: 'Message' }),
});

const URL_RE = /https?:\/\/|www\./gi;

/** Help center, policies, the contact form and the help assistant. */
export const helpMount = {
  attach(app, ctx) {
    const { config, content } = ctx;
    const r = express.Router();
    const searchLimit = limit(ctx, { name: 'help-search', limit: 60, windowMs: 60_000 });
    const assistantLimit = limit(ctx, { name: 'assistant', limit: 12, windowMs: 60_000, key: (req) => req.user?.id ?? req.ip });
    const assistantHourly = limit(ctx, { name: 'assistant-hour', limit: 100, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });
    const contactLimit = limit(ctx, { name: 'contact', limit: 5, windowMs: 3600_000 });

    // ---- help center
    r.get('/help', searchLimit, async (req, res) => {
      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 300) : '';
      const search = query ? content.help.search(query) : null;
      await res.page(v.helpIndexPage(req, { groups: content.help.groups(), query, search }), {
        title: query ? 'Search the help center' : 'Help center',
        description: `Answers about watching, uploading, earning and your account on ${config.siteName}.`,
        canonical: query ? undefined : '/help',
        noindex: Boolean(query),
      });
    });

    r.get('/help/:slug', async (req, res) => {
      const article = content.help.article(req.params.slug);
      if (!article) throw new HttpError(404, 'We could not find that help article.');
      const related = article.related.map((s) => content.help.article(s)).filter(Boolean);
      await res.page(v.helpArticlePage(req, { article, related }), { title: article.title, description: article.summary, canonical: `/help/${article.slug}` });
    });

    // ---- the assistant
    r.post('/api/assistant', assistantLimit, assistantHourly, async (req, res) => {
      const q = typeof req.body?.q === 'string' ? req.body.q : '';
      if (!q.trim() || q.length > 2000) throw new HttpError(422, 'Type a question of up to 500 characters.', { code: 'validation' });
      const out = await content.help.answer(q);
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    });

    // ---- policies
    r.get('/legal', async (req, res) => {
      await res.page(v.legalIndexPage(req, { pages: content.legal.pages(), draft: !config.legal.reviewed }), { title: 'Policies', canonical: '/legal' });
    });

    r.get('/legal/accept', requireUser, async (req, res) => {
      const next = safeLocalPath(req.query.next, '/');
      if (req.user.terms_version === LEGAL_VERSION) return res.redirect(303, next);
      await res.page(v.legalAcceptPage(req, { next, effective: content.values.effectiveDate }), { title: 'Updated terms', noindex: true });
    });

    r.post('/legal/accept', requireUser, async (req, res) => {
      const next = safeLocalPath(req.body.next, '/');
      if (req.body.agree !== '1') {
        return res.status(422).page(v.legalAcceptPage(req, { next, effective: content.values.effectiveDate }), { title: 'Updated terms', noindex: true });
      }
      await ctx.db.query('UPDATE users SET terms_version = $2, terms_accepted_at = $3 WHERE id = $1', [req.user.id, LEGAL_VERSION, ctx.clock()]);
      await ctx.audit.record(req.user.id, 'terms.accepted', { targetType: 'user', targetId: req.user.id, meta: { version: LEGAL_VERSION }, ip: req.ip });
      res.redirect(303, next);
    });

    r.get('/legal/:slug', async (req, res) => {
      const page = content.legal.page(req.params.slug);
      if (!page) throw new HttpError(404, 'We could not find that page.');
      await res.page(v.legalPage(req, { page, pages: content.legal.pages() }), { title: page.title, description: page.summary, canonical: `/legal/${page.slug}` });
    });

    // ---- contact
    r.get('/contact', async (req, res) => {
      const topic = v.TOPIC_IDS.includes(req.query.topic) ? req.query.topic : undefined;
      await res.page(v.contactPage(req, { values: { topic } }), { title: 'Contact us', description: `Write to ${config.siteName}.`, canonical: '/contact' });
    });

    r.post('/contact', contactLimit, async (req, res) => {
      const body = req.body ?? {};
      const values = { email: String(body.email ?? '').slice(0, 254), topic: String(body.topic ?? ''), subject: String(body.subject ?? '').slice(0, 120), message: String(body.message ?? '').slice(0, 5000) };
      const again = (errors) => res.status(422).page(v.contactPage(req, { values, errors }), { title: 'Contact us', noindex: true });

      const errors = {};
      let email = req.user?.email;
      if (!email) {
        const e = parseInput(emailSchema, body.email);
        if (e.errors) errors.email = e.errors._ ?? 'Enter a valid email address.';
        else email = e.data;
      }
      const parsed = parseInput(contactSchema, body);
      if (parsed.errors) Object.assign(errors, parsed.errors);
      if (!parsed.errors) {
        const maxLinks = parsed.data.topic === 'copyright' ? 20 : 5;
        if ((parsed.data.message.match(URL_RE) ?? []).length > maxLinks) errors.message = `Please include at most ${maxLinks} links.`;
      }
      if (Object.keys(errors).length) return again(errors);

      // A hidden field only automated senders fill in: pretend it worked and keep nothing.
      if (typeof body.website === 'string' && body.website.trim() !== '') {
        res.flash('success', 'Thank you. Your message was sent.');
        return res.redirect(303, '/contact');
      }

      const { topic, subject, message } = parsed.data;
      const row = await ctx.db.one(
        'INSERT INTO contact_messages (user_id, email, subject, body, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [req.user?.id ?? null, email, `[${v.topicLabel(topic)}] ${subject}`.slice(0, 150), message, ctx.clock()],
      );
      const to = config.legal.contactEmail;
      if (to && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) {
        try {
          await ctx.mailer.send({
            to,
            replyTo: email,
            subject: `[${config.siteName}] ${v.topicLabel(topic)}: ${subject}`.slice(0, 200),
            text: [`New message #${row.id} from the contact form`, `From: ${email}${req.user ? ` (account @${req.user.handle})` : ''}`, `Topic: ${v.topicLabel(topic)}`, `Subject: ${subject}`, '', message].join('\n'),
          });
        } catch (e) {
          ctx.log.warn('contact email not sent', { id: row.id, reason: String(e?.message ?? e).slice(0, 80) });
        }
      }
      res.flash('success', `Thank you. Your message was sent. Your reference is #${row.id}.`);
      res.redirect(303, '/contact');
    });

    app.use(r);
  },
};

