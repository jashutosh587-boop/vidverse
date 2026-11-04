import { html } from '../../../lib/html.js';
import { timeAgo } from '../../../lib/format.js';
import { qrSvg } from '../../../lib/qr.js';
import { field, csrfField, tabs, avatar } from '../components.js';

const NAV = [
  { id: 'profile', href: '/settings/profile', label: 'Profile' },
  { id: 'security', href: '/settings/security', label: 'Password and security' },
  { id: 'preferences', href: '/settings/preferences', label: 'Viewing' },
  { id: 'privacy', href: '/settings/privacy', label: 'Your data' },
];
const nav = (active) => tabs(NAV, active);
const head = (title, active) => html`<header class="pagehead"><h1>${title}</h1></header>${nav(active)}`;
const alert = (error) => (error ? html`<div class="flash flash-error" role="alert">${error}</div>` : '');

/** Twelve swatches out of the 36 avatar colours: enough to choose from, few enough to scan. */
export const SWATCHES = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33];
export const LINK_SLOTS = 4;
/** The swatches, plus the member's current colour when it is not one of them, so saving never changes it by accident. */
const swatchHues = (current) => (SWATCHES.includes(current) || !Number.isInteger(current) ? SWATCHES : [current, ...SWATCHES]);

export function profilePage(req, { values, errors = {} }) {
  const user = req.user;
  return html`<div class="page narrow">
    ${head('Settings', 'profile')}
    ${errors._ ? alert(errors._) : ''}
    <form method="post" action="/settings/profile" class="stack" novalidate>
      ${csrfField(req)}
      <div class="rowflex">${avatar({ display_name: values.display_name, avatar_hue: Number(values.avatar_hue) }, 'lg')}<p class="muted">Your channel is <a href="/@${user.handle}">/@${user.handle}</a>. The handle cannot be changed.</p></div>
      ${field({ name: 'display_name', label: 'Name', value: values.display_name, error: errors.display_name, required: true, maxlength: 50, autocomplete: 'name' })}
      ${field({ name: 'bio', label: 'About you', type: 'textarea', rows: 5, value: values.bio, error: errors.bio, maxlength: 1000, hint: 'Shown on your channel. Up to 1,000 characters.' })}
      <fieldset class="swatches"><legend>Avatar colour</legend>
        <div class="swatchrow">${swatchHues(Number(values.avatar_hue)).map((h, i) => html`<label class="swatch hue-${h}"><input type="radio" name="avatar_hue" value="${h}" ${Number(values.avatar_hue) === h ? 'checked' : ''}><span class="sr-only">Colour ${i + 1}</span></label>`)}</div>
        ${errors.avatar_hue ? html`<p class="field-error">${errors.avatar_hue}</p>` : ''}
      </fieldset>
      <fieldset class="linkslots"><legend>Support links</legend>
        <p class="hint">Up to ${LINK_SLOTS} links on your channel page, such as a donation page or a shop. They must start with https://. Viewers who follow them leave this site, and we do not take a share of what happens there.</p>
        ${Array.from({ length: LINK_SLOTS }, (_, i) => html`<div class="linkrow">
          ${field({ name: `link_label_${i + 1}`, label: `Link ${i + 1} name`, value: values.links?.[i]?.label ?? '', error: errors[`link_label_${i + 1}`], maxlength: 40 })}
          ${field({ name: `link_url_${i + 1}`, label: `Link ${i + 1} address`, type: 'url', value: values.links?.[i]?.url ?? '', error: errors[`link_url_${i + 1}`], inputmode: 'url', placeholder: 'https://' })}
        </div>`)}
      </fieldset>
      <p><button class="btn btn-primary" type="submit">Save changes</button></p>
    </form>
  </div>`;
}

