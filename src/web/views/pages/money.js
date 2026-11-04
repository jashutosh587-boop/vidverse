import { html } from '../../../lib/html.js';
import { formatMoney, formatDate } from '../../../lib/format.js';
import { toDecimal } from '../../../lib/money.js';
import { field, csrfField, avatar, emptyState, pager } from '../components.js';
import { studioNav } from './studio.js';

/** Amounts offered as one-tap choices, in minor units. None is pre-selected: the viewer decides. */
export const PRESETS = [5000, 10000, 25000, 50000, 100000];

const alert = (error) => (error ? html`<div class="flash flash-error" role="alert">${error}</div>` : '');
/** "₹1,000.00" -> "₹1,000" for round amounts. */
const short = (minor, currency) => formatMoney(minor, currency).replace(/\.00$/, '');
const percent = (bps) => String(bps / 100).replace(/\.0+$/, '');

const KIND = {
  tip_net: 'Tip received',
  revenue_share: 'Share of site revenue',
  payout_request: 'Payout requested',
  payout_reversal: 'Payout returned to your balance',
  refund: 'Tip refunded',
  adjustment: 'Adjustment',
};

const PAYOUT_STATUS = {
  requested: ['Waiting for review', ''],
  approved: ['Approved, payment on the way', ''],
  paid: ['Paid', 'pill-ok'],
  rejected: ['Declined', 'pill-bad'],
  cancelled: ['Cancelled', ''],
};

// ---------------------------------------------------------------------------------------------- viewers: tipping

/** `m`: { currency, min, max, feeBps, holdDays, testMode, providerLabel } */
export function tipPage(req, { channel, video, values, errors = {}, m }) {
  const siteName = req.ctx.config.siteName;
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Support ${channel.display_name}</h1></header>
    ${m.testMode ? html`<div class="flash flash-info" role="note"><strong>Practice mode.</strong> Real payments are not switched on for this site, so no money moves. You can still try the whole flow.</div>` : ''}
    <div class="rowflex tip-who">${avatar(channel, 'lg')}<p>${video
      ? html`You are supporting <a href="/@${channel.handle}">@${channel.handle}</a> for the video <a href="/watch/${video.id}">${video.title}</a>.`
      : html`You are supporting <a href="/@${channel.handle}">@${channel.handle}</a>.`}</p></div>
    ${alert(errors._)}
    <form method="post" action="/support/@${channel.handle}" class="stack" novalidate>
      ${csrfField(req)}
      ${video ? html`<input type="hidden" name="video" value="${video.id}">` : ''}
      <fieldset class="amounts"><legend>Choose an amount</legend>
        <div class="amountrow">${PRESETS.map((p) => html`<label class="amount"><input type="radio" name="preset" value="${p / 100}" ${String(values.preset) === String(p / 100) ? 'checked' : ''}><span>${short(p, m.currency)}</span></label>`)}</div>
      </fieldset>
      ${field({ name: 'amount', label: `Or type another amount, from ${short(m.min, m.currency)} to ${short(m.max, m.currency)}`, value: values.amount, error: errors.amount, inputmode: 'decimal', autocomplete: 'off', maxlength: 12, hint: 'If you type an amount here, it is used instead of the buttons above.' })}
      ${field({ name: 'message', label: 'A message for the creator (optional)', value: values.message, error: errors.message, maxlength: 140, autocomplete: 'off' })}
      ${field({ name: 'anonymous', type: 'checkbox', label: 'Show me as Anonymous', value: values.anonymous, hint: 'The creator will not see your name. We still keep a record of who paid, in case of a problem.' })}
      <div class="panel quiet">
        <h2>How the money moves</h2>
        <ul class="plain">
          <li>You pay on a secure page run by ${m.providerLabel}, with UPI, a card or net banking. ${siteName} never sees your card or bank details.</li>
          <li>${siteName} keeps ${percent(m.feeBps)}% for payment charges and running costs. The creator receives the rest after a ${m.holdDays}-day holding period.</li>
          <li>A tip is a gift. It does not buy anything and it does not change how videos are ranked. Tips are generally not refundable. <a href="/help/tips">Read the details</a></li>
        </ul>
      </div>
      <p><button class="btn btn-support" type="submit">Continue to payment</button> <a class="btn btn-quiet" href="/@${channel.handle}">Cancel</a></p>
    </form>
  </div>`;
}

/**
 * A page between our form and the provider's page. Our content-security policy only lets forms send people to this
 * site, so the hop to the payment page is a link the person clicks.
 */
export function continuePage(req, { payment, checkoutUrl, m }) {
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Continue to payment</h1></header>
    <p>Your tip of <strong>${formatMoney(payment.amount_minor, payment.currency)}</strong> for ${payment.channel_name} is ready. You pay on ${m.providerLabel}’s page, and it brings you back here afterwards.</p>
    <p><a class="btn btn-support" href="${checkoutUrl}" data-checkout="${checkoutUrl}" rel="noopener">Continue to payment</a></p>
    <p class="muted" data-checkout-note>Nothing is charged until you finish paying there. If you leave without paying, you can start again from the channel.</p>
  </div>`;
}

