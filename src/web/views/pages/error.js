import { html } from '../../../lib/html.js';

export function errorPage({ status, message, code, requestId }) {
  const heading = status === 404 ? 'We could not find that page' : status === 403 ? 'You cannot open that' : status === 401 ? 'Sign in first' : status === 429 ? 'Slow down a moment' : status >= 500 ? 'Something went wrong' : 'That did not work';
  return html`<section class="statuspage">
    <p class="timecode statuscode">${status}</p>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${code === 'csrf' ? html`<p class="muted">This usually means the page sat open for a long time. Going back and reloading it fixes it.</p>` : ''}
    ${requestId ? html`<p class="muted">If this keeps happening, tell support this reference: <code>${requestId}</code></p>` : ''}
    <p class="row"><a class="btn btn-primary" href="/">Go to the home page</a> <a class="btn btn-quiet" href="/help">Visit the help center</a></p>
  </section>`;
}
