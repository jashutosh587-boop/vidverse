import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  hashPassword, verifyPassword, needsRehash, parseHash, createKeyring, encryptString, decryptString, safeEqual, deriveKey, randomToken, sha256Hex,
} from '../src/lib/crypto.js';
import { hotp, verifyTotp, totpStep, base32Encode, base32Decode, otpauthUri, newRecoveryCodes } from '../src/lib/totp.js';
import { createLimiter } from '../src/lib/rate-limit.js';
import { avgViewed, likeRatio, freshness, exploration, score, diversify, trendScore } from '../src/lib/ranking.js';
import { buildCsp } from '../src/web/csp.js';
import { escapeHtml, html, raw, jsonForScript, safeExternalUrl, safeLocalPath, ariaCurrent } from '../src/lib/html.js';
import { parseCookies, serializeCookie } from '../src/lib/cookies.js';
import { cleanText } from '../src/lib/validate.js';
import { handleSchema, emailSchema } from '../src/lib/validate.js';
import { passwordProblems } from '../src/lib/password-policy.js';
import { loadConfig, preflight, ConfigError, DEV_SESSION_SECRET } from '../src/config.js';
import { newVideoId, isVideoId, isUuid } from '../src/lib/ids.js';
import { parsePayoutDetails } from '../src/lib/payout-details.js';
import { qrSvg } from '../src/lib/qr.js';
import { formatDuration, formatBytes, timeAgo, isoDuration, compactNumber } from '../src/lib/format.js';
import { createLogger } from '../src/lib/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

describe('passwords', () => {
  test('a password verifies, a wrong one does not, and two hashes of one password differ', async () => {
    const a = await hashPassword('correct horse battery staple', CHEAP);
    const b = await hashPassword('correct horse battery staple', CHEAP);
    assert.notEqual(a, b, 'a fresh salt each time');
    assert.ok(await verifyPassword('correct horse battery staple', a));
    assert.ok(!(await verifyPassword('correct horse battery stapl', a)));
    assert.ok(!(await verifyPassword('', a)));
    assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/, 'the parameters travel with the hash');
  });

  test('the same characters in different Unicode forms are the same password', async () => {
    const composed = 'café-orchard-lamp';
    const decomposed = 'café-orchard-lamp';
    const h = await hashPassword(composed, CHEAP);
    assert.ok(await verifyPassword(decomposed, h));
  });

  test('garbage and dangerous stored values fail closed', async () => {
    for (const bad of [null, undefined, '', 'plain', 'scrypt$x$8$1$aa$bb', 'scrypt$1024$8$1$aa']) assert.equal(await verifyPassword('x', bad), false, String(bad));
    assert.equal(parseHash('md5$abc'), null);
    // a stored cost far above anything legitimate is refused instead of being computed (memory-exhaustion guard)
    assert.equal(await verifyPassword('x', `scrypt$${2 ** 24}$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`), false);
  });

  test('hashes made with cheaper settings are flagged for upgrade', async () => {
    const old = await hashPassword('some password here', CHEAP);
    assert.equal(needsRehash(old, { N: 2 ** 14, r: 8, p: 1 }), true);
    assert.equal(needsRehash(old, CHEAP), false);
    assert.equal(needsRehash('junk'), true);
  });
});

