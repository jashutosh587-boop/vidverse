import { html } from '../../../lib/html.js';
import { field, csrfField } from '../components.js';

const card = (title, intro, body) => html`<section class="authcard"><h1>${title}</h1>${intro ? html`<p class="lede">${intro}</p>` : ''}${body}</section>`;

export function loginPage(req, { values = {}, error = '', next = '/', needsVerify = false }) {
  return card('Sign in', null, html`
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    ${needsVerify
      ? html`<form method="post" action="/resend-verification-public" class="stack">${csrfField(req)}<input type="hidden" name="email" value="${values.email ?? ''}"><button class="btn btn-quiet" type="submit">Send the confirmation email again</button></form>`
      : ''}
    <form method="post" action="/login" class="stack" novalidate>
      ${csrfField(req)}
      <input type="hidden" name="next" value="${next}">
      ${field({ name: 'email', label: 'Email address', type: 'email', value: values.email ?? '', autocomplete: 'username', required: true })}
      ${field({ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', required: true })}
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <p class="authlinks"><a href="/forgot-password">Forgot your password?</a> <a href="/signup">Create an account</a></p>`);
}

export function mfaPage(req, { error = '' }) {
  return card('Enter your code', 'Open your authenticator app and type the 6-digit code. Lost your phone? Type one of your recovery codes instead.', html`
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/login/mfa" class="stack">
      ${csrfField(req)}
      ${field({ name: 'code', label: 'Code', autocomplete: 'one-time-code', inputmode: 'numeric', required: true, maxlength: 20 })}
      <button class="btn btn-primary btn-block" type="submit">Continue</button>
    </form>
    <p class="authlinks"><a href="/login">Start again</a></p>`);
}

export function signupPage(req, { values = {}, errors = {} }) {
  return card('Create your account', 'Free to watch. Add a video whenever you are ready.', html`
    <form method="post" action="/signup" class="stack" novalidate>
      ${csrfField(req)}
      ${field({ name: 'displayName', label: 'Your name', value: values.displayName ?? '', error: errors.displayName, autocomplete: 'name', required: true, maxlength: 50 })}
      ${field({ name: 'handle', label: 'Handle', value: values.handle ?? '', error: errors.handle, hint: 'Your channel address will be /@handle. Letters, numbers, dots, dashes and underscores.', autocomplete: 'off', required: true, maxlength: 30 })}
      ${field({ name: 'email', label: 'Email address', type: 'email', value: values.email ?? '', error: errors.email, autocomplete: 'email', required: true })}
      ${field({ name: 'password', label: 'Password', type: 'password', error: errors.password, hint: 'At least 10 characters. A few random words is a good password.', autocomplete: 'new-password', required: true })}
      ${field({ name: 'adult', type: 'checkbox', label: 'I am 18 years old or older.', value: values.adult, error: errors.adult, required: true })}
      ${field({ name: 'terms', type: 'checkbox', label: html`I agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a> and have read the <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.`, value: values.terms, error: errors.terms, required: true })}
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
    <p class="authlinks">Already have an account? <a href="/login">Sign in</a></p>`);
}

export function checkInboxPage() {
  return card('Check your inbox', 'If the details were valid, we have sent an email to the address you gave. Open the link in it to finish. The link works once and expires in 24 hours.', html`
    <p class="muted">Nothing there after a few minutes? Check your spam folder, then <a href="/login">sign in</a> to ask for a new link.</p>`);
}

export function verifyEmailPage(req, { token, valid }) {
  if (!valid) return card('That link has expired', 'Confirmation links work once and last 24 hours.', html`<p><a class="btn btn-primary" href="/login">Sign in to get a new one</a></p>`);
  return card('Confirm your email address', 'One more click and your account is ready.', html`
    <form method="post" action="/verify-email" class="stack">${csrfField(req)}<input type="hidden" name="token" value="${token}"><button class="btn btn-primary btn-block" type="submit">Confirm email address</button></form>`);
}

export function forgotPage(req, { values = {}, errors = {} }) {
  return card('Reset your password', 'Enter your email address. If it belongs to an account we will send a link to choose a new password.', html`
    <form method="post" action="/forgot-password" class="stack" novalidate>
      ${csrfField(req)}
      ${field({ name: 'email', label: 'Email address', type: 'email', value: values.email ?? '', error: errors.email, autocomplete: 'email', required: true })}
      <button class="btn btn-primary btn-block" type="submit">Send the link</button>
    </form>
    <p class="authlinks"><a href="/login">Back to sign in</a></p>`);
}

export function forgotSentPage() {
  return card('Check your inbox', 'If that address belongs to an account, a link to choose a new password is on its way. It works once and expires in one hour.', html`<p class="muted"><a href="/login">Back to sign in</a></p>`);
}

export function resetPage(req, { token, valid, errors = {} }) {
  if (!valid) return card('That link has expired', 'Password reset links work once and last one hour.', html`<p><a class="btn btn-primary" href="/forgot-password">Ask for a new link</a></p>`);
  return card('Choose a new password', 'Every device will be signed out when you save it.', html`
    <form method="post" action="/reset-password" class="stack" novalidate>
      ${csrfField(req)}
      <input type="hidden" name="token" value="${token}">
      ${field({ name: 'password', label: 'New password', type: 'password', error: errors.password, hint: 'At least 10 characters.', autocomplete: 'new-password', required: true })}
      <button class="btn btn-primary btn-block" type="submit">Save password</button>
    </form>`);
}
