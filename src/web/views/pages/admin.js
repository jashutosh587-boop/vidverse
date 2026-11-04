import { html, ariaCurrent } from '../../../lib/html.js';
import { formatDateTime, formatMoney } from '../../../lib/format.js';
import { REPORT_REASONS } from '../../../services/moderation.js';
import { field, csrfField, tabs, emptyState, pager } from '../components.js';

const REASON = Object.fromEntries(REPORT_REASONS);
const money = (m, minor) => formatMoney(minor, m.currency);

const STAFF_TABS = [
  { id: 'overview', href: '/admin', label: 'Overview' },
  { id: 'reports', href: '/admin/reports', label: 'Reports' },
  { id: 'users', href: '/admin/users', label: 'People' },
  { id: 'videos', href: '/admin/videos', label: 'Videos' },
  { id: 'messages', href: '/admin/messages', label: 'Messages' },
];
const ADMIN_TABS = [
  { id: 'jobs', href: '/admin/jobs', label: 'Jobs' },
  { id: 'audit', href: '/admin/audit', label: 'Audit log' },
];
const MONEY_TABS = [
  { id: 'payouts', href: '/admin/payouts', label: 'Payouts' },
  { id: 'payments', href: '/admin/payments', label: 'Tips' },
  { id: 'revenue', href: '/admin/revenue', label: 'Revenue shares' },
];

function head(req, title, active, actions = '') {
  const admin = req.user.role === 'admin';
  const items = [...STAFF_TABS, ...(admin && req.ctx.monetization ? MONEY_TABS : []), ...(admin ? ADMIN_TABS : [])];
  return html`<header class="pagehead"><h1>${title}</h1>${actions}</header>${tabs(items, active)}`;
}

const statusPills = (current, base, options) => html`<nav class="chips" aria-label="Filter">${options.map(([id, label]) => html`<a class="chip" href="${base}${base.includes('?') ? '&' : '?'}status=${id}" ${ariaCurrent(id === current)}>${label}</a>`)}</nav>`;
const searchForm = (action, q, placeholder, extra = '', what = 'List') => html`<form class="searchrow" role="search" aria-label="${what}" method="get" action="${action}">${extra}<label class="sr-only" for="adm-q">Search</label><input class="input" id="adm-q" name="q" type="search" value="${q}" placeholder="${placeholder}" maxlength="100"><button class="btn" type="submit">Search</button></form>`;

// ---------------------------------------------------------------------------------------------- overview