function deviceList(req, sessions, currentId, now) {
  return html`<ul class="devices">${sessions.map((s) => html`<li>
    <div><strong>${s.user_agent ? String(s.user_agent).slice(0, 90) : 'Unknown browser'}</strong>${s.id === currentId ? html` <span class="pill">This device</span>` : ''}
      <div class="muted">${s.ip_prefix ? html`Network ${s.ip_prefix}. ` : ''}Active ${timeAgo(s.last_seen_at, now)}. Signed in ${timeAgo(s.created_at, now)}.</div></div>
    ${s.id === currentId ? '' : html`<form method="post" action="/settings/security/sessions/revoke" class="inline">${csrfField(req)}<input type="hidden" name="id" value="${s.id}"><button class="btn btn-quiet" type="submit">Sign out</button></form>`}
  </li>`)}</ul>`;
}

export function securityPage(req, { sessions, twoStep, errors = {}, now }) {
  const currentId = req.session?.id;
  return html`<div class="page narrow">
    ${head('Settings', 'security')}
    ${errors._ ? alert(errors._) : ''}
    <section class="panel" aria-labelledby="pw-h"><h2 id="pw-h">Password</h2>
      <form method="post" action="/settings/security/password" class="stack" novalidate>
        ${csrfField(req)}
        ${field({ name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password', error: errors.current, required: true })}
        ${field({ name: 'password', label: 'New password', type: 'password', autocomplete: 'new-password', error: errors.password, hint: 'At least 10 characters. A few random words is a good password. Changing it signs out your other devices.', required: true })}
        ${field({ name: 'confirm', label: 'New password again', type: 'password', autocomplete: 'new-password', error: errors.confirm, required: true })}
        <p><button class="btn btn-primary" type="submit">Change password</button></p>
      </form>
    </section>
    <section class="panel" aria-labelledby="2fa-h"><h2 id="2fa-h">Two-step verification</h2>
      ${twoStep.enabled
        ? html`<p><span class="pill pill-ok">On</span> You will be asked for a code from your authenticator app each time you sign in. You have ${twoStep.codesLeft} unused recovery ${twoStep.codesLeft === 1 ? 'code' : 'codes'}.</p>
          <form method="post" action="/settings/security/2fa/recovery" class="stack">${csrfField(req)}
            ${field({ name: 'password', id: 'f-recovery-password', label: 'Password, to make new recovery codes', type: 'password', autocomplete: 'current-password', error: errors.recoveryPassword })}
            <p><button class="btn" type="submit">Make new recovery codes</button> <span class="muted">The old ones stop working.</span></p></form>
          <form method="post" action="/settings/security/2fa/disable" class="stack">${csrfField(req)}
            ${field({ name: 'password', id: 'f-disable-password', label: 'Password, to turn it off', type: 'password', autocomplete: 'current-password', error: errors.disablePassword })}
            <p><button class="btn btn-danger" type="submit">Turn off two-step verification</button></p></form>`
        : html`<p>Add a second step to signing in. Even if someone learns your password, they cannot sign in without a code from your phone.</p>
          <form method="post" action="/settings/security/2fa/start">${csrfField(req)}<p><button class="btn btn-primary" type="submit">Set up two-step verification</button></p></form>`}
    </section>
    <section class="panel" aria-labelledby="dev-h"><h2 id="dev-h">Where you are signed in</h2>
      ${deviceList(req, sessions, currentId, now)}
      ${sessions.length > 1 ? html`<form method="post" action="/settings/security/sessions/revoke-others">${csrfField(req)}<p><button class="btn" type="submit">Sign out of all other devices</button></p></form>` : ''}
    </section>
  </div>`;
}

const groupSecret = (s) => s.replace(/(.{4})/g, '$1 ').trim();