export function thanksPage(req, { payment }) {
  const amount = formatMoney(payment.amount_minor, payment.currency);
  const s = payment.status;
  const back = html`<a href="/@${payment.channel_handle}">Back to ${payment.channel_name}</a>`;
  let body;
  if (s === 'paid') {
    body = html`<h1>Thank you</h1>
      <p class="lede">Your tip of <strong>${amount}</strong> to ${payment.channel_name} went through. ${payment.anonymous ? 'They will see Anonymous.' : 'They will see your name.'}</p>
      <p>${back} · <a href="/">Find more videos</a></p>`;
  } else if (s === 'created') {
    body = html`<h1>Waiting for the payment to be confirmed</h1>
      <div class="flash flash-info" role="status" data-support-wait>We have not heard back from the payment provider yet. If you finished paying, this page updates by itself within a minute or two.</div>
      <p class="muted">If you did not finish paying, ${payment.checkout_url ? html`<a href="/support/continue/${payment.id}">go back to the payment page</a>` : 'start again from the channel'}.</p>
      <p>${back}</p>`;
  } else if (s === 'refunded') {
    body = html`<h1>This tip was refunded</h1><p>The tip of ${amount} to ${payment.channel_name} was refunded.</p><p>${back}</p>`;
  } else {
    body = html`<h1>This tip was not completed</h1>
      <p>The payment of ${amount} did not go through. If money left your account anyway, this page will show it as paid within a day, or your bank will return it. If it does not, <a href="/contact">write to us</a> and quote the reference below.</p>
      <p><a class="btn btn-primary" href="/support/@${payment.channel_handle}">Try again</a> ${back}</p>`;
  }
  return html`<div class="page narrow" data-support-status="${s === 'created' ? payment.id : ''}">
    ${body}
    <p class="muted">Reference: <code>${payment.id}</code></p>
  </div>`;
}

