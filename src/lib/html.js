/**
 * Auto-escaping HTML templates.
 *
 *   html`<p class="note">${userText}</p>`
 *
 * Every interpolated value is escaped unless it is itself the result of html``
 * or raw(). Rules that keep this safe (and that tests/html.test.js enforces):
 *   - always quote attribute values: href="${x}", never href=${x};
 *   - never interpolate user data inside <script> or <style>; use jsonForScript();
 *   - user-supplied URLs go through safeExternalUrl() before they reach href;
 *   - raw() is for markup the server itself produced, and is allow-listed by file.
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

export class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Marks a string as already-safe markup. Use only for output the server generated. */
export function raw(value) {
  return new Raw(String(value));
}

function render(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) {
    let s = '';
    for (const x of v) s += render(x);
    return s;
  }
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/**
 * The aria-current attribute when `on` is true, otherwise nothing. A plain string such as 'aria-current="page"'
 * would be escaped by html``, which breaks the attribute, so this returns markup the server wrote itself.
 */
export function ariaCurrent(on, value = 'page') {
  if (value !== 'page' && value !== 'true') throw new Error('aria-current is "page" or "true" here');
  return on ? raw(`aria-current="${value}"`) : '';
}

/** JSON that is safe inside <script type="application/json">. */
export function jsonForScript(value) {
  return raw(
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replaceAll(String.fromCharCode(0x2028), '\\u2028')
      .replaceAll(String.fromCharCode(0x2029), '\\u2029'),
  );
}

/**
 * A URL a member typed (a support link, say). Only http and https, no embedded
 * credentials, no control characters. Returns the normalised URL or null.
 */
export function safeExternalUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname.includes('.')) return null;
  return u.toString();
}

/** A path on this site ("/watch/abc"), for redirects. Anything else becomes the fallback. */
export function safeLocalPath(input, fallback = '/') {
  if (typeof input !== 'string') return fallback;
  if (!input.startsWith('/') || input.startsWith('//') || input.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(input)) return fallback;
  if (input.length > 2000) return fallback;
  return input;
}
