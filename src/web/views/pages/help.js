import { html } from '../../../lib/html.js';
import { field, csrfField, icon } from '../components.js';

export const CONTACT_TOPICS = [
  ['account', 'Account or sign-in problem'],
  ['video', 'A video or an upload'],
  ['money', 'Tips, earnings or payouts'],
  ['copyright', 'Copyright'],
  ['privacy', 'Privacy or my data'],
  ['safety', 'Safety or abuse'],
  ['feedback', 'Feedback or an idea'],
  ['other', 'Something else'],
];
export const TOPIC_IDS = CONTACT_TOPICS.map(([id]) => id);
export const topicLabel = (id) => CONTACT_TOPICS.find(([k]) => k === id)?.[1] ?? 'Something else';

const searchBox = (query = '') => html`<form class="helpsearch" role="search" aria-label="Help articles" action="/help" method="get">
  <label class="sr-only" for="help-q">Search the help center</label>
  <input id="help-q" class="input" type="search" name="q" value="${query}" maxlength="300" placeholder="Search, for example: how do payouts work?" autocomplete="off">
  <button class="btn btn-primary" type="submit">${icon('search')}<span>Search</span></button>
</form>`;

export function helpIndexPage(req, { groups, query = '', search = null }) {
  return html`<div class="page">
    <header class="pagehead"><h1>Help center</h1><p class="lede">Answers about watching, uploading, earning and your account.</p></header>
    ${searchBox(query)}
    ${search
      ? search.found
        ? html`<section aria-labelledby="results-h"><h2 id="results-h">Best matches</h2>
            <ul class="helpgrid helpresults">${search.results.map((r) => html`<li><a href="${r.url}"><strong>${r.title}</strong>${r.heading !== r.title ? html`<em>${r.heading}</em>` : ''}<span>${r.snippet}</span></a></li>`)}</ul>
          </section>`
        : html`<section class="empty"><h2>Nothing in the help center matches that</h2><p>Try different words, or write to us and a person will reply.</p><p><a class="btn btn-primary" href="/contact">Contact us</a></p></section>`
      : ''}
    ${groups.map(
      (g) => html`<section aria-labelledby="g-${g.id}"><h2 id="g-${g.id}">${g.title}</h2>
        <ul class="helpgrid">${g.articles.map((a) => html`<li><a href="/help/${a.slug}"><strong>${a.title}</strong><span>${a.summary}</span></a></li>`)}</ul>
      </section>`,
    )}
    <p class="muted">Cannot find what you need? <a href="/contact">Contact us</a>, or read the <a href="/legal">policies</a>.</p>
  </div>`;
}

export function helpArticlePage(req, { article, related }) {
  return html`<article class="page prose">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/help">Help center</a></nav>
    <h1>${article.title}</h1>
    <p class="lede">${article.summary}</p>
    ${article.toc.length >= 3 ? html`<nav class="toc" aria-label="On this page"><ul>${article.toc.map((t) => html`<li><a href="#${t.anchor}">${t.heading}</a></li>`)}</ul></nav>` : ''}
    ${article.html}
    ${related.length ? html`<section aria-labelledby="rel-h"><h2 id="rel-h">Related</h2><ul>${related.map((a) => html`<li><a href="/help/${a.slug}">${a.title}</a></li>`)}</ul></section>` : ''}
    <p class="muted">Did this not answer your question? <a href="/contact">Contact us</a>.</p>
  </article>`;
}

export function draftNotice() {
  return html`<div class="flash flash-info draftnotice" role="note"><strong>Draft.</strong> This document is waiting for legal review and may change. It describes how the site works today.</div>`;
}

export function legalIndexPage(req, { pages, draft }) {
  return html`<div class="page">
    <header class="pagehead"><h1>Policies</h1><p class="lede">The rules for using the site, and how we look after your data.</p></header>
    ${draft ? draftNotice() : ''}
    <ul class="helpgrid">${pages.map((p) => html`<li><a href="/legal/${p.slug}"><strong>${p.title}</strong><span>${p.summary}</span></a></li>`)}</ul>
  </div>`;
}

export function legalPage(req, { page, pages }) {
  return html`<article class="page prose">
    <nav class="crumbs" aria-label="Policies"><a href="/legal">Policies</a>${pages.filter((p) => p.slug !== page.slug).map((p) => html` <a href="/legal/${p.slug}">${p.title}</a>`)}</nav>
    ${page.draft ? draftNotice() : ''}
    <h1>${page.title}</h1>
    <p class="muted">Applies from ${page.effective}</p>
    ${page.html}
  </article>`;
}

export function legalAcceptPage(req, { next, effective }) {
  return html`<section class="authcard">
    <h1>We updated our terms</h1>
    <p class="lede">Our Terms of Service and Privacy Policy changed. They apply from ${effective}. Please read them and accept to keep using your account.</p>
    <ul>
      <li><a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a></li>
      <li><a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a></li>
      <li><a href="/legal/community-guidelines" target="_blank" rel="noopener">Community Guidelines</a></li>
      <li><a href="/legal/cookies-and-ads" target="_blank" rel="noopener">Cookies and ads</a></li>
    </ul>
    <form method="post" action="/legal/accept" class="stack">
      ${csrfField(req)}
      <input type="hidden" name="next" value="${next}">
      ${field({ name: 'agree', type: 'checkbox', label: 'I have read and accept the updated Terms and Privacy Policy.', required: true })}
      <button class="btn btn-primary btn-block" type="submit">Accept and continue</button>
    </form>
    <form method="post" action="/logout" class="stack">${csrfField(req)}<button class="btn btn-quiet btn-block" type="submit">Sign out instead</button></form>
  </section>`;
}

export function contactPage(req, { values = {}, errors = {}, notice = '' }) {
  const email = req.user?.email;
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Contact us</h1><p class="lede">A person reads every message. Most replies take a few working days.</p></header>
    <p class="muted">Looking for a quick answer? Try the <a href="/help">help center</a> first. To report a video or comment, use the <strong>Report</strong> link next to it. Complaints and privacy requests can also go to the <a href="/legal/grievance">grievance officer</a>.</p>
    ${notice ? html`<div class="flash flash-success" role="status">${notice}</div>` : ''}
    <form method="post" action="/contact" class="stack" novalidate>
      ${csrfField(req)}
      ${email
        ? html`<p>We will reply to <strong>${email}</strong>.</p>`
        : field({ name: 'email', label: 'Your email address', type: 'email', value: values.email ?? '', error: errors.email, hint: 'We reply here. We never share it.', autocomplete: 'email', required: true })}
      ${field({ name: 'topic', label: 'What is it about?', type: 'select', value: values.topic ?? 'other', error: errors.topic, options: CONTACT_TOPICS.map(([value, label]) => ({ value, label })) })}
      <p class="hint">For a copyright notice, include everything listed in the <a href="/legal/copyright">copyright policy</a>. Never send your password or a one-time code.</p>
      ${field({ name: 'subject', label: 'Subject', value: values.subject ?? '', error: errors.subject, maxlength: 120, required: true })}
      ${field({ name: 'message', label: 'Message', type: 'textarea', rows: 8, value: values.message ?? '', error: errors.message, maxlength: 5000, required: true, hint: 'What were you trying to do, and what happened? Add the address of the page if you can.' })}
      <div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <button class="btn btn-primary" type="submit">Send message</button>
    </form>
  </div>`;
}