export function testCheckoutPage(req, { payment }) {
  const amount = formatMoney(payment.amount_minor, payment.currency);
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Practice checkout</h1></header>
    <div class="flash flash-error" role="note"><strong>Practice mode.</strong> This page stands in for a payment provider. Nothing here charges anyone.</div>
    <p>Tip of <strong>${amount}</strong> for ${payment.channel_name}.</p>
    <div class="rowflex">
      <form method="post" action="/support/test-checkout/${payment.id}/pay" class="inline">${csrfField(req)}<button class="btn btn-primary" type="submit">Pretend to pay ${amount}</button></form>
      <form method="post" action="/support/test-checkout/${payment.id}/cancel" class="inline">${csrfField(req)}<button class="btn btn-quiet" type="submit">Cancel</button></form>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------- creators: earnings

export function earningsPage(req, { balances, earnings, tips, ledger, canReceive, page, now, m }) {
  const fmt = (n) => formatMoney(n, m.currency);
  return html`<div class="page">
    <header class="pagehead"><h1>Earnings</h1><a class="btn" href="/studio/earnings.csv">Download statement (CSV)</a></header>
    ${studioNav('earnings', req)}
    ${canReceive ? '' : html`<div class="flash flash-info" role="status">Viewers can send you tips once you accept the <a href="/studio/terms">creator terms</a>.</div>`}
    <section class="stats" aria-label="Your balance">
      <div class="stat"><p class="statnum">${fmt(balances.available)}</p><p class="muted">Available to withdraw</p></div>
      <div class="stat"><p class="statnum">${fmt(balances.pending)}</p><p class="muted">Pending, still in the ${m.holdDays}-day holding period</p></div>
      <div class="stat"><p class="statnum">${fmt(earnings.paidOut)}</p><p class="muted">Paid out so far</p></div>
      <div class="stat"><p class="statnum">${fmt(earnings.last28.net)}</p><p class="muted">From ${earnings.last28.tips} ${earnings.last28.tips === 1 ? 'tip' : 'tips'} in the last 28 days</p></div>
    </section>
    <p>Withdraw from the <a href="/studio/payouts">Payouts page</a>. The minimum is ${fmt(m.payoutMin)}.</p>
    <section class="panel" aria-labelledby="life-h"><h2 id="life-h">All tips so far</h2>
      <dl class="kv">
        <dt>Tips received</dt><dd>${earnings.lifetime.tips}</dd>
        <dt>Amount tipped</dt><dd>${fmt(earnings.lifetime.gross)}</dd>
        <dt>Platform fee (${percent(m.feeBps)}%)</dt><dd>−${fmt(earnings.lifetime.fees)}</dd>
        <dt>You received</dt><dd>${fmt(earnings.lifetime.net)}</dd>
      </dl>
    </section>
    <section aria-labelledby="tips-h"><h2 id="tips-h">Recent tips</h2>
      ${tips.items.length
        ? html`<div class="tablewrap"><table class="table">
            <caption class="sr-only">Recent tips</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">From</th><th scope="col">Message</th><th scope="col" class="num">Tip</th><th scope="col" class="num">Fee</th><th scope="col" class="num">You receive</th></tr></thead>
            <tbody>${tips.items.map((t) => html`<tr>
              <td>${t.paid_at ? formatDate(t.paid_at) : ''}</td>
              <td>${t.from_handle ? html`<a href="/@${t.from_handle}">${t.from_name}</a>` : 'Anonymous'}</td>
              <td>${t.message ?? ''}${t.video_title ? html`<div class="muted">On “${t.video_title}”</div>` : ''}${t.status === 'refunded' ? html` <span class="pill pill-bad">Refunded</span>` : ''}</td>
              <td class="num">${fmt(t.amount_minor)}</td><td class="num">${fmt(t.fee_minor)}</td><td class="num">${fmt(t.net_minor)}</td>
            </tr>`)}</tbody></table></div>`
        : emptyState({ title: 'No tips yet', body: canReceive ? 'When a viewer sends you a tip, it shows up here. The Support button on your channel and videos is how they find it.' : 'Accept the creator terms and tips can start.' })}
    </section>
    <section aria-labelledby="ledger-h"><h2 id="ledger-h">Balance history</h2>
      ${ledger.items.length
        ? html`<div class="tablewrap"><table class="table">
            <caption class="sr-only">Every change to your balance, newest first</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col" class="num">Amount</th><th scope="col">Available</th></tr></thead>
            <tbody>${ledger.items.map((e) => html`<tr>
              <td>${formatDate(e.created_at)}</td>
              <td>${KIND[e.kind] ?? e.kind}${e.note ? html`<div class="muted">${e.note}</div>` : ''}</td>
              <td class="num">${Number(e.amount_minor) < 0 ? '−' : '+'}${fmt(Math.abs(Number(e.amount_minor)))}</td>
              <td>${Number(e.amount_minor) > 0 && new Date(e.available_at) > now ? `From ${formatDate(e.available_at)}` : ''}</td>
            </tr>`)}</tbody></table></div>
          ${pager({ page, hasMore: ledger.hasMore, path: '/studio/earnings' })}
          <p class="muted">Entries are permanent. A correction is added as a new line, so the history always adds up.</p>`
        : emptyState({ title: 'Nothing here yet', body: 'Your balance history starts with your first tip.' })}
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------------------------- creators: payouts

export function payoutsPage(req, { balances, profile, payouts, coolOffUntil, now, values = {}, errors = {}, m }) {
  const fmt = (n) => formatMoney(n, m.currency);
  const open = payouts.find((p) => p.status === 'requested' || p.status === 'approved');
  const cooling = profile && coolOffUntil && coolOffUntil > now;
  const hoursLeft = cooling ? Math.ceil((coolOffUntil.getTime() - now.getTime()) / 3_600_000) : 0;
  const method = values.method ?? profile?.method ?? 'upi';

  let requestPanel;
  if (!profile) requestPanel = html`<p class="muted">Add where to send the money first.</p>`;
  else if (open) requestPanel = html`<p class="muted">You have a request open (${fmt(open.amount_minor)}). You can make another once it is paid or cancelled.</p>`;
  else if (cooling) requestPanel = html`<p class="muted">You changed your payout details recently. For your safety, payouts wait ${hoursLeft} more ${hoursLeft === 1 ? 'hour' : 'hours'}.</p>`;
  else if (balances.available < m.payoutMin) requestPanel = html`<p class="muted">You can withdraw once your available balance reaches ${fmt(m.payoutMin)}. It is ${fmt(Math.max(0, balances.available))} now.</p>`;
  else {
    requestPanel = html`<form method="post" action="/studio/payouts/request" class="stack" novalidate>
      ${csrfField(req)}
      ${field({ name: 'payout_amount', label: 'Amount to withdraw', value: values.payout_amount ?? toDecimal(balances.available), error: errors.payout_amount, inputmode: 'decimal', autocomplete: 'off', required: true, hint: `Up to ${fmt(balances.available)}. The amount leaves your balance right away, and a person pays it to ${profile.display_hint}.` })}
      <p><button class="btn btn-primary" type="submit">Request payout</button></p>
    </form>`;
  }

  return html`<div class="page">
    <header class="pagehead"><h1>Payouts</h1></header>
    ${studioNav('payouts', req)}
    ${alert(errors._)}
    <section class="stats" aria-label="Your balance">
      <div class="stat"><p class="statnum">${fmt(balances.available)}</p><p class="muted">Available to withdraw</p></div>
      <div class="stat"><p class="statnum">${fmt(balances.pending)}</p><p class="muted">Pending, in the ${m.holdDays}-day holding period</p></div>
      <div class="stat"><p class="statnum">${fmt(m.payoutMin)}</p><p class="muted">Minimum payout</p></div>
    </section>

    <section class="panel" aria-labelledby="req-h"><h2 id="req-h">Request a payout</h2>${requestPanel}</section>

    <section class="panel" aria-labelledby="det-h"><h2 id="det-h">Where to send your money</h2>
      <p>${profile ? html`Now: <strong>${profile.method === 'upi' ? 'UPI' : 'Bank account'}</strong>, <code>${profile.display_hint}</code>. Saving new details replaces these.` : 'Nothing saved yet.'} Use an account in your own name. We store the details encrypted and show only the last few characters.</p>
      <form method="post" action="/studio/payouts/details" class="stack" novalidate>
        ${csrfField(req)}
        <fieldset class="choice"><legend>How should we pay you?</legend>
          <label class="check"><input type="radio" name="method" value="upi" ${method === 'upi' ? 'checked' : ''}> <span>UPI</span></label>
          <label class="check"><input type="radio" name="method" value="bank" ${method === 'bank' ? 'checked' : ''}> <span>Bank account</span></label>
          ${errors.method ? html`<p class="field-error">${errors.method}</p>` : ''}
        </fieldset>
        ${field({ name: 'upi', label: 'UPI address (if you chose UPI)', value: values.upi ?? '', error: errors.upi, autocomplete: 'off', placeholder: 'name@bank', maxlength: 100 })}
        ${field({ name: 'holder', label: 'Account holder’s name (if you chose bank account)', value: values.holder ?? '', error: errors.holder, autocomplete: 'off', maxlength: 80 })}
        ${field({ name: 'account', label: 'Account number', value: values.account ?? '', error: errors.account, autocomplete: 'off', inputmode: 'numeric', maxlength: 30 })}
        ${field({ name: 'ifsc', label: 'IFSC code', value: values.ifsc ?? '', error: errors.ifsc, autocomplete: 'off', maxlength: 20, placeholder: 'HDFC0001234' })}
        ${field({ name: 'password', label: 'Your password, to confirm it is you', type: 'password', autocomplete: 'current-password', error: errors.password, required: true, hint: 'We email you whenever payout details change. After a change, payouts wait 24 hours.' })}
        <p><button class="btn btn-primary" type="submit">Save payout details</button></p>
      </form>
    </section>

    <section aria-labelledby="hist-h"><h2 id="hist-h">Your payouts</h2>
      ${payouts.length
        ? html`<div class="tablewrap"><table class="table">
            <caption class="sr-only">Your payout requests, newest first</caption>
            <thead><tr><th scope="col">Requested</th><th scope="col" class="num">Amount</th><th scope="col">To</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${payouts.map((p) => {
              const [label, tone] = PAYOUT_STATUS[p.status] ?? [p.status, ''];
              return html`<tr>
                <td>${formatDate(p.requested_at)}</td><td class="num">${fmt(p.amount_minor)}</td><td><code>${p.display_hint}</code></td>
                <td><span class="pill ${tone}">${label}</span>${p.status === 'paid' && p.paid_reference ? html`<div class="muted">Reference ${p.paid_reference}</div>` : ''}${p.status === 'rejected' && p.note ? html`<div class="muted">${p.note}</div>` : ''}</td>
                <td>${p.status === 'requested' ? html`<form method="post" action="/studio/payouts/${p.id}/cancel" class="inline">${csrfField(req)}<button class="btn btn-quiet" type="submit">Cancel</button></form>` : ''}</td>
              </tr>`;
            })}</tbody></table></div>`
        : emptyState({ title: 'No payouts yet', body: `Once your available balance reaches ${fmt(m.payoutMin)}, you can ask for a payout here.` })}
      <p class="muted">A person reviews each request and pays it by hand. We cannot promise a date, but this page always shows where your request is. <a href="/help/payouts">How payouts work</a></p>
    </section>
  </div>`;
}
