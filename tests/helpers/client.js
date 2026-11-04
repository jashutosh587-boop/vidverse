/** A small cookie-keeping HTTP client for tests, so they exercise the real server the way a browser would. */
export function createClient(baseUrl) {
  const jar = new Map();
  let csrf = null;

  function store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (value === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, path, { form, json, body, headers = {}, follow = false } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(baseUrl + path, { method, headers: h, body: payload, redirect: 'manual', duplex: 'half' });
    store(res);
    // Read bytes and decode them ourselves: response.text() silently drops a leading byte-order mark.
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    // A quoted attribute that was escaped as text (`class=&quot;x&quot;` inside a tag) is silently ignored by browsers, so it
    // would pass every test that only looks at the text of a page. Catch it wherever it happens, in any test.
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      const broken = /<[a-zA-Z][^<>]*\s[a-zA-Z-]+=&quot;[^<>]*>/.exec(text);
      if (broken) throw new Error(`${method} ${path} returned a tag with an escaped attribute: ${broken[0].slice(0, 160)}`);
      // The templates print true and false as nothing, so `aria-pressed="${flag}"` became `aria-pressed=""`, which screen readers
      // ignore. An empty ARIA attribute is never right, so refuse it wherever it appears.
      const emptyAria = /<[a-zA-Z][^<>]*\saria-[a-z]+=""[^<>]*>/.exec(text);
      if (emptyAria) throw new Error(`${method} ${path} returned a tag with an empty ARIA attribute: ${emptyAria[0].slice(0, 160)}`);
      // Two elements with the same id make a label point at the wrong box (found on the security page by the browser test).
      const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const twice = ids.find((id, i) => ids.indexOf(id) !== i);
      if (twice) throw new Error(`${method} ${path} has two elements with id="${twice}"`);
    }
    const out = {
      status: res.status,
      headers: res.headers,
      text,
      buffer,
      location: res.headers.get('location'),
      json: () => JSON.parse(text),
      header: (n) => res.headers.get(n),
    };
    if (follow && out.status >= 300 && out.status < 400 && out.location) return request('GET', out.location, { follow: true, headers });
    return out;
  }

  const api = {
    jar,
    cookie: (name) => jar.get(name),
    setCookie: (name, value) => jar.set(name, value),
    clearCookies: () => jar.clear(),
    get: (path, opts) => request('GET', path, opts),
    request,
    /** The CSRF token the server embeds in every page. */
    async csrfToken() {
      if (csrf) return csrf;
      const res = await request('GET', '/legal/terms');
      const m = /<meta name="csrf-token" content="([^"]+)"/.exec(res.text);
      if (!m) throw new Error(`no csrf token found (status ${res.status})`);
      csrf = m[1];
      return csrf;
    },
    async post(path, fields = {}, opts = {}) {
      const token = opts.csrf === false ? undefined : (opts.csrf ?? (await api.csrfToken()));
      return request('POST', path, { ...opts, form: token === undefined ? fields : { _csrf: token, ...fields } });
    },
    async postJson(path, data = {}, opts = {}) {
      const token = opts.csrf === false ? undefined : (opts.csrf ?? (await api.csrfToken()));
      return request('POST', path, { ...opts, json: data, headers: { ...(token ? { 'x-csrf-token': token } : {}), ...(opts.headers ?? {}) } });
    },
  };
  return api;
}

export const metaOf = (html, name) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];