export function overviewPage(req, { stats, summary, recent, m }) {
  const admin = req.user.role === 'admin';
  const card = (n, label, href, urgent = false) => html`<div class="stat ${urgent && n > 0 ? 'stat-alert' : ''}"><p class="statnum">${n}</p><p class="muted">${href ? html`<a href="${href}">${label}</a>` : label}</p></div>`;
  return html`<div class="page">
    ${head(req, 'Admin', 'overview')}
    <section class="stats" aria-label="Needs attention">
      ${card(stats.reports_child, 'Child safety reports to review first', '/admin/reports', true)}
      ${card(stats.reports_open, 'Open reports', '/admin/reports', true)}
      ${card(stats.messages_open, 'Open messages from people', '/admin/messages', true)}
      ${admin && m ? card(stats.payouts_open, 'Payout requests waiting', '/admin/payouts', true) : ''}
      ${admin ? card(stats.jobs_failed, 'Failed background jobs', '/admin/jobs', true) : ''}
    </section>
    <section class="stats" aria-label="The site">
      ${card(stats.users, 'People with an account')}
      ${card(stats.creators, 'Creators (accepted the creator terms)')}
      ${card(stats.videos_ready, 'Videos online')}
      ${card(stats.videos_processing, 'Videos being processed')}
      ${card(stats.videos_failed, 'Videos that failed to process')}
    </section>
    ${summary
      ? html`<section class="panel" aria-labelledby="mon-h"><h2 id="mon-h">Money held</h2>
          <dl class="kv">
            <dt>Owed to creators (available and pending)</dt><dd>${money(m, summary.owedToCreators)}</dd>
            <dt>Of which belongs to closed or suspended accounts</dt><dd>${money(m, summary.heldForInactiveAccounts)}</dd>
            <dt>Platform fees earned</dt><dd>${money(m, summary.platformEarned)}</dd>
          </dl>
          <p class="muted">Money owed to creators sits in your payment provider account until you pay it out. Keep at least that much there. Platform fees are before the provider’s own charges and before tax.</p>
        </section>`
      : ''}
    ${admin
      ? html`<section aria-labelledby="rec-h"><h2 id="rec-h">Latest actions</h2>${auditTable(recent)}<p><a href="/admin/audit">Full audit log</a></p></section>`
      : ''}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- reports

export function reportsPage(req, { items, hasMore, page, status }) {
  return html`<div class="page">
    ${head(req, 'Reports', 'reports')}
    ${statusPills(status, '/admin/reports', [['open', 'Open'], ['actioned', 'Acted on'], ['dismissed', 'Dismissed']])}
    ${items.length
      ? html`<div class="stack">${items.map((r) => html`<article class="panel report ${r.reason === 'child_safety' ? 'report-urgent' : ''}">
          <h2>${REASON[r.reason] ?? r.reason}${r.reason === 'child_safety' ? html` <span class="pill pill-bad">Review first</span>` : ''}</h2>
          <p><strong>${r.target_type}</strong>: ${r.target_type === 'video' ? html`<a href="/watch/${r.target_id}">${r.target_label ?? r.target_id}</a>` : (r.target_label ?? r.target_id)}
            <span class="muted"> · reported by ${r.reporter_handle ? `@${r.reporter_handle}` : 'a deleted account'} · ${formatDateTime(r.created_at)}${r.open_for_target > 1 ? ` · ${r.open_for_target} open reports on this` : ''}</span></p>
          ${r.details ? html`<blockquote class="quote">${r.details}</blockquote>` : ''}
          ${r.status === 'open'
            ? html`<form method="post" action="/admin/reports/${r.id}" class="stack">
                ${csrfField(req)}
                <fieldset class="choice"><legend>Decision</legend>
                  <label class="check"><input type="radio" name="decision" value="dismiss" required> <span>Dismiss</span></label>
                  ${r.target_type !== 'user' ? html`<label class="check"><input type="radio" name="decision" value="remove"> <span>Remove the ${r.target_type}</span></label>` : ''}
                  <label class="check"><input type="radio" name="decision" value="suspend"> <span>Suspend the account</span></label>
                </fieldset>
                ${field({ name: `note-${r.id}`, label: 'Note (shown to the creator when something is removed)', maxlength: 300 })}
                <p><button class="btn btn-primary" type="submit">Save decision</button></p>
              </form>`
            : html`<p class="muted">${r.status === 'actioned' ? 'Acted on' : 'Dismissed'} ${r.handled_at ? formatDateTime(r.handled_at) : ''}${r.resolution_note ? `: ${r.resolution_note}` : ''}</p>`}
        </article>`)}</div>
        ${pager({ page, hasMore, path: '/admin/reports', params: { status } })}`
      : emptyState({ title: status === 'open' ? 'Nothing waiting' : 'Nothing here', body: status === 'open' ? 'No open reports.' : 'No reports with that status.' })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- people

export function usersPage(req, { items, hasMore, page, q }) {
  const admin = req.user.role === 'admin';
  return html`<div class="page">
    ${head(req, 'People', 'users')}
    ${searchForm('/admin/users', q, admin ? 'Handle, name or email' : 'Handle or name', '', 'People')}
    ${items.length
      ? html`<div class="tablewrap"><table class="table">
          <caption class="sr-only">People</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col" class="num">Videos</th><th scope="col">Joined</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${items.map((u) => html`<tr>
            <th scope="row"><a href="/@${u.handle}">${u.display_name}</a><div class="muted">@${u.handle}${admin && u.status !== 'deleted' ? html` · ${u.email}` : ''}</div></th>
            <td>${u.role}</td>
            <td>${u.status}${u.suspended_reason ? html`<div class="muted">${u.suspended_reason}</div>` : ''}</td>
            <td class="num">${u.videos}</td>
            <td>${formatDateTime(u.created_at)}</td>
            <td class="actions">${u.status === 'deleted' || u.id === req.user.id ? '' : userActions(req, u, admin)}</td>
          </tr>`)}</tbody></table></div>
        ${pager({ page, hasMore, path: '/admin/users', params: q ? { q } : {} })}`
      : emptyState({ title: 'No one found', body: 'Try a different search.' })}
  </div>`;
}

function userActions(req, u, admin) {
  const parts = [];
  if (u.status === 'active' && !(u.role === 'admin' && !admin)) {
    parts.push(html`<form method="post" action="/admin/users/${u.id}/suspend" class="inline">${csrfField(req)}<label class="sr-only" for="why-${u.id}">Reason</label><input class="input input-sm" id="why-${u.id}" name="reason" placeholder="Reason" maxlength="300" required><button class="btn btn-danger" type="submit">Suspend</button></form>`);
  }
  if (u.status === 'suspended') parts.push(html`<form method="post" action="/admin/users/${u.id}/restore" class="inline">${csrfField(req)}<button class="btn" type="submit">Restore</button></form>`);
  if (admin && u.role !== 'admin' && u.status === 'active') {
    parts.push(html`<form method="post" action="/admin/users/${u.id}/role" class="inline">${csrfField(req)}<input type="hidden" name="role" value="${u.role === 'moderator' ? 'user' : 'moderator'}"><button class="btn btn-quiet" type="submit">${u.role === 'moderator' ? 'Make an ordinary member' : 'Make a moderator'}</button></form>`);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------- videos

export function videosPage(req, { items, hasMore, page, q, status }) {
  return html`<div class="page">
    ${head(req, 'Videos', 'videos')}
    ${statusPills(status, `/admin/videos${q ? `?q=${encodeURIComponent(q)}` : ''}`, [['all', 'All'], ['ready', 'Online'], ['processing', 'Processing'], ['failed', 'Failed'], ['removed', 'Removed']])}
    ${searchForm('/admin/videos', q, 'Title or video id', html`<input type="hidden" name="status" value="${status}">`, 'Videos')}
    ${items.length
      ? html`<div class="tablewrap"><table class="table">
          <caption class="sr-only">Videos</caption>
          <thead><tr><th scope="col">Video</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col" class="num">Views</th><th scope="col">Uploaded</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${items.map((v) => html`<tr>
            <th scope="row"><a href="/watch/${v.id}">${v.title}</a><div class="muted"><code>${v.id}</code> · ${v.visibility}</div></th>
            <td><a href="/@${v.handle}">@${v.handle}</a></td>
            <td>${v.status}${v.removed_reason ? html`<div class="muted">${v.removed_reason}</div>` : ''}</td>
            <td class="num">${v.views}</td>
            <td>${formatDateTime(v.created_at)}</td>
            <td class="actions">${v.status === 'removed'
              ? html`<form method="post" action="/admin/videos/${v.id}/restore" class="inline">${csrfField(req)}<button class="btn" type="submit">Restore</button></form>`
              : html`<form method="post" action="/admin/videos/${v.id}/remove" class="inline">${csrfField(req)}<label class="sr-only" for="vr-${v.id}">Reason</label><input class="input input-sm" id="vr-${v.id}" name="reason" placeholder="Reason, shown to the creator" maxlength="300" required><button class="btn btn-danger" type="submit">Remove</button></form>`}</td>
          </tr>`)}</tbody></table></div>
        ${pager({ page, hasMore, path: '/admin/videos', params: { status, ...(q ? { q } : {}) } })}`
      : emptyState({ title: 'No videos found', body: 'Try a different filter or search.' })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- messages

export function messagesPage(req, { items, hasMore, page, status }) {
  return html`<div class="page">
    ${head(req, 'Messages', 'messages')}
    ${statusPills(status, '/admin/messages', [['open', 'Open'], ['closed', 'Closed']])}
    ${items.length
      ? html`<div class="stack">${items.map((m) => html`<article class="panel">
          <h2>${m.subject}</h2>
          <p class="muted">${m.user_handle ? html`<a href="/@${m.user_handle}">@${m.user_handle}</a> · ` : ''}${req.user.role === 'admin' || !m.user_handle ? m.email : 'email hidden'} · ${formatDateTime(m.created_at)}</p>
          <pre class="msgbody">${m.body}</pre>
          <form method="post" action="/admin/messages/${m.id}/status" class="inline">${csrfField(req)}<input type="hidden" name="status" value="${m.status === 'open' ? 'closed' : 'open'}"><button class="btn" type="submit">${m.status === 'open' ? 'Mark as handled' : 'Reopen'}</button></form>
          ${req.user.role === 'admin' || !m.user_handle ? html` <a class="btn btn-quiet" href="mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.subject}`)}">Reply by email</a>` : ''}
        </article>`)}</div>
        ${pager({ page, hasMore, path: '/admin/messages', params: { status } })}`
      : emptyState({ title: 'No messages', body: status === 'open' ? 'Nobody is waiting for an answer.' : 'No closed messages.' })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- payouts

export function adminPayoutsPage(req, { items, hasMore, page, status, m }) {
  return html`<div class="page">
    ${head(req, 'Payouts', 'payouts')}
    ${statusPills(status, '/admin/payouts', [['open', 'Waiting'], ['paid', 'Paid'], ['rejected', 'Declined'], ['cancelled', 'Cancelled'], ['all', 'All']])}
    <p class="muted">You cannot approve, pay or decline your own request. Looking at someone’s payout details needs your password and is written to the audit log.</p>
    ${items.length
      ? html`<div class="stack">${items.map((p) => html`<article class="panel">
          <h2>${money(m, p.amount_minor)} <span class="pill">${p.status}</span></h2>
          <p><a href="/@${p.handle}">${p.display_name}</a> <span class="muted">@${p.handle} · ${p.email} · requested ${formatDateTime(p.requested_at)} · to ${p.method === 'upi' ? 'UPI' : 'bank account'} <code>${p.display_hint}</code></span></p>
          ${p.status === 'paid' ? html`<p class="muted">Paid ${formatDateTime(p.paid_at)}, reference ${p.paid_reference}</p>` : ''}
          ${p.status === 'rejected' ? html`<p class="muted">Declined: ${p.note}</p>` : ''}
          ${p.status === 'requested' || p.status === 'approved'
            ? html`<div class="stack">
                ${p.user_id === req.user.id ? html`<p class="flash flash-info">This is your own request. Someone else has to handle it.</p>` : html`
                <form method="post" action="/admin/payouts/${p.id}/reveal" class="rowflex wrap">${csrfField(req)}<label class="sr-only" for="pw-${p.id}">Your password</label><input class="input input-sm" id="pw-${p.id}" name="password" type="password" autocomplete="current-password" placeholder="Your password" required><button class="btn" type="submit">Show where to pay</button></form>
                ${p.status === 'requested' ? html`<form method="post" action="/admin/payouts/${p.id}/approve" class="inline">${csrfField(req)}<button class="btn" type="submit">Approve</button></form>` : ''}
                <form method="post" action="/admin/payouts/${p.id}/paid" class="rowflex wrap">${csrfField(req)}<label class="sr-only" for="ref-${p.id}">Payment reference</label><input class="input input-sm" id="ref-${p.id}" name="reference" placeholder="Payment reference, such as the UPI transaction id" maxlength="100" required><button class="btn btn-primary" type="submit">Mark as paid</button></form>
                <form method="post" action="/admin/payouts/${p.id}/reject" class="rowflex wrap">${csrfField(req)}<label class="sr-only" for="rj-${p.id}">Reason</label><input class="input input-sm" id="rj-${p.id}" name="reason" placeholder="Reason, shown to the creator" maxlength="300" required><button class="btn btn-danger" type="submit">Decline</button></form>`}
              </div>`
            : ''}
        </article>`)}</div>
        ${pager({ page, hasMore, path: '/admin/payouts', params: { status } })}`
      : emptyState({ title: 'No payouts here', body: status === 'open' ? 'No requests are waiting.' : 'Nothing with that status.' })}
  </div>`;
}

export function payoutDetailsPage(req, { payout, details, m }) {
  return html`<div class="page narrow">
    ${head(req, 'Where to pay', 'payouts')}
    <div class="flash flash-info" role="note">This view was written to the audit log. Do not copy these details anywhere except your bank or UPI app.</div>
    <section class="panel">
      <p><strong>${money(m, payout.amount_minor)}</strong> to ${payout.display_name} (@${payout.handle})</p>
      <dl class="kv">
        <dt>Method</dt><dd>${details.method === 'upi' ? 'UPI' : 'Bank account'}</dd>
        ${details.method === 'upi'
          ? html`<dt>UPI address</dt><dd><code>${details.upi}</code></dd>`
          : html`<dt>Account holder</dt><dd>${details.holder}</dd><dt>Account number</dt><dd><code>${details.account}</code></dd><dt>IFSC</dt><dd><code>${details.ifsc}</code></dd>`}
      </dl>
    </section>
    <p><a class="btn btn-primary" href="/admin/payouts">Back to payouts</a></p>
  </div>`;
}

// ---------------------------------------------------------------------------------------------- tips

export function adminPaymentsPage(req, { items, hasMore, page, status, m }) {
  return html`<div class="page">
    ${head(req, 'Tips', 'payments')}
    ${statusPills(status, '/admin/payments', [['all', 'All'], ['paid', 'Paid'], ['created', 'Waiting'], ['expired', 'Expired'], ['failed', 'Failed'], ['refunded', 'Refunded']])}
    <p class="muted">A refund here corrects our books: it takes the tip out of the creator’s balance. The money itself goes back to the payer from your payment provider’s dashboard.</p>
    ${items.length
      ? html`<div class="tablewrap"><table class="table">
          <caption class="sr-only">Tips</caption>
          <thead><tr><th scope="col">When</th><th scope="col">From</th><th scope="col">To</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Fee</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${items.map((p) => html`<tr>
            <td>${formatDateTime(p.created_at)}<div class="muted">${p.provider}</div></td>
            <td>${p.payer_handle ? `@${p.payer_handle}` : 'removed account'}</td>
            <td>@${p.channel_handle}</td>
            <td class="num">${money(m, p.amount_minor)}</td><td class="num">${money(m, p.fee_minor)}</td>
            <td>${p.status}</td>
            <td class="actions">${p.status === 'paid' ? html`<form method="post" action="/admin/payments/${p.id}/refund" class="inline">${csrfField(req)}<label class="sr-only" for="rf-${p.id}">Reason</label><input class="input input-sm" id="rf-${p.id}" name="reason" placeholder="Reason" maxlength="300" required><button class="btn btn-danger" type="submit">Refund</button></form>` : ''}</td>
          </tr>`)}</tbody></table></div>
        ${pager({ page, hasMore, path: '/admin/payments', params: { status } })}`
      : emptyState({ title: 'No tips here', body: 'Nothing with that status.' })}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- revenue shares

const SOURCES = [
  ['sponsorship', 'A sponsor paid us'],
  ['membership', 'Memberships or subscriptions'],
  ['manual', 'Another source'],
  ['adsense', 'Google AdSense (only with Google’s written permission)'],
];

export function revenueListPage(req, { batches, values = {}, errors = {}, m }) {
  return html`<div class="page">
    ${head(req, 'Revenue shares', 'revenue')}
    <div class="flash flash-info" role="note"><strong>Google AdSense money cannot normally be shared.</strong> Google’s AdSense program policies do not let a publisher pass AdSense earnings to other people without Google’s written permission, which is rarely given. Use this page for money that is yours to share, such as a sponsor’s payment. Leave AdSense earnings with the site.</div>
    <p>This divides money you have already received among creators, in proportion to the watch time of their videos in a period. You see exactly who gets what before anything is booked.</p>
    <section class="panel" aria-labelledby="new-h"><h2 id="new-h">New batch</h2>
      ${errors._ ? html`<div class="flash flash-error" role="alert">${errors._}</div>` : ''}
      <form method="post" action="/admin/revenue" class="stack" novalidate>
        ${csrfField(req)}
        ${field({ name: 'label', label: 'Name', value: values.label ?? '', error: errors.label, maxlength: 100, required: true, hint: 'Creators see this next to their share, such as “October sponsor”.' })}
        ${field({ name: 'source', label: 'Where the money came from', type: 'select', value: values.source ?? 'sponsorship', error: errors.source, options: SOURCES.map(([value, label]) => ({ value, label })) })}
        ${field({ name: 'gross', label: 'Amount received, in rupees', value: values.gross ?? '', error: errors.gross, inputmode: 'decimal', required: true, autocomplete: 'off' })}
        ${field({ name: 'share', label: 'Share for creators, in percent', value: values.share ?? '70', error: errors.share, inputmode: 'decimal', required: true, autocomplete: 'off', hint: 'The rest stays with the site.' })}
        ${field({ name: 'periodStart', label: 'Watch time from', type: 'date', value: values.periodStart ?? '', error: errors.periodStart, required: true })}
        ${field({ name: 'periodEnd', label: 'Watch time until (included)', type: 'date', value: values.periodEnd ?? '', error: errors.periodEnd, required: true })}
        ${field({ name: 'google_permission', type: 'checkbox', label: 'This money is Google AdSense money, and I hold Google’s written permission to share it with creators', value: values.google_permission, hint: 'Only tick this if it is true. Sharing AdSense earnings without permission can end your AdSense account.' })}
        <p><button class="btn btn-primary" type="submit">Create draft and preview</button></p>
      </form>
    </section>
    <section aria-labelledby="all-h"><h2 id="all-h">Batches</h2>
      ${batches.length
        ? html`<div class="tablewrap"><table class="table">
            <caption class="sr-only">Revenue share batches</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Period</th><th scope="col" class="num">Received</th><th scope="col" class="num">Creators’ pool</th><th scope="col">Status</th></tr></thead>
            <tbody>${batches.map((b) => html`<tr>
              <th scope="row"><a href="/admin/revenue/${b.id}">${b.label}</a><div class="muted">${b.source}</div></th>
              <td>${b.period_start} to ${b.period_end}</td>
              <td class="num">${money(m, b.gross_minor)}</td>
              <td class="num">${b.pool_minor !== null ? money(m, b.pool_minor) : `${b.creator_share_bps / 100}%`}</td>
              <td>${b.status === 'posted' ? html`<span class="pill pill-ok">Posted</span>` : html`<span class="pill">Draft</span>`}</td>
            </tr>`)}</tbody></table></div>`
        : emptyState({ title: 'No batches yet', body: 'Create one when you have money to share.' })}
    </section>
  </div>`;
}

export function revenueBatchPage(req, { batch, preview, m, error = '' }) {
  return html`<div class="page">
    ${head(req, batch.label, 'revenue')}
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <dl class="kv">
      <dt>Source</dt><dd>${batch.source}${batch.source === 'adsense' ? ' (permission stated)' : ''}</dd>
      <dt>Period</dt><dd>${batch.period_start} to ${batch.period_end}</dd>
      <dt>Received</dt><dd>${money(m, batch.gross_minor)}</dd>
      <dt>Creators’ share</dt><dd>${batch.creator_share_bps / 100}%</dd>
      <dt>Creators’ pool</dt><dd>${money(m, preview.pool)}</dd>
      <dt>Status</dt><dd>${batch.status === 'posted' ? `Posted ${formatDateTime(batch.posted_at)}` : 'Draft: nothing booked yet'}</dd>
    </dl>
    ${preview.rows.length
      ? html`<div class="tablewrap"><table class="table">
          <caption class="sr-only">Who gets what</caption>
          <thead><tr><th scope="col">Creator</th><th scope="col" class="num">Watch time</th><th scope="col" class="num">Share</th></tr></thead>
          <tbody>${preview.rows.map((r) => html`<tr><th scope="row"><a href="/@${r.handle}">@${r.handle}</a></th><td class="num">${(r.watchMs / 3_600_000).toFixed(1)} hours</td><td class="num">${money(m, r.amountMinor)}</td></tr>`)}</tbody></table></div>`
      : emptyState({ title: 'Nobody to pay', body: 'No creator has qualified watch time in that period.' })}
    ${batch.status === 'draft' && preview.rows.length
      ? html`<form method="post" action="/admin/revenue/${batch.id}/post" class="stack">
          ${csrfField(req)}
          ${field({ name: 'confirm', type: 'checkbox', label: `Yes, add these ${preview.rows.length} shares to the creators’ balances. This cannot be undone.`, required: true })}
          <p><button class="btn btn-primary" type="submit">Post shares</button> <a class="btn btn-quiet" href="/admin/revenue">Back</a></p>
        </form>`
      : html`<p><a class="btn" href="/admin/revenue">Back to batches</a></p>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------- jobs, audit

export function jobsPage(req, { stats, failures }) {
  return html`<div class="page">
    ${head(req, 'Jobs', 'jobs')}
    <section class="stats" aria-label="Background jobs">${['queued', 'running', 'done', 'failed'].map((s) => html`<div class="stat"><p class="statnum">${stats[s] ?? 0}</p><p class="muted">${s}</p></div>`)}</section>
    <section aria-labelledby="fail-h"><h2 id="fail-h">Recent failures</h2>
      ${failures.length
        ? html`<div class="tablewrap"><table class="table">
            <caption class="sr-only">Failed jobs</caption>
            <thead><tr><th scope="col">Job</th><th scope="col">Error</th><th scope="col">Tries</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${failures.map((j) => html`<tr><td><code>${j.kind}</code><div class="muted">#${j.id} · ${j.finished_at ? formatDateTime(j.finished_at) : ''}</div></td><td>${String(j.last_error ?? '').slice(0, 300)}</td><td class="num">${j.attempts}</td>
              <td><form method="post" action="/admin/jobs/${j.id}/retry" class="inline">${csrfField(req)}<button class="btn" type="submit">Try again</button></form></td></tr>`)}</tbody></table></div>`
        : emptyState({ title: 'No failures', body: 'Every background job has worked.' })}
    </section>
  </div>`;
}

function auditTable(items) {
  if (!items.length) return emptyState({ title: 'Nothing yet', body: 'Actions will be listed here.' });
  return html`<div class="tablewrap"><table class="table">
    <caption class="sr-only">Audit log</caption>
    <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">On</th><th scope="col">Details</th></tr></thead>
    <tbody>${items.map((a) => html`<tr>
      <td>${formatDateTime(a.created_at)}</td>
      <td>${a.actor_handle ? `@${a.actor_handle}` : 'system'}${a.ip_prefix ? html`<div class="muted">${a.ip_prefix}</div>` : ''}</td>
      <td><code>${a.action}</code></td>
      <td class="muted">${a.target_type ? `${a.target_type} ${String(a.target_id ?? '').slice(0, 13)}` : ''}</td>
      <td class="muted">${Object.keys(a.meta ?? {}).length ? JSON.stringify(a.meta).slice(0, 160) : ''}</td>
    </tr>`)}</tbody></table></div>`;
}

export function auditPage(req, { items, hasMore, page }) {
  return html`<div class="page">
    ${head(req, 'Audit log', 'audit')}
    <p class="muted">Every administrative action, payout, refund and security change is recorded here. Entries hold no passwords or secrets.</p>
    ${auditTable(items)}
    ${pager({ page, hasMore, path: '/admin/audit' })}
  </div>`;
}