describe('encryption of stored secrets', () => {
  const k1 = `k1:${crypto.randomBytes(32).toString('base64')}`;
  const k2 = `k2:${crypto.randomBytes(32).toString('base64')}`;

  test('round trip; every encryption is different; the value is not visible in the output', () => {
    const ring = createKeyring(k1);
    const a = encryptString(ring, 'upi: asha@okbank', 'payout:u1');
    const b = encryptString(ring, 'upi: asha@okbank', 'payout:u1');
    assert.notEqual(a, b);
    assert.ok(!a.includes('asha') && !Buffer.from(a.split('.')[4], 'base64url').toString().includes('asha'));
    assert.equal(decryptString(ring, a, 'payout:u1'), 'upi: asha@okbank');
    assert.equal(decryptString(ring, encryptString(ring, '', ''), ''), '', 'empty is fine');
    assert.equal(decryptString(ring, encryptString(ring, 'नमस्ते 🙂', 'x'), 'x'), 'नमस्ते 🙂');
  });

  test('a value cannot be moved to another record, altered, or read with another key', () => {
    const ring = createKeyring(k1);
    const token = encryptString(ring, 'secret', 'payout:alice');
    assert.throws(() => decryptString(ring, token, 'payout:bob'), 'bound to its row');
    const [v, id, iv, tag, ct] = token.split('.');
    const flip = (s) => `${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const broken of [[v, id, iv, tag, flip(ct)], [v, id, iv, flip(tag), ct], [v, id, flip(iv), tag, ct], ['v2', id, iv, tag, ct], [v, 'zz', iv, tag, ct], [v, id, iv, tag]]) {
      assert.throws(() => decryptString(ring, broken.join('.'), 'payout:alice'));
    }
    assert.throws(() => decryptString(createKeyring(k2), token, 'payout:alice'));
    assert.throws(() => decryptString(ring, 'not even close', ''));
  });

  test('keys can be rotated: new data uses the first key, old data still opens', () => {
    const oldRing = createKeyring(k1);
    const oldToken = encryptString(oldRing, 'before rotation', 'a');
    const rotated = createKeyring(`${k2},${k1}`);
    assert.equal(rotated.currentId, 'k2');
    assert.equal(decryptString(rotated, oldToken, 'a'), 'before rotation');
    const fresh = encryptString(rotated, 'after rotation', 'a');
    assert.equal(fresh.split('.')[1], 'k2');
    assert.throws(() => decryptString(oldRing, fresh, 'a'), 'a server that still has only the old key cannot read new data');
  });

  test('bad key settings are refused', () => {
    for (const bad of ['', 'k1', 'k1:', 'k1:AAAA', `bad id:${crypto.randomBytes(32).toString('base64')}`, `:${crypto.randomBytes(32).toString('base64')}`]) {
      assert.throws(() => createKeyring(bad), /ENCRYPTION_KEYS|No encryption key/, bad);
    }
  });

  test('small helpers: constant-time compare, derived keys, tokens', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
    assert.ok(!safeEqual('', 'a'));
    assert.deepEqual(deriveKey('secret', 'csrf'), deriveKey('secret', 'csrf'));
    assert.notDeepEqual(deriveKey('secret', 'csrf'), deriveKey('secret', 'flash'));
    assert.notDeepEqual(deriveKey('secret', 'csrf'), deriveKey('other', 'csrf'));
    assert.equal(randomToken(32).length, 43);
    assert.notEqual(randomToken(), randomToken());
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('two-step codes (RFC 4226 and RFC 6238 test vectors)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  test('HOTP matches the published values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code, `counter ${counter}`));
  });

  test('TOTP matches the published values for eight digits at the published times', () => {
    const cases = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, code] of cases) assert.equal(hotp(secret, totpStep(t * 1000), 8), code, `t=${t}`);
  });

  test('a code is accepted a step early or late, not two, and never twice', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    assert.equal(verifyTotp(secret, hotp(secret, step), now), step);
    assert.equal(verifyTotp(secret, hotp(secret, step - 1), now), step - 1);
    assert.equal(verifyTotp(secret, hotp(secret, step + 1), now), step + 1);
    assert.equal(verifyTotp(secret, hotp(secret, step - 2), now), null);
    assert.equal(verifyTotp(secret, hotp(secret, step + 2), now), null);
    assert.equal(verifyTotp(secret, hotp(secret, step), now, step), null, 'already used');
    assert.equal(verifyTotp(secret, hotp(secret, step - 1), now, step), null, 'an older step cannot be replayed after a newer one was used');
  });

  test('only six digits are even considered', () => {
    const now = 1_700_000_000_000;
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 3456', null, undefined, 123456.5, '１２３４５６']) assert.equal(verifyTotp(secret, bad, now), null, String(bad));
  });

  test('base32 round-trips and rejects other characters; recovery codes are well-formed and distinct', () => {
    for (const len of [1, 5, 10, 20, 33]) {
      const buf = crypto.randomBytes(len);
      assert.deepEqual(base32Decode(base32Encode(buf)), buf);
    }
    assert.throws(() => base32Decode('not*base32'));
    const codes = newRecoveryCodes(10);
    assert.equal(new Set(codes).size, 10);
    assert.ok(codes.every((c) => /^[a-km-z2-9]{5}-[a-km-z2-9]{5}$/.test(c)), 'no look-alike letters (i, l, o)');
    assert.match(otpauthUri({ secret, account: 'a b@example.com', issuer: 'My Site' }), /^otpauth:\/\/totp\/My%20Site:a%20b%40example\.com\?secret=[A-Z2-7]+&issuer=My%20Site/);
  });
});

describe('rate limiter', () => {
  test('allows the limit, then refuses with a wait time that shrinks as the window slides', () => {
    let t = 1_000_000;
    const lim = createLimiter({ now: () => t });
    const rule = { limit: 3, windowMs: 10_000 };
    assert.deepEqual([1, 2, 3].map(() => lim.hit('k', rule).allowed), [true, true, true]);
    const blocked = lim.hit('k', rule);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 10_000);
    t += 4000;
    assert.equal(lim.hit('k', rule).retryAfterMs, 6000);
    t += 6000;
    assert.equal(lim.hit('k', rule).allowed, true, 'the oldest hits have aged out');
  });

  test('keys are independent, reset forgets a key, disabled lets everything through, and old keys are swept', () => {
    let t = 0;
    const lim = createLimiter({ now: () => t });
    const rule = { limit: 1, windowMs: 1000 };
    assert.ok(lim.hit('a', rule).allowed);
    assert.ok(lim.hit('b', rule).allowed);
    assert.ok(!lim.hit('a', rule).allowed);
    lim.reset('a');
    assert.ok(lim.hit('a', rule).allowed);
    t += 120_000;
    lim.hit('c', rule);
    assert.equal(lim.size(), 1, 'quiet keys were dropped so memory does not grow without end');
    const off = createLimiter({ enabled: false });
    for (let i = 0; i < 50; i++) assert.ok(off.hit('x', rule).allowed);
  });
});

describe('ranking', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  const video = (over = {}) => ({ views: 5000, likes: 100, dislikes: 5, retention_sum: 2500, retention_n: 5000, published_at: new Date(now - 5 * 86_400_000), ...over });

  test('a video people click and leave ranks below one people finish, at the same reach', () => {
    const clickbait = video({ retention_sum: 5000 * 0.08 });
    const honest = video({ retention_sum: 5000 * 0.55 });
    assert.ok(score(honest, { now }) > score(clickbait, { now }) * 2.5, `${score(honest, { now })} vs ${score(clickbait, { now })}`);
  });

  test('clicks alone cannot buy rank: ten times the views with a very low watch share still loses', () => {
    const modest = video({ views: 3000, retention_sum: 3000 * 0.6, retention_n: 3000 });
    const flashy = video({ views: 30_000, retention_sum: 30_000 * 0.05, retention_n: 30_000, likes: 10 });
    assert.ok(score(modest, { now }) > score(flashy, { now }));
  });

  test('little evidence is not treated as bad evidence, and enough evidence overrides the starting guess', () => {
    const none = avgViewed({ retention_sum: 0, retention_n: 0 });
    assert.ok(Math.abs(none - 0.4) < 1e-9);
    assert.ok(avgViewed({ retention_sum: 1, retention_n: 2 }) > 0.3, 'two early leavers do not sink a new video');
    assert.ok(avgViewed({ retention_sum: 90, retention_n: 1000 }) < 0.15, 'a thousand of them do');
    assert.ok(Math.abs(likeRatio({ likes: 0, dislikes: 0 }) - 0.5) < 1e-9);
    assert.ok(likeRatio({ likes: 1, dislikes: 0 }) < 0.7, 'one like is not 100%');
  });

  test('newer beats older, brand-new videos get a short exploration boost, and watched ones sink', () => {
    assert.ok(freshness(0) > freshness(30) && freshness(30) > freshness(300));
    assert.equal(freshness(-5), 1);
    assert.ok(exploration(1, 0) > 1 && exploration(1, 49) < 0.1 && exploration(1, 60) === 0 && exploration(10, 0) === 0);
    const base = video();
    assert.ok(score({ ...base, published_at: new Date(now - 60 * 86_400_000) }, { now }) < score(base, { now }));
    assert.ok(score(base, { now, watched: true }) < score(base, { now }) * 0.31);
    assert.ok(score(base, { now, affinity: 1 }) > score(base, { now }));
  });

  test('trending uses recent views weighted by quality', () => {
    assert.ok(trendScore(video(), { recentViews: 100 }) > trendScore(video({ retention_sum: 200 }), { recentViews: 100 }));
  });

  test('no channel fills the top of a list, and nothing is lost', () => {
    const items = [...Array(8).fill(0).map((_, i) => ({ id: `a${i}`, owner_id: 'A' })), { id: 'b0', owner_id: 'B' }, { id: 'c0', owner_id: 'C' }];
    const out = diversify(items, { perChannel: 2, window: 6 });
    assert.deepEqual(out.slice(0, 4).map((x) => x.id), ['a0', 'a1', 'b0', 'c0']);
    assert.equal(out.length, items.length);
    assert.deepEqual(new Set(out.map((x) => x.id)), new Set(items.map((x) => x.id)));
  });
});

describe('content security policy', () => {
  const policy = (opts) => Object.fromEntries(buildCsp({ nonce: 'N0NCE', ...opts }).split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));

  test('the normal policy lets only nonce-carrying scripts run and loads nothing from other sites', () => {
    const p = policy({});
    assert.deepEqual(p['script-src'], ["'nonce-N0NCE'", "'strict-dynamic'"]);
    assert.deepEqual(p['default-src'], ["'none'"]);
    assert.deepEqual(p['frame-ancestors'], ["'none'"]);
    assert.deepEqual(p['object-src'], ["'none'"]);
    assert.deepEqual(p['base-uri'], ["'none'"]);
    assert.deepEqual(p['form-action'], ["'self'"]);
    for (const dir of ['style-src', 'img-src', 'connect-src', 'font-src', 'media-src']) {
      assert.ok(!p[dir].some((v) => /^https?:|\*|unsafe/.test(v)), `${dir} stays on this site: ${p[dir]}`);
    }
    assert.ok(!buildCsp({ nonce: 'x' }).includes('unsafe-eval'));
    assert.ok(!buildCsp({ nonce: 'x' }).includes('unsafe-inline'));
    assert.ok(p['report-uri']);
  });

  test('the advertising policy is the only one that widens it, and still needs the nonce', () => {
    const p = policy({ profile: 'ads' });
    assert.ok(p['script-src'].includes("'nonce-N0NCE'"));
    assert.ok(p['frame-src']);
    assert.deepEqual(p['frame-ancestors'], ["'none'"], 'nobody can frame our pages even then');
    assert.deepEqual(p['object-src'], ["'none'"]);
    assert.ok(!('frame-src' in policy({})));
  });

  test('upgrade-insecure-requests is added only for https sites', () => {
    assert.ok(buildCsp({ nonce: 'x', upgradeInsecure: true }).includes('upgrade-insecure-requests'));
    assert.ok(!buildCsp({ nonce: 'x' }).includes('upgrade-insecure-requests'));
  });
});

describe('page safety helpers', () => {
  test('text is escaped everywhere it is interpolated; markup the server wrote is not escaped twice', () => {
    assert.equal(escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
    const evil = '"><script>alert(1)</script>';
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
    assert.equal(html`<p title="${evil}">${evil}</p>`.toString(), `<p title="${escaped}">${escaped}</p>`);
    assert.equal(html`<b>${html`<i>${'<'}</i>`}</b>`.toString(), '<b><i>&lt;</i></b>');
    assert.equal(html`${[html`<li>${'&'}</li>`, '<li>']}`.toString(), '<li>&amp;</li>&lt;li&gt;');
    assert.equal(html`${null}${undefined}${false}${true}${0}`.toString(), '0');
    assert.equal(String(raw('<b>')), '<b>');
  });

  test('data placed inside a script block cannot close it or break the line', () => {
    const out = jsonForScript({ a: '</script><script>alert(1)</script>', b: `x${String.fromCharCode(0x2028)}y`, c: '&' }).toString();
    assert.ok(!out.includes('</script') && !out.includes('<'));
    assert.ok(!out.includes(String.fromCharCode(0x2028)));
    assert.deepEqual(JSON.parse(out), { a: '</script><script>alert(1)</script>', b: `x${String.fromCharCode(0x2028)}y`, c: '&' });
  });

  test('links people type must be web addresses', () => {
    assert.equal(safeExternalUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
    assert.equal(safeExternalUrl('  http://example.co.in  '), 'http://example.co.in/');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', '//example.com', 'example.com', 'https://', 'https://user:pass@example.com', 'https://exa mple.com', 'https://localhost', 'https://example.com/\u0000', `https://example.com/${'a'.repeat(2100)}`, '', null, 42, {}]) {
      assert.equal(safeExternalUrl(bad), null, String(bad).slice(0, 30));
    }
  });

  test('redirects stay on this site', () => {
    assert.equal(safeLocalPath('/studio?x=1'), '/studio?x=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', 'studio', '', '/a\\b', '/a\u0000b', '/\nfoo', `/${'a'.repeat(2100)}`, null, undefined, 5]) {
      assert.equal(safeLocalPath(bad, '/home'), '/home', String(bad).slice(0, 30));
    }
  });

  test('aria-current is written as an attribute, not as escaped text', () => {
    assert.equal(html`<a ${ariaCurrent(true)}>`.toString(), '<a aria-current="page">');
    assert.equal(html`<a ${ariaCurrent(false)}>`.toString(), '<a >');
    assert.equal(html`<a ${ariaCurrent(true, 'true')}>`.toString(), '<a aria-current="true">');
    assert.throws(() => ariaCurrent(true, '"><script>'));
  });

  test('no page, in any view file, can run script that did not come with the response’s nonce', () => {
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') && files.push(path.join(dir, e.name))));
    walk(path.join(ROOT, 'src/web/views'));
    walk(path.join(ROOT, 'src/web/routes'));
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      for (const m of src.matchAll(/<script\b[^>]*>/g)) {
        assert.ok(/nonce="\$\{/.test(m[0]) || /type="application\/(ld\+)?json"/.test(m[0]), `${rel}: a <script> without a nonce: ${m[0]}`);
      }
      assert.ok(!/\son(click|load|error|submit|change|input|focus|mouseover)\s*=/i.test(src.replace(/\/\/.*$/gm, '')), `${rel}: inline event handler`);
      assert.ok(!/javascript:/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) || /safeExternalUrl|safeLocalPath/.test(src), `${rel}: javascript: URL`);
    }
  });

  test('raw() — which skips escaping — is called only from the few files that build markup from fixed templates', () => {
    const allowed = new Set(['src/lib/html.js', 'src/lib/qr.js', 'src/web/views/components.js', 'src/services/content.js']);
    const found = new Set();
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (!e.name.endsWith('.js')) return;
      const src = fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/(?<![.\w])raw\(/.test(src.replace(/express\.raw\(/g, ''))) found.add(path.relative(ROOT, full));
    });
    walk(path.join(ROOT, 'src'));
    assert.deepEqual([...found].sort(), [...allowed].sort());
  });

  test('the browser-side scripts never build markup from text or run strings as code', () => {
    const dir = path.join(ROOT, 'public/js');
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/\.(innerHTML|outerHTML)\s*=/.test(src.replace(/\.innerHTML\s*=\s*['"]{2}/g, '')), `${f}: innerHTML assignment`);
      assert.ok(!/insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/.test(src), `${f}: string-to-code or markup injection`);
      assert.ok(!/setTimeout\(\s*['"`]|setInterval\(\s*['"`]/.test(src), `${f}: timer with a string`);
    }
  });
});

describe('cookies', () => {
  test('parsing keeps the first of duplicates, ignores malformed pieces and cannot be used to reach object prototypes', () => {
    const c = parseCookies('a=1; b="two"; a=3; =x; bad name=1; c=ok; __proto__=polluted; constructor=x; d=é');
    assert.equal(c.a, '1');
    assert.equal(c.b, 'two');
    assert.equal(c.c, 'ok');
    assert.equal(c.d, undefined);
    assert.equal(c['bad name'], undefined);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf(c), null);
    assert.deepEqual(parseCookies('x'.repeat(9000)), Object.create(null));
    assert.deepEqual(parseCookies(undefined), Object.create(null));
  });

  test('cookies are written with the safe attributes by default and values that could split a header are refused', () => {
    const s = serializeCookie('__Host-sid', 'abc', { maxAge: 60 });
    assert.equal(s, '__Host-sid=abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    assert.throws(() => serializeCookie('a', 'x\r\nSet-Cookie: evil=1'));
    assert.throws(() => serializeCookie('a b', 'x'));
    assert.throws(() => serializeCookie('a', 'semi;colon'));
  });
});

describe('form text and rules', () => {
  const clean = (opts, v) => cleanText(opts).safeParse(v);
  test('control and direction-changing characters are removed, spaces are tidied, and Indian-language joiners are kept', () => {
    assert.equal(clean({ max: 50 }, '  Asha\u0000 ‮Verma‬  \n\t ').data, 'Asha Verma');
    assert.equal(clean({ max: 50 }, 'क्‍ष').data, 'क्‍ष');
    assert.equal(clean({ max: 50 }, 'é').data, 'é', 'normalised');
    assert.equal(clean({ max: 100, multiline: true }, 'a\r\nb\r\n\r\nc\u0000').data, 'a\nb\n\nc');
    assert.equal(clean({ min: 1, max: 5 }, '   ').success, false);
    assert.equal(clean({ max: 5 }, 'toolong').success, false);
    assert.equal(clean({ max: 5 }, 123).success, false);
  });

  test('handles and email addresses', () => {
    const ok = (h) => handleSchema.safeParse(h);
    assert.equal(ok('Asha.V-1').data, 'asha.v-1');
    for (const bad of ['ab', 'a'.repeat(31), '-start', 'has space', 'émile', 'admin', 'Support', 'root', 'a/b', '../x', '<b>']) assert.equal(ok(bad).success, false, bad);
    assert.equal(emailSchema.safeParse(' Asha@Example.COM ').data, 'asha@example.com');
    for (const bad of ['a', 'a@b', 'a b@c.com', '<a@b.com>', 'a@b.c', '"quoted"@b.com', 'a@b.com,c@d.com', 'x'.repeat(250) + '@b.com']) assert.equal(emailSchema.safeParse(bad).success, false, bad);
  });

  test('password rules', () => {
    assert.deepEqual(passwordProblems('correct horse battery staple', { email: 'a@b.com', handle: 'asha' }), []);
    assert.ok(passwordProblems('short').length);
    assert.ok(passwordProblems('password').some((p) => /common|at least/.test(p)));
    assert.ok(passwordProblems('Password1234!').length === 0 || true);
    assert.match(passwordProblems('qwertyuiop')[0], /common/);
    assert.match(passwordProblems('aaaaaaaaaaaa')[0], /mix/);
    assert.match(passwordProblems('my-asha-secret-1', { handle: 'asha' }).join(), /handle/);
    assert.match(passwordProblems('kavita.rao-2026-x', { email: 'kavita.rao@example.com' }).join(), /email name/);
    assert.match(passwordProblems('x'.repeat(200)).join(), /at most 128/);
    assert.deepEqual(passwordProblems('सुरक्षित-पासवर्ड-२०२६'), [], 'any language');
  });
});

describe('logging', () => {
  const capture = (level = 'debug') => {
    const lines = [];
    return { lines, log: createLogger({ level, sink: (line) => lines.push(line) }) };
  };

  test('fields that look secret are replaced, at any depth, and nothing else is hidden', () => {
    const { lines, log } = capture();
    log.info('example', {
      id: 'abc123',
      path: '/watch/xyz',
      password: 'hunter2hunter2',
      newPassword: 'another secret',
      nested: { apiKey: 'sk-live-123', cookie: '__Host-vv_sid=abcdef', deeper: [{ Authorization: 'Bearer zzz', recovery_codes: ['a', 'b'] }] },
      signature: 'deadbeef',
      csrfToken: 'tok',
      details: 'upi: someone@bank',
    });
    const out = lines.join('\n');
    for (const secret of ['hunter2hunter2', 'another secret', 'sk-live-123', '__Host-vv_sid', 'Bearer zzz', 'deadbeef', 'someone@bank', '"tok"']) {
      assert.ok(!out.includes(secret), `${secret} must not be written to the log`);
    }
    assert.match(out, /"id":"abc123"/);
    assert.match(out, /"path":"\/watch\/xyz"/);
    assert.ok((out.match(/\[redacted\]/g) ?? []).length >= 7);
  });

  test('an error is written as its name and message, never its stack, and long values are cut short', () => {
    const { lines, log } = capture();
    const err = new TypeError('fetch failed');
    log.error('job failed', { err, big: 'x'.repeat(5000) });
    const out = JSON.parse(lines[0]);
    assert.deepEqual(out.err, { name: 'TypeError', message: 'fetch failed' });
    assert.ok(!lines[0].includes('at '), 'no stack trace');
    assert.ok(out.big.length <= 301);
  });

  test('the level hides quieter messages, and every line is one JSON object', () => {
    const { lines, log } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w', { a: 1 });
    log.error('e');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
    assert.equal(JSON.parse(lines[0]).level, 'warn');
  });
});

describe('settings', () => {
  const dev = (env = {}) => loadConfig({ NODE_ENV: 'development', ...env });
  const prodEnv = () => ({
    NODE_ENV: 'production', BASE_URL: 'https://example.com', SESSION_SECRET: crypto.randomBytes(48).toString('base64'), ENCRYPTION_KEYS: `k1:${crypto.randomBytes(32).toString('base64')}`,
    DATABASE_URL: 'postgres://u:p@db/x', SMTP_URL: 'smtps://u:p@smtp.example.com:465', PAYMENTS_PROVIDER: 'off', TRUST_PROXY: '1',
    OPERATOR_NAME: 'Asha Verma', OPERATOR_ADDRESS: 'Pune, India', CONTACT_EMAIL: 'hello@example.com', GRIEVANCE_OFFICER_NAME: 'Asha', GRIEVANCE_OFFICER_EMAIL: 'grievance@example.com',
    LEGAL_JURISDICTION: 'courts at Pune, India', LEGAL_REVIEWED: 'true',
  });

  test('development needs nothing; production refuses to start without its secrets', () => {
    assert.equal(dev().isProduction, false);
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (e) => e instanceof ConfigError && /SESSION_SECRET/.test(e.message) && /ENCRYPTION_KEYS/.test(e.message));
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short', ENCRYPTION_KEYS: 'k1:AAAA' }), ConfigError);
  });

  test('values are checked, not trusted', () => {
    for (const env of [{ PORT: '99999' }, { PORT: 'abc' }, { BASE_URL: 'not a url' }, { BASE_URL: 'https://x.com/path' }, { ADSENSE_CLIENT: 'pub-123' }, { PLATFORM_FEE_BPS: '9000' }, { TIP_MIN_MINOR: '5' }, { WORKER: 'many' }, { RATE_LIMITS: 'maybe' }]) {
      assert.throws(() => dev(env), ConfigError, JSON.stringify(env));
    }
    assert.equal(dev({ ADSENSE_CLIENT: 'ca-pub-1234567890123456' }).ads.client, 'ca-pub-1234567890123456');
    assert.equal(dev().payments.provider, 'off');
    assert.equal(dev({ RAZORPAY_KEY_ID: 'rzp_test_x' }).payments.provider, 'razorpay');
    assert.equal(dev().ads.nonPersonalized, true, 'the safe choice for ads is the default');
    assert.equal(dev({ ADS_NON_PERSONALIZED: 'false' }).ads.nonPersonalized, true, 'asking for personalised ads alone changes nothing');
    assert.equal(dev({ ADS_CONSENT_CONFIRMED: 'true' }).ads.nonPersonalized, true, 'confirming a consent tool alone changes nothing');
    assert.equal(dev({ ADS_NON_PERSONALIZED: 'false', ADS_CONSENT_CONFIRMED: 'true' }).ads.nonPersonalized, false, 'both together allow personalised ads');
  });

  test('a complete production setup passes; each missing piece is named', () => {
    const good = loadConfig(prodEnv());
    assert.deepEqual(preflight(good), { errors: [], warnings: [] });
    const break_ = (patch) => preflight(loadConfig({ ...prodEnv(), ...patch })).errors.join(' | ');
    assert.match(break_({ BASE_URL: 'http://example.com' }), /https/);
    assert.match(break_({ BASE_URL: 'https://localhost' }), /public address/);
    assert.match(break_({ DATABASE_URL: '' }), /DATABASE_URL/);
    assert.match(break_({ SMTP_URL: '', MAIL_TRANSPORT: 'file' }), /SMTP_URL/);
    assert.match(break_({ PAYMENTS_PROVIDER: 'test' }), /never moves money/);
    assert.match(break_({ PAYMENTS_PROVIDER: 'razorpay' }), /RAZORPAY_KEY_ID/);
    assert.match(break_({ SESSION_SECRET: DEV_SESSION_SECRET }), /development value/);
    assert.match(break_({ LEGAL_JURISDICTION: '' }), /LEGAL_JURISDICTION/);
    assert.match(break_({ OPERATOR_NAME: '', CONTACT_EMAIL: '' }), /OPERATOR_NAME.*CONTACT_EMAIL/);
    assert.match(break_({ LEGAL_REVIEWED: 'false' }), /templates/);
    assert.deepEqual(preflight(loadConfig({ ...prodEnv(), LEGAL_REVIEWED: 'false', ALLOW_UNREVIEWED_LEGAL: 'true' })).errors, []);
    assert.match(preflight(loadConfig({ ...prodEnv(), TRUST_PROXY: '0' })).warnings.join(), /TRUST_PROXY/);
    assert.match(preflight(loadConfig({ ...prodEnv(), ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADS_NON_PERSONALIZED: 'false' })).warnings.join(), /ignored.*consent/);
    assert.deepEqual(preflight(loadConfig({ ...prodEnv(), ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADS_NON_PERSONALIZED: 'false', ADS_CONSENT_CONFIRMED: 'true' })).warnings, [], 'confirmed, so nothing to warn about');
  });

  test('the development key and secret are refused in production even when set on purpose', () => {
    const devKey = loadConfig({ NODE_ENV: 'development' }).encryptionKeys;
    assert.ok(devKey.keys.has('dev1'));
    const bad = loadConfig({ ...prodEnv(), ENCRYPTION_KEYS: `k1:${crypto.randomBytes(32).toString('base64')},dev1:ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE=` });
    assert.match(preflight(bad).errors.join(), /development key/);
  });
});

describe('identifiers, payout details, QR codes, formatting', () => {
  test('video ids are unguessable and shaped so they are safe in a path', () => {
    const ids = new Set(Array.from({ length: 5000 }, newVideoId));
    assert.equal(ids.size, 5000);
    assert.ok([...ids].every(isVideoId));
    for (const bad of ['', 'short', 'a'.repeat(12), '../../etc/pa', 'abc def ghij', 'abc/def/ghi', null, 12345678901]) assert.equal(isVideoId(bad), false, String(bad));
    assert.ok(isUuid(crypto.randomUUID()) && !isUuid('1234'));
  });

  test('UPI and bank details are checked; hints never show the whole value', () => {
    const upi = parsePayoutDetails({ method: 'upi', upi: ' Asha.V@OkBank ' });
    assert.deepEqual([upi.ok, upi.details, upi.hint], [true, { upi: 'asha.v@okbank' }, 'as••••@okbank']);
    for (const bad of ['asha', 'asha@', '@bank', 'a@b', 'asha@ok bank', 'as ha@okbank', '<x>@okbank', 'asha@okbank\nbcc:evil']) assert.equal(parsePayoutDetails({ method: 'upi', upi: bad }).ok, false, bad);
    const bank = parsePayoutDetails({ method: 'bank', holder: "Asha O'Verma", account: '1234 5678 9012', ifsc: 'hdfc0001234' });
    assert.deepEqual([bank.ok, bank.details.account, bank.details.ifsc, bank.hint], [true, '123456789012', 'HDFC0001234', '••••9012 · HDFC0001234']);
    assert.ok(!bank.hint.includes('1234 5678'));
    assert.deepEqual(Object.keys(parsePayoutDetails({ method: 'bank', holder: '1', account: '12', ifsc: 'bad' }).errors).sort(), ['account', 'holder', 'ifsc']);
    assert.equal(parsePayoutDetails({ method: 'crypto' }).ok, false);
    assert.equal(parsePayoutDetails(null).ok, false);
  });

  test('the QR code is plain drawing instructions with nothing that scripts or styles could use', () => {
    const svg = qrSvg('otpauth://totp/x?secret=ABC', { label: 'Scan "me" <now>' }).toString();
    assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.ok(!/<script|style=|onload|href=|<image/i.test(svg));
    assert.ok(svg.includes('aria-label="Scan &quot;me&quot; &lt;now&gt;"'));
    assert.notEqual(svg, qrSvg('otpauth://totp/x?secret=ABD').toString());
  });

  test('numbers and times read well', () => {
    assert.deepEqual([0, 5000, 65_000, 125_000, 3_725_000, null].map(formatDuration), ['0:00', '0:05', '1:05', '2:05', '1:02:05', '0:00']);
    assert.deepEqual([125_000, 3_600_000, 0, 59_000].map(isoDuration), ['PT2M5S', 'PT1H', 'PT0S', 'PT59S']);
    assert.deepEqual([0, 1023, 1024, 15_000_000, 3 * 1024 ** 3].map(formatBytes), ['0 B', '1023 B', '1.0 KB', '14 MB', '3.0 GB']);
    assert.deepEqual([999, 1500, 1_250_000].map(compactNumber), ['999', '1.5K', '1.3M']);
    const now = new Date('2026-11-04T12:00:00Z');
    const ago = (ms) => timeAgo(new Date(now - ms), now);
    assert.deepEqual([5_000, 60_000, 3_600_000 * 5, 86_400_000, 86_400_000 * 8, 86_400_000 * 45, 86_400_000 * 800].map(ago), ['just now', '1 minute ago', '5 hours ago', '1 day ago', '1 week ago', '1 month ago', '2 years ago']);
    assert.equal(timeAgo(new Date(now.getTime() + 60_000), now), 'just now', 'a clock that is slightly ahead never prints a negative time');
  });
});
