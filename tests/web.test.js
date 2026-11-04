import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp } from './helpers/app.js';
import { createMember, makeAdmin, lastMail } from './helpers/users.js';

const ADS = { ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT_WATCH_TOP: '1111111111', ADSENSE_SLOT_WATCH_SIDE: '2222222222' };
const nonceOf = (headers) => /'nonce-([^']+)'/.exec(headers.get('content-security-policy'))?.[1];

/** A raw request, so a test can send a Host header or a body that fetch would refuse to send. */
function raw(baseUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('security headers and what the server refuses to hand out', () => {
  let app;
  let c;
  before(async () => {
    app = await startTestApp();
    c = app.client();
  });
  after(() => app.close());

  test('every page carries a strict policy with a fresh nonce, and every script tag on it uses that nonce', async () => {
    const seen = new Set();
    for (const p of ['/', '/trending', '/help', '/legal/terms', '/login', '/signup', '/contact', '/results?q=test']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      const csp = r.header('content-security-policy');
      assert.match(csp, /default-src 'none'/, p);
      assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]{22,}' 'strict-dynamic'(?!.*unsafe)/, p);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|http:/, p);
      const nonce = nonceOf(r.headers);
      assert.ok(!seen.has(nonce), 'a nonce is never reused');
      seen.add(nonce);
      const tags = [...r.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      assert.ok(tags.length > 0, p);
      for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), `${p}: ${tag}`);
      assert.ok(!/\sstyle="/.test(r.text), `${p}: an inline style attribute would be blocked by the policy`);
      assert.ok(!/<style\b/.test(r.text), `${p}: an inline style element would be blocked`);
    }
  });

  test('the fixed headers are set on pages, errors, files and redirects alike', async () => {
    const targets = ['/', '/nope-not-here', '/assets/css/app.css', '/robots.txt', '/api/health', '/studio'];
    for (const p of targets) {
      const r = await c.get(p);
      assert.equal(r.header('x-content-type-options'), 'nosniff', p);
      assert.equal(r.header('x-frame-options'), 'DENY', p);
      assert.equal(r.header('referrer-policy'), 'strict-origin-when-cross-origin', p);
      assert.equal(r.header('cross-origin-opener-policy'), 'same-origin', p);
      assert.equal(r.header('cross-origin-resource-policy'), 'same-origin', p);
      assert.match(r.header('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/, p);
      assert.equal(r.header('x-powered-by'), null, p);
      assert.equal(r.header('server'), null, p);
      assert.equal(r.header('strict-transport-security'), null, `${p}: only sent for an https site`);
    }
  });

  test('an https site is told to stay on https, and its policy upgrades stray http links', async () => {
    const secure = await startTestApp({ env: { BASE_URL: 'https://video.example' } });
    try {
      const r = await secure.client().get('/');
      assert.match(r.header('strict-transport-security'), /max-age=63072000; includeSubDomains/);
      assert.match(r.header('content-security-policy'), /upgrade-insecure-requests/);
    } finally {
      await secure.close();
    }
  });

  test('pages for signed-in people are never stored, and everyone’s pages vary by cookie', async () => {
    for (const p of ['/', '/help', '/login']) {
      const r = await c.get(p);
      assert.match(r.header('cache-control'), /no-store/, p);
      assert.match(r.header('vary'), /Cookie/i, p);
    }
  });

  test('files shipped with the site are cached for a year, and the cache cannot serve a stale script after an update', async () => {
    const home = (await c.get('/')).text;
    const css = /href="(\/assets\/[^"]*app\.css[^"]*)"/.exec(home)?.[1];
    assert.ok(css, 'the stylesheet link');
    assert.match(css, /\?v=[\w.-]+|\/[0-9a-f]{6,}\//, 'the address changes when the file changes');
    const r = await c.get(css);
    assert.equal(r.status, 200);
    assert.match(r.header('cache-control'), /max-age=31536000/);
    assert.match(r.header('cache-control'), /immutable/);
    assert.match(r.header('content-type'), /text\/css/);
  });

  test('source code, settings, content files, the database folder and hidden files are not reachable', async () => {
    const paths = [
      '/.env', '/.git/config', '/package.json', '/package-lock.json', '/src/config.js', '/src/server.js', '/content/help/tips.md', '/content/legal/terms.md',
      '/tests/helpers/app.js', '/scripts/make-admin.js', '/Dockerfile', '/docs/ARCHITECTURE.md', '/node_modules/express/package.json', '/data', '/storage',
      '/assets/../package.json', '/assets/%2e%2e/package.json', '/assets/..%2fpackage.json', '/assets/%2e%2e%2f%2e%2e%2fsrc%2fconfig.js', '/assets/css/../../package.json',
      '/assets/fonts/sans/../../../package.json', '/assets/.env', '/assets//etc/passwd', '/media/v/..%2f..%2fpackage.json', '/media/f/AAAAAAAAAAA/..%2f..%2f..%2fpackage.json',
    ];
    for (const p of paths) {
      const r = await c.get(p);
      assert.ok([400, 403, 404].includes(r.status), `${p} answered ${r.status}`);
      assert.ok(!/"name":\s*"vidverse"|SESSION_SECRET|export (?:function|const)/.test(r.text), `${p} leaked file contents`);
    }
  });

  test('error pages say what happened without giving away how the server is built', async () => {
    const page = await c.get('/definitely/not/here');
    assert.equal(page.status, 404);
    assert.ok(!/at .*\.js:\d+|node_modules|stack|ECONN|pg_|PGlite|express/i.test(page.text), 'no stack, path or library names');
    const json = await c.get('/api/nope');
    assert.equal(json.status, 404);
    assert.deepEqual(Object.keys(json.json().error).sort(), ['code', 'message']);
    const bad = await c.get('/watch/%');
    assert.ok([400, 404].includes(bad.status), `a malformed address gave ${bad.status}`);
    assert.ok(!/URIError|decode/i.test(bad.text));
    const badJson = await c.request('POST', '/api/assistant', { body: '{"q":', headers: { 'content-type': 'application/json', 'x-csrf-token': await c.csrfToken() } });
    assert.equal(badJson.status, 400);
    assert.ok(!/SyntaxError|Unexpected token|\bat\s+\S+\.js:\d+/.test(badJson.text));
  });

  test('oversized bodies and too many form fields are refused instead of being read', async () => {
    const big = await c.request('POST', '/login', { body: `_csrf=x&email=${'a'.repeat(70_000)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(big.status, 413);
    const bigJson = await c.request('POST', '/api/assistant', { body: JSON.stringify({ q: 'a'.repeat(70_000) }), headers: { 'content-type': 'application/json', 'x-csrf-token': await c.csrfToken() } });
    assert.equal(bigJson.status, 413);
    const fields = Array.from({ length: 150 }, (_, i) => `f${i}=1`).join('&');
    const many = await c.request('POST', '/login', { body: fields, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.ok([400, 403, 413].includes(many.status), `${many.status}`);
    assert.equal(many.status === 413 || many.status === 400 || many.status === 403, true);
  });

  test('the address in links and emails comes from our settings, never from the Host header a visitor sent', async () => {
    const sender = app.client();
    await sender.post('/signup', { displayName: 'Host Test', handle: 'hosttest', email: 'host@example.com', password: 'correct horse battery staple', adult: '1', terms: '1' });
    const mail = lastMail(app, 'host@example.com', /verify-email/);
    assert.ok(mail.text.includes(`${app.baseUrl}/verify-email?token=`), mail.text.slice(0, 200));
    const r = await raw(app.baseUrl, { path: '/', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('evil.example'), 'no link or tag repeats the forged host');
    assert.match(r.text, new RegExp(`<link rel="canonical" href="${app.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?"`));
  });

  test('a browser’s policy-violation report is accepted without a token or cookie, but only small ones, and only to be logged', async () => {
    const body = JSON.stringify({ 'csp-report': { 'document-uri': 'http://x.example/watch/abc?token=secret', 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } });
    const ok = await c.request('POST', '/api/csp-report', { body, headers: { 'content-type': 'application/csp-report' } });
    assert.equal(ok.status, 204);
    assert.equal((await c.request('POST', '/api/csp-report', { body: 'x'.repeat(9000), headers: { 'content-type': 'application/json' } })).status, 413);
    assert.equal((await c.request('POST', '/api/csp-report', { body: 'garbage', headers: { 'content-type': 'text/plain' } })).status, 204);
    assert.equal((await c.get('/api/csp-report')).status, 404);
  });

  test('the cookies that matter are marked secure, unreadable by scripts and not sent across sites', async () => {
    const fresh = app.client();
    const r = await fresh.get('/login');
    const set = r.headers.getSetCookie();
    const csrf = set.find((x) => x.startsWith('__Host-vv_csrf='));
    assert.ok(csrf, set.join(' | '));
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(csrf.includes(attr), `${attr} in ${csrf}`);
    assert.ok(!/Domain=/i.test(csrf), 'a __Host- cookie has no Domain');
  });

  test('the health check says only that the site is up', async () => {
    const r = await c.get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json()).sort(), ['status', 'version']);
    assert.match(r.header('cache-control'), /no-store/);
  });
});

describe('robots, sitemap and ads.txt', () => {
  let app;
  let c;
  let owner;
  const q = (sql, params) => app.ctx.db.query(sql, params);
  const video = (id, ownerId, over = {}) => {
    const v = { status: 'ready', visibility: 'public', title: `Video ${id}`, ...over };
    return q(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at, duration_ms) VALUES ($1, $2, $3, $4, $5, now(), 60000)`, [id, ownerId, v.title, v.status, v.visibility]);
  };

  before(async () => {
    app = await startTestApp();
    c = app.client();
    owner = await createMember(app, app.client(), { email: 'maker@example.com', handle: 'maker' });
    const quiet = await createMember(app, app.client(), { email: 'quiet@example.com', handle: 'quiet' });
    const gone = await createMember(app, app.client(), { email: 'gone@example.com', handle: 'goneaway' });
    await video('PUBLICVID01', owner.id, { title: 'Fish & <chips>' });
    await video('UNLISTED001', owner.id, { visibility: 'unlisted' });
    await video('PRIVATEVID1', owner.id, { visibility: 'private' });
    await video('REMOVEDVID1', owner.id, { status: 'removed' });
    await video('PROCESSING1', owner.id, { status: 'processing' });
    await video('QUIETPRIV01', quiet.id, { visibility: 'private' });
    await video('GONEVIDEO01', gone.id);
    await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [gone.id]);
  });
  after(() => app.close());

  test('robots.txt keeps private areas out of search engines and points to the sitemap', async () => {
    const r = await c.get('/robots.txt');
    assert.match(r.header('content-type'), /^text\/plain/);
    for (const p of ['/studio', '/admin', '/settings', '/api/', '/login', '/signup', '/notifications', '/media/v/']) assert.ok(r.text.includes(`Disallow: ${p}`), p);
    assert.ok(r.text.includes(`Sitemap: ${app.baseUrl}/sitemap.xml`));
    assert.ok(!r.text.includes('Disallow: /\n'), 'the public site is not hidden');
  });

  test('the sitemap lists public videos and channels with public videos, and nothing else', async () => {
    const r = await c.get('/sitemap.xml');
    assert.match(r.header('content-type'), /^application\/xml/);
    assert.match(r.header('cache-control'), /public, max-age=900/);
    assert.match(r.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.ok(r.text.includes(`<loc>${app.baseUrl}/watch/PUBLICVID01</loc>`));
    assert.ok(r.text.includes(`<loc>${app.baseUrl}/@maker</loc>`));
    for (const hidden of ['UNLISTED001', 'PRIVATEVID1', 'REMOVEDVID1', 'PROCESSING1', 'QUIETPRIV01', 'GONEVIDEO01', '/@quiet', '/@goneaway']) assert.ok(!r.text.includes(hidden), `${hidden} must not be listed`);
    for (const p of ['/', '/trending', '/help', '/legal/terms', '/legal/privacy', '/legal/community-guidelines', '/legal/copyright']) assert.ok(r.text.includes(`<loc>${app.baseUrl}${p}</loc>`), p);
    assert.ok(!r.text.includes('Fish & <chips>'), 'titles are not part of the sitemap');
    assert.match(r.text, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  test('a handle or address with markup characters could not break out of the XML', async () => {
    const xml = (await c.get('/sitemap.xml')).text;
    assert.ok(!/<loc>[^<]*[&"'>][^<]*<\/loc>/.test(xml.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, '')), 'every special character in a location is escaped');
  });

  test('ads.txt is absent until AdSense is set up, then states exactly what Google gave us', async () => {
    assert.equal((await c.get('/ads.txt')).status, 404);
    const withClient = await startTestApp({ env: { ADSENSE_CLIENT: 'ca-pub-1234567890123456' } });
    const withLine = await startTestApp({ env: { ADS_TXT: 'google.com, pub-9999999999999999, DIRECT, f08c47fec0942fa0' } });
    try {
      const a = await withClient.client().get('/ads.txt');
      assert.match(a.header('content-type'), /^text\/plain/);
      assert.equal(a.text, 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
      assert.equal((await withLine.client().get('/ads.txt')).text, 'google.com, pub-9999999999999999, DIRECT, f08c47fec0942fa0\n');
    } finally {
      await withClient.close();
      await withLine.close();
    }
  });
});

describe('advertising slots', () => {
  let app;
  let owner;
  let oc;
  const q = (sql, params) => app.ctx.db.query(sql, params);
  const addVideo = (id, over = {}) => {
    const v = { status: 'ready', visibility: 'public', ad_status: 'eligible', ...over };
    return q(`INSERT INTO videos (id, owner_id, title, status, visibility, ad_status, published_at, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, now(), 60000)`, [id, v.owner ?? owner.id, `Video ${id}`, v.status, v.visibility, v.ad_status]);
  };
  const hasAd = (r) => /class="adsbygoogle"/.test(r.text);

  before(async () => {
    app = await startTestApp({ env: ADS });
    oc = app.client();
    owner = await createMember(app, oc, { email: 'maker@example.com', handle: 'maker' });
    await addVideo('ADSVIDEO001');
  });
  after(() => app.close());

  test('a public, finished, eligible video shows the slots to a visitor, loads Google’s script with the nonce, and relaxes the policy only there', async () => {
    const r = await app.client().get('/watch/ADSVIDEO001');
    assert.equal(r.status, 200);
    assert.ok(hasAd(r));
    assert.equal((r.text.match(/class="adsbygoogle"/g) ?? []).length, 2, 'top and side');
    assert.match(r.text, /data-ad-client="ca-pub-1234567890123456" data-ad-slot="1111111111"/);
    assert.match(r.text, /data-ad-slot="2222222222"/);
    const nonce = nonceOf(r.headers);
    assert.ok(r.text.includes(`<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456" crossorigin="anonymous" nonce="${nonce}"></script>`));
    assert.match(r.text, /src="\/assets\/js\/ads\.js[^"]*" nonce="[^"]+" defer/);
    assert.match(r.text, /<p class="adlabel">Advertisement<\/p>/, 'ads are labelled');
    const csp = r.header('content-security-policy');
    assert.match(csp, /frame-src https:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /base-uri 'none'/);
  });

  test('every other page stays on the strict policy with no ad markup, even with ads switched on', async () => {
    const c = app.client();
    for (const p of ['/', '/trending', '/results?q=video', '/@maker', '/help', '/help/ads-and-adsense', '/legal/terms', '/login', '/signup', '/contact']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.ok(!hasAd(r), `${p} shows an ad slot`);
      assert.ok(!r.text.includes('googlesyndication'), `${p} loads Google’s script`);
      assert.doesNotMatch(r.header('content-security-policy'), /frame-src|unsafe-eval|https:/, p);
    }
    for (const p of ['/studio', '/settings/profile', '/history', '/notifications']) {
      const r = await oc.get(p);
      assert.ok(r.status === 200, p);
      assert.ok(!hasAd(r) && !r.text.includes('googlesyndication'), p);
      assert.doesNotMatch(r.header('content-security-policy'), /frame-src|unsafe-eval|https:/, p);
    }
  });

  test('nobody is shown their own ads, and neither is staff, so nobody earns by clicking them', async () => {
    assert.ok(!hasAd(await oc.get('/watch/ADSVIDEO001')), 'the owner');
    const mod = app.client();
    const m = await createMember(app, mod, { email: 'mod@example.com', handle: 'modperson' });
    await q(`UPDATE users SET role = 'moderator' WHERE id = $1`, [m.id]);
    assert.ok(!hasAd(await mod.get('/watch/ADSVIDEO001')), 'a moderator');
    const adm = app.client();
    const a = await createMember(app, adm, { email: 'admin@example.com', handle: 'bossperson' });
    await makeAdmin(app, a.id);
    assert.ok(!hasAd(await adm.get('/watch/ADSVIDEO001')), 'an admin');
    const viewer = app.client();
    await createMember(app, viewer, { email: 'viewer@example.com', handle: 'viewer' });
    assert.ok(hasAd(await viewer.get('/watch/ADSVIDEO001')), 'an ordinary member does see them');
  });

  test('unlisted, limited, switched-off, unfinished and suspended-owner videos show no ads, and the strict policy', async () => {
    await addVideo('ADSUNLISTED', { visibility: 'unlisted' });
    await addVideo('ADSLIMITED1', { ad_status: 'limited' });
    await addVideo('ADSNONE0001', { ad_status: 'none' });
    const other = await createMember(app, app.client(), { email: 'sus@example.com', handle: 'suspendedone', signIn: false });
    await addVideo('ADSSUSPEND1', { owner: other.id });
    await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [other.id]);
    const c = app.client();
    for (const id of ['ADSUNLISTED', 'ADSLIMITED1', 'ADSNONE0001']) {
      const r = await c.get(`/watch/${id}`);
      assert.equal(r.status, 200, id);
      assert.ok(!hasAd(r), id);
      assert.doesNotMatch(r.header('content-security-policy'), /frame-src|unsafe-eval/, id);
    }
    assert.equal((await c.get('/watch/ADSSUSPEND1')).status, 404, 'a suspended person’s videos are not shown at all');
  });

  test('reporting a video takes its ads away until a moderator has looked, and a dismissal gives them back', async () => {
    await addVideo('ADSREPORTED');
    const reporter = app.client();
    await createMember(app, reporter, { email: 'reporter@example.com', handle: 'reporter' });
    assert.ok(hasAd(await app.client().get('/watch/ADSREPORTED')));
    const rep = await reporter.post('/report', { type: 'video', id: 'ADSREPORTED', reason: 'spam', details: '' });
    assert.ok([200, 303].includes(rep.status), `${rep.status}`);
    assert.equal((await q(`SELECT ad_status FROM videos WHERE id = 'ADSREPORTED'`)).rows[0].ad_status, 'limited');
    assert.ok(!hasAd(await app.client().get('/watch/ADSREPORTED')));
    const staff = app.client();
    const s = await createMember(app, staff, { email: 'staff@example.com', handle: 'staffer' });
    await q(`UPDATE users SET role = 'moderator' WHERE id = $1`, [s.id]);
    const open = (await q(`SELECT id FROM reports WHERE target_id = 'ADSREPORTED' AND status = 'open'`)).rows[0];
    assert.ok(open, 'the report is waiting for a moderator');
    const done = await staff.post(`/admin/reports/${open.id}`, { decision: 'dismiss', note: 'fine' });
    assert.ok([200, 303].includes(done.status), `${done.status}`);
    assert.ok(hasAd(await app.client().get('/watch/ADSREPORTED')), 'dismissed, so the ads return');
  });

  test('ads are asked for as non-personalised unless the site chose otherwise, and the page script only ever runs with the nonce', async () => {
    const r = await app.client().get('/watch/ADSVIDEO001');
    assert.match(r.text, /class="adslot" data-npa="1"/);
    assert.ok(!r.text.includes('&quot;'), 'no attribute was written as text');
    // Asking for personalised ads is not enough: the owner must also confirm a consent message is switched on,
    // because this site has no consent banner of its own and must never promise one that does not exist.
    for (const [env, personalised] of [
      [{ ADS_NON_PERSONALIZED: 'false' }, false],
      [{ ADS_NON_PERSONALIZED: 'false', ADS_CONSENT_CONFIRMED: 'true' }, true],
      [{ ADS_CONSENT_CONFIRMED: 'true' }, false],
    ]) {
      const site = await startTestApp({ env: { ...ADS, ...env } });
      try {
        const o = await createMember(site, site.client(), { email: 'm@example.com', handle: 'maker2', signIn: false });
        await site.ctx.db.query(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at, duration_ms) VALUES ('PERSONALIZE', $1, 'v', 'ready', 'public', now(), 60000)`, [o.id]);
        const p = await site.client().get('/watch/PERSONALIZE');
        assert.ok(hasAd(p), JSON.stringify(env));
        assert.match(p.text, new RegExp(`class="adslot" data-npa="${personalised ? 0 : 1}"`), JSON.stringify(env));
        // What visitors are told matches what the site does: "consent message" appears only when ads can be personalised.
        const legal = await site.client().get('/legal/cookies-and-ads');
        const help = await site.client().get('/help/ads-and-adsense');
        for (const page of [legal, help]) {
          assert.equal(page.status, 200);
          assert.equal(/consent message/.test(page.text), personalised, `${JSON.stringify(env)}: ${page.url ?? ''}`);
          assert.equal(/non-personalised/.test(page.text), !personalised);
        }
      } finally {
        await site.close();
      }
    }
  });

  test('with AdSense not configured, or only half configured, no page mentions it at all', async () => {
    for (const env of [{}, { ADSENSE_CLIENT: 'ca-pub-1234567890123456' }, { ADSENSE_SLOT_WATCH_TOP: '1111111111' }]) {
      const plain = await startTestApp({ env });
      try {
        const o = await createMember(plain, plain.client(), { email: 'm@example.com', handle: 'maker3', signIn: false });
        await plain.ctx.db.query(`INSERT INTO videos (id, owner_id, title, status, visibility, published_at, duration_ms) VALUES ('NOADSVIDEO1', $1, 'v', 'ready', 'public', now(), 60000)`, [o.id]);
        const r = await plain.client().get('/watch/NOADSVIDEO1');
        assert.equal(r.status, 200);
        assert.ok(!hasAd(r) && !/googlesyndication|adsbygoogle|adslot/.test(r.text), JSON.stringify(env));
        assert.doesNotMatch(r.header('content-security-policy'), /frame-src|unsafe-eval/);
      } finally {
        await plain.close();
      }
    }
  });
});