export function totpSetupPage(req, { setup, error = '' }) {
  return html`<div class="page narrow">
    ${head('Set up two-step verification', 'security')}
    <ol class="steps2">
      <li>Open an authenticator app on your phone, such as Google Authenticator, Aegis or 2FAS, and add an account by scanning this code.
        <div class="qrbox">${qrSvg(setup.uri, { label: 'QR code for your authenticator app' })}</div>
        <p class="muted">Cannot scan? Type this key into the app instead: <code class="secret">${groupSecret(setup.secret)}</code></p></li>
      <li>Type the 6-digit code the app shows, to check that it works.</li>
    </ol>
    ${alert(error)}
    <form method="post" action="/settings/security/2fa/confirm" class="stack">
      ${csrfField(req)}
      ${field({ name: 'code', label: 'Code from the app', autocomplete: 'one-time-code', inputmode: 'numeric', required: true, maxlength: 10 })}
      <p><button class="btn btn-primary" type="submit">Turn on</button> <a class="btn btn-quiet" href="/settings/security">Cancel</a></p>
    </form>
  </div>`;
}

export function recoveryCodesPage(req, { codes, headline }) {
  return html`<div class="page narrow">
    ${head(headline, 'security')}
    <div class="flash flash-info" role="note">Save these recovery codes somewhere safe, such as a password manager. Each works once, if you lose your phone. <strong>We cannot show them again.</strong></div>
    <ul class="codes" aria-label="Recovery codes">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul>
    <p><a class="btn btn-primary" href="/settings/security">I have saved them</a></p>
  </div>`;
}

export function preferencesPage(req, { values, errors = {} }) {
  return html`<div class="page narrow">
    ${head('Settings', 'preferences')}
    <form method="post" action="/settings/preferences" class="stack" novalidate>
      ${csrfField(req)}
      ${field({ name: 'autoplay', type: 'checkbox', label: 'Play the next video automatically', value: values.autoplay, hint: 'After three videos in a row we ask whether you are still watching.' })}
      ${field({ name: 'daily_limit', label: 'Daily reminder, in minutes', type: 'number', value: values.daily_limit, error: errors.daily_limit, min: 10, max: 1440, step: 5, inputmode: 'numeric', hint: 'Optional. Leave empty for no reminder. When you pass this much watching in a day, we show a note. We never lock you out or send emails to bring you back.' })}
      <p><button class="btn btn-primary" type="submit">Save changes</button></p>
    </form>
    <p class="muted">See how long you have watched on the <a href="/history">history page</a>.</p>
  </div>`;
}

export function privacyPage(req, { blockers, errors = {} }) {
  return html`<div class="page narrow">
    ${head('Settings', 'privacy')}
    ${errors._ ? alert(errors._) : ''}
    <section class="panel" aria-labelledby="exp-h"><h2 id="exp-h">Download your data</h2>
      <p>Get a file with your account details, videos, comments, likes, subscriptions, history, notifications, messages to us and money records. It leaves out your password and two-step secrets.</p>
      <form method="post" action="/settings/privacy/export">${csrfField(req)}<p><button class="btn" type="submit">Download my data</button></p></form>
    </section>
    <section class="panel danger" aria-labelledby="del-h"><h2 id="del-h">Delete your account</h2>
      <p>This removes your profile, your videos and their files, your comments, likes, subscriptions, history and sessions. It cannot be undone. We keep only the records the law requires, such as payments and payouts, without your name or email. <a href="/help/deleting-your-account">What exactly is removed</a></p>
      ${blockers.length
        ? html`<div class="flash flash-error" role="alert"><p>You cannot delete your account yet:</p><ul>${blockers.map((b) => html`<li>${b}</li>`)}</ul></div>`
        : html`<form method="post" action="/settings/privacy/delete" class="stack" novalidate>
            ${csrfField(req)}
            ${field({ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', error: errors.password, required: true })}
            ${field({ name: 'confirm', label: 'Type DELETE to confirm', error: errors.confirm, required: true, autocomplete: 'off', maxlength: 10 })}
            <p><button class="btn btn-danger" type="submit">Delete my account for good</button></p>
          </form>`}
    </section>
  </div>`;
}
