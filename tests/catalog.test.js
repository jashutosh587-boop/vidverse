import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp } from './helpers/app.js';
import { createMember, login, makeAdmin } from './helpers/users.js';
import { buildCsp } from '../src/web/csp.js';
import { loadConfig, preflight } from '../src/config.js';
import { createCatalogService, CHANNELS } from '../src/services/catalog/index.js';
import { archiveDetails, archiveSearch, nasaDetails, nasaSearch, plainDescription, publicDomainLabel, shortTitle } from '../src/services/catalog/providers.js';

// ---------------------------------------------------------------- fake archives

const NASA_ITEM = (id, extra = {}) => ({
  href: `https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/collection.json`,
  data: [{ nasa_id: id, title: `Launch ${id}`, description: `Footage of <b>launch</b> ${id} &amp; ascent.`, media_type: 'video', center: 'KSC', date_created: '2021-07-20T00:00:00Z', keywords: ['Launch', 'Rocket', 'Kennedy'], ...extra }],
  links: [{ href: `https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/${encodeURIComponent(id)}~thumb.jpg`, rel: 'preview', render: 'image' }],
});

const nasaManifest = (id) => {
  const base = `http://images-assets.nasa.gov/video/${encodeURIComponent(id)}/${encodeURIComponent(id)}`;
  return [`${base}~orig.mp4`, `${base}~large.mp4`, `${base}~medium.mp4`, `${base}~mobile.mp4`, `${base}~large_thumb_00001.png`, `${base}~small_thumb_00001.png`, `http://images-assets.nasa.gov/video/${encodeURIComponent(id)}/metadata.json`];
};

const IA_DOC = (id) => ({ identifier: id, title: `Film ${id}`, year: '1952', licenseurl: 'http://creativecommons.org/licenses/publicdomain/', downloads: 1000 });
const IA_META = (id, over = {}) => ({
  metadata: { identifier: id, mediatype: 'movies', title: `Film ${id}`, year: '1952', licenseurl: 'http://creativecommons.org/licenses/publicdomain/', creator: 'Jam Handy Organization', subject: ['Ephemeral films', 'Safety'], description: '<p>A <i>classic</i> safety film.</p>', ...over },
  files: [
    { name: `${id}.mpeg`, format: 'MPEG2', source: 'original' },
    { name: `${id}_512kb.mp4`, format: '512Kb MPEG4', source: 'derivative' },
    { name: `${id}.mp4`, format: 'h.264', source: 'derivative' },
    { name: `${id}.ogv`, format: 'Ogg Video', source: 'derivative' },
  ],
});

const PROBE_OK = (seconds = 120) => ({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: String(seconds) }, streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360 }, { codec_type: 'audio', codec_name: 'aac' }] });

/**
 * A pretend set of archives. `nasa` maps a query to its items, `archive` maps a collection to its docs. Every request is
 * recorded, so tests can check that remembered items are never fetched again.
 */
function fakeArchives({ nasa = {}, archive = {}, iaMeta = {}, probe = () => PROBE_OK() } = {}) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'images-api.nasa.gov') {
      const items = nasa[u.searchParams.get('q')] ?? [];
      const page = Number(u.searchParams.get('page'));
      const size = Number(u.searchParams.get('page_size'));
      const slice = items.slice((page - 1) * size, page * size);
      return { collection: { items: slice, metadata: { total_hits: items.length }, links: page * size < items.length ? [{ rel: 'next', href: 'x' }] : [] } };
    }
    if (u.host === 'images-assets.nasa.gov') {
      const id = decodeURIComponent(u.pathname.split('/')[2]);
      return nasaManifest(id);
    }
    if (u.pathname === '/advancedsearch.php') {
      const coll = /collection:\((\w+)\)/.exec(u.searchParams.get('q'))[1];
      const docs = archive[coll] ?? [];
      const page = Number(u.searchParams.get('page'));
      const rows = Number(u.searchParams.get('rows'));
      return { response: { numFound: docs.length, docs: docs.slice((page - 1) * rows, page * rows) } };
    }
    if (u.pathname.startsWith('/metadata/')) {
      const id = decodeURIComponent(u.pathname.slice('/metadata/'.length));
      return iaMeta[id] ?? IA_META(id);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return {
    calls,
    deps: {
      get,
      pause: async () => {},
      getImage: async (url) => {
        calls.push(url);
        return Buffer.from('fake image');
      },
      imageToThumb: async (_bytes, out) => fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
      frameFromRemote: async (_url, _at, out) => fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9])),
      probeRemote: async (url) => {
        calls.push(`probe ${url}`);
        return probe(url);
      },
    },
  };
}

const nasaSource = (query, limit = 25) => ({ id: `nasa:${query}`, provider: 'nasa', query, channel: 'space', category: 'tech', limit });
const iaSource = (collection, maxYear, limit = 50) => ({ id: `archive:${collection}`, provider: 'archive', collection, maxYear, channel: 'shorts', category: 'education', limit });

// ---------------------------------------------------------------- the adapters on their own

describe('archive adapters', () => {
  test('NASA search keeps public NASA footage and refuses anything that mentions third-party rights', async () => {
    const items = [NASA_ITEM('KSC-1'), NASA_ITEM('KSC-2', { description: 'Music courtesy of a record label.' }), NASA_ITEM('KSC-3', { description: '© 2019 Somebody Else' }), NASA_ITEM('KSC-4', { media_type: 'image' })];
    const { deps } = fakeArchives({ nasa: { launch: items } });
    const r = await nasaSearch(deps.get, { query: 'launch', page: 1, pageSize: 25 });
    assert.equal(r.items.length, 3, 'the image item is not a video and is left out entirely');
    const [ok, courtesy, copyright] = r.items;
    assert.equal(ok.skip, undefined);
    assert.equal(ok.credit, 'NASA/KSC');
    assert.equal(ok.description, 'Footage of launch KSC-1 & ascent.');
    assert.deepEqual(ok.tags, ['launch', 'rocket', 'kennedy']);
    assert.equal(ok.pageUrl, 'https://images.nasa.gov/details/KSC-1');
    assert.match(courtesy.skip, /someone else/);
    assert.match(copyright.skip, /someone else/);
    assert.equal(r.hasMore, false);
  });

  test('NASA details prefer a medium-sized MP4, upgrade http to https and stay on NASA hosts', async () => {
    const { deps } = fakeArchives();
    const [item] = (await nasaSearch(async () => ({ collection: { items: [NASA_ITEM('AS11 Overview')] } }), { query: 'x' })).items;
    const d = await nasaDetails(deps.get, item);
    assert.equal(d.media[0], 'https://images-assets.nasa.gov/video/AS11%20Overview/AS11%20Overview~medium.mp4');
    assert.ok(d.media.every((u) => u.startsWith('https://images-assets.nasa.gov/')));
    assert.match(d.thumbs[0], /~large_thumb_00001\.png$/);
    assert.deepEqual(await nasaDetails(deps.get, { ...item, manifestUrl: 'https://evil.example.com/collection.json' }), { skip: 'no file list' });
  });

  test('Internet Archive search asks only for public-domain items up to the year limit', async () => {
    let asked = '';
    await archiveSearch(async (url) => {
      asked = new URL(url).searchParams.get('q');
      return { response: { numFound: 0, docs: [] } };
    }, { collection: 'prelinger', maxYear: 1965 });
    assert.match(asked, /collection:\(prelinger\)/);
    assert.match(asked, /year:\[1890 TO 1965\]/);
    assert.match(asked, /licenseurl:\(\*publicdomain\*\)/);
  });

  test('Internet Archive details re-check licence and year, and pick the H.264 file', async () => {
    const { deps } = fakeArchives({ iaMeta: { late: IA_META('late', { year: '1971' }), cc: IA_META('cc', { licenseurl: 'https://creativecommons.org/licenses/by-nc/4.0/' }), held: IA_META('held', { rights: 'This film is in copyright.' }) } });
    const ok = await archiveDetails(deps.get, { provider: 'archive', key: 'duck_and_cover', collection: 'prelinger' }, { maxYear: 1965 });
    assert.equal(ok.skip, undefined);
    assert.equal(ok.media[0], 'https://archive.org/download/duck_and_cover/duck_and_cover.mp4');
    assert.equal(ok.license, 'Public domain');
    assert.equal(ok.credit, 'Jam Handy Organization');
    assert.equal(ok.description, 'A classic safety film.');
    assert.equal(ok.pageUrl, 'https://archive.org/details/duck_and_cover');
    assert.match((await archiveDetails(deps.get, { key: 'late', collection: 'prelinger' }, { maxYear: 1965 })).skip, /1971 is after 1965/);
    assert.match((await archiveDetails(deps.get, { key: 'cc', collection: 'prelinger' }, { maxYear: 1965 })).skip, /public-domain licence/);
    assert.match((await archiveDetails(deps.get, { key: 'held', collection: 'prelinger' }, { maxYear: 1965 })).skip, /in copyright/);
  });

  test('text helpers', () => {
    assert.equal(plainDescription('<p>One &amp; two</p><p>Three&#8217;s</p>\u0007'), 'One & two\n\nThree’s');
    assert.equal(plainDescription('word '.repeat(2000), 50).length <= 50, true);
    assert.equal(shortTitle('x'.repeat(150)).length <= 100, true);
    assert.equal(publicDomainLabel('http://creativecommons.org/publicdomain/mark/1.0/'), 'Public domain');
    assert.equal(publicDomainLabel('https://creativecommons.org/publicdomain/zero/1.0/'), 'CC0 (public domain dedication)');
    assert.equal(publicDomainLabel('https://creativecommons.org/licenses/by/4.0/'), null);
  });

  test('the media-src widening accepts only exact https hosts', () => {
    const csp = buildCsp({ nonce: 'n', mediaHosts: ['https://archive.org', 'https://*.archive.org', '*', "'unsafe-inline'", 'http://plain.example.com', 'https://bad host.com', 'data:'] });
    const media = /media-src ([^;]+)/.exec(csp)[1];
    assert.equal(media, "'self' blob: https://archive.org https://*.archive.org");
  });
});

// ---------------------------------------------------------------- importing into a real app

describe('importing the catalog', () => {
  let app;

  before(async () => {
    app = await startTestApp();
  });
  after(() => app.close());

  const catalog = (fake, sources) => createCatalogService(app.ctx, { ...fake.deps, sources });

  test('imports playable public-domain videos into the site-owned channels, with credit and a stored thumbnail', async () => {
    const fake = fakeArchives({ nasa: { launch: [NASA_ITEM('KSC-10'), NASA_ITEM('KSC-11'), NASA_ITEM('KSC-12', { description: 'Courtesy of Some Studio' })] } });
    const c = catalog(fake, [nasaSource('launch')]);
    const r = await c.importPage({ sourceIndex: 0, page: 1 });
    assert.deepEqual({ imported: r.imported, skipped: r.skipped, failed: r.failed, next: r.next }, { imported: 2, skipped: 1, failed: 0, next: null });

    const v = await app.ctx.db.one(`SELECT v.*, u.handle, u.is_system FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.origin ->> 'key' = 'KSC-10'`);
    assert.equal(v.handle, CHANNELS.space.handle);
    assert.equal(v.is_system, true);
    assert.equal(v.source, 'linked');
    assert.equal(v.status, 'ready');
    assert.equal(v.visibility, 'public');
    assert.equal(v.duration_ms, 120_000);
    assert.equal(v.views, 0, 'no made-up numbers');
    assert.equal(v.media_url, 'https://images-assets.nasa.gov/video/KSC-10/KSC-10~medium.mp4');
    assert.equal(v.origin.credit, 'NASA/KSC');
    assert.equal(v.origin.license, 'Public domain (NASA media)');
    assert.ok(fs.existsSync(app.ctx.storage.resolve(v.id, 'thumb.jpg')));
    const skip = await app.ctx.db.one(`SELECT reason FROM catalog_skips WHERE provider = 'nasa' AND key = 'KSC-12'`);
    assert.match(skip.reason, /someone else/);
  });

  test('a second run imports nothing twice and never fetches remembered items again', async () => {
    const fake = fakeArchives({ nasa: { launch: [NASA_ITEM('KSC-10'), NASA_ITEM('KSC-11'), NASA_ITEM('KSC-12', { description: 'Courtesy of Some Studio' })] } });
    const r = await catalog(fake, [nasaSource('launch')]).importPage({ sourceIndex: 0, page: 1 });
    assert.equal(r.imported, 0);
    assert.equal(r.known, 3);
    assert.deepEqual(fake.calls.filter((u) => !u.startsWith('https://images-api.nasa.gov/search')), [], 'only the search page itself was fetched');
  });

  test('files a browser cannot play are refused and remembered; network trouble is retried later instead', async () => {
    const hevc = () => ({ format: { duration: '100' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 }] });
    const fake = fakeArchives({ nasa: { odd: [NASA_ITEM('HEVC-1')] }, probe: hevc });
    const r = await catalog(fake, [nasaSource('odd')]).importPage({ sourceIndex: 0, page: 1 });
    assert.equal(r.skipped, 1);
    const skip = await app.ctx.db.one(`SELECT reason FROM catalog_skips WHERE key = 'HEVC-1'`);
    assert.match(skip.reason, /hevc, not H\.264/);

    let flaky = true;
    const fake2 = fakeArchives({
      nasa: { net: [NASA_ITEM('NET-1')] },
      probe: () => {
        if (flaky) throw new Error('could not reach images-assets.nasa.gov');
        return PROBE_OK(60);
      },
    });
    const c = catalog(fake2, [nasaSource('net')]);
    const first = await c.importPage({ sourceIndex: 0, page: 1 });
    assert.equal(first.failed, 1);
    assert.equal(await app.ctx.db.one(`SELECT 1 AS x FROM catalog_skips WHERE key = 'NET-1'`), null, 'a network problem is not remembered as a refusal');
    flaky = false;
    const second = await c.importPage({ sourceIndex: 0, page: 1 });
    assert.equal(second.imported, 1);
  });

  test('a source stops at its limit, pages continue, and the run moves on to the next source', async () => {
    const many = Array.from({ length: 30 }, (_, i) => NASA_ITEM(`MANY-${i}`));
    const fake = fakeArchives({ nasa: { many }, archive: { prelinger: [IA_DOC('film_a'), IA_DOC('film_b')] } });
    const c = catalog(fake, [nasaSource('many', 27), iaSource('prelinger', 1965)]);
    const p1 = await c.importPage({ sourceIndex: 0, page: 1 });
    assert.equal(p1.imported, 25);
    assert.deepEqual(p1.next, { sourceIndex: 0, page: 2 });
    const p2 = await c.importPage(p1.next);
    assert.equal(p2.imported, 2, 'stops at the limit of 27');
    assert.deepEqual(p2.next, { sourceIndex: 1, page: 1 });
    const p3 = await c.importPage(p2.next);
    assert.equal(p3.imported, 2);
    assert.equal(p3.next, null);
    const film = await app.ctx.db.one(`SELECT v.media_url, v.origin, u.handle FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.origin ->> 'key' = 'film_a'`);
    assert.equal(film.handle, CHANNELS.shorts.handle);
    assert.equal(film.media_url, 'https://archive.org/download/film_a/film_a.mp4');
    assert.equal(film.origin.collection, 'Prelinger Archives, Internet Archive');
  });

  test('the whole catalog stops at CATALOG_MAX_VIDEOS', async () => {
    const fake = fakeArchives({ nasa: { cap: [NASA_ITEM('CAP-1')] } });
    const before = await app.ctx.db.one(`SELECT count(*)::int AS n FROM videos WHERE source = 'linked'`);
    app.ctx.config.catalog.maxVideos = before.n;
    try {
      const r = await catalog(fake, [nasaSource('cap')]).importPage({ sourceIndex: 0, page: 1 });
      assert.equal(r.imported, 0);
      assert.equal(r.next, null);
    } finally {
      app.ctx.config.catalog.maxVideos = 800;
    }
  });

  test('a catalog video deleted from the site is never imported again', async () => {
    const v = await app.ctx.db.one(`SELECT id FROM videos WHERE origin ->> 'key' = 'KSC-11'`);
    await app.ctx.videos.deleteVideo(v.id);
    const fake = fakeArchives({ nasa: { launch: [NASA_ITEM('KSC-11')] } });
    const r = await catalog(fake, [nasaSource('launch')]).importPage({ sourceIndex: 0, page: 1 });
    assert.equal(r.imported, 0);
    assert.match((await app.ctx.db.one(`SELECT reason FROM catalog_skips WHERE key = 'KSC-11'`)).reason, /deleted/);
  });

  test('missing thumbnails are re-created', async () => {
    const v = await app.ctx.db.one(`SELECT id FROM videos WHERE origin ->> 'key' = 'KSC-10'`);
    fs.rmSync(app.ctx.storage.resolve(v.id, 'thumb.jpg'));
    const fake = fakeArchives();
    const fixed = await catalog(fake, []).repairThumbs();
    assert.equal(fixed, 1);
    assert.ok(fs.existsSync(app.ctx.storage.resolve(v.id, 'thumb.jpg')));
  });

  test('the watch page plays the archive file directly, credits it, and opens media-src to that archive only', async () => {
    const v = await app.ctx.db.one(`SELECT id FROM videos WHERE origin ->> 'key' = 'KSC-10'`);
    const r = await app.client().get(`/watch/${v.id}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /data-src="https:\/\/images-assets\.nasa\.gov\/video\/KSC-10\/KSC-10~medium\.mp4"/);
    assert.match(r.text, /data-hls=""/);
    assert.doesNotMatch(r.text, /hls\.min\.js/);
    assert.match(r.text, /class="credit"/);
    assert.match(r.text, /<a href="https:\/\/images\.nasa\.gov\/details\/KSC-10" rel="noopener noreferrer nofollow" target="_blank">NASA Image and Video Library<\/a>/);
    assert.match(r.text, /Public domain \(NASA media\)/);
    const csp = r.header('content-security-policy');
    assert.match(csp, /media-src 'self' blob: https:\/\/images-assets\.nasa\.gov;/);

    const thumb = await app.client().get(`/media/t/${v.id}.jpg`);
    assert.equal(thumb.status, 200);
    const home = await app.client().get('/');
    assert.match(home.text, new RegExp(`/watch/${v.id}`));
    const channel = await app.client().get(`/@${CHANNELS.space.handle}`);
    assert.equal(channel.status, 200);
    assert.match(channel.text, /not affiliated with or endorsed by NASA/);
  });

  test('an uploaded video keeps the strict media policy', async () => {
    const csp = buildCsp({ nonce: 'n' });
    assert.match(csp, /media-src 'self' blob:;/);
  });

  test('catalog channels can never sign in or get a reset link, and never earn', async () => {
    const client = app.client();
    const email = `${CHANNELS.space.handle}@catalog.invalid`;
    const r = await login(client, email, '!');
    assert.equal(r.status, 401, 'the sign-in form is shown again with the generic error');
    assert.match(r.text, /do not match/);
    const before = app.ctx.mailer.sent.length;
    await client.post('/forgot-password', { email });
    assert.equal(app.ctx.mailer.sent.length, before, 'no email is sent to a catalog channel');
    const owner = await app.ctx.db.one('SELECT id, creator_terms_version FROM users WHERE handle = $1', [CHANNELS.space.handle]);
    assert.equal(owner.creator_terms_version, null, 'without creator terms there are no tips and no revenue share');
  });

  test('staff can remove a catalog video like any other', async () => {
    const client = app.client();
    const admin = await createMember(app, client, { email: 'staff@example.com', handle: 'staffer' });
    await makeAdmin(app, admin.id);
    const v = await app.ctx.db.one(`SELECT id FROM videos WHERE origin ->> 'key' = 'KSC-10'`);
    assert.equal(await app.ctx.videos.removeByStaff(v.id, admin.id, 'test'), true);
    const r = await app.client().get(`/watch/${v.id}`);
    assert.equal(r.status, 404);
  });

  test('the daily run is queued once, and only when CATALOG_IMPORT is on', async () => {
    assert.equal(await app.ctx.catalog.schedule(), false, 'off by default');
    app.ctx.config.catalog.enabled = true;
    try {
      assert.equal(await app.ctx.catalog.schedule(), true);
      assert.equal(await app.ctx.catalog.schedule(), false, 'the same day is not queued twice');
      const jobs = await app.ctx.db.query(`SELECT kind FROM jobs WHERE kind LIKE 'catalog%' ORDER BY kind`);
      assert.deepEqual(jobs.rows.map((j) => j.kind), ['catalog-import', 'catalog-repair']);
    } finally {
      app.ctx.config.catalog.enabled = false;
      await app.ctx.db.query(`DELETE FROM jobs WHERE kind LIKE 'catalog%'`);
    }
  });
});

// ---------------------------------------------------------------- running without email

describe('watch-only mode (SIGNUPS=closed)', () => {
  let app;
  before(async () => {
    app = await startTestApp({ env: { SIGNUPS: 'closed' } });
  });
  after(() => app.close());

  test('no sign-up form, no sign-up link, and a POST is refused', async () => {
    const client = app.client();
    const page = await client.get('/signup');
    assert.equal(page.status, 200);
    assert.match(page.text, /Sign-ups are closed for now/);
    assert.doesNotMatch(page.text, /name="handle"/);
    const home = await client.get('/');
    assert.doesNotMatch(home.text, /href="\/signup"/);
    const r = await client.post('/signup', { displayName: 'X', handle: 'someone', email: 'x@example.com', password: 'correct horse battery staple', adult: '1', terms: '1' });
    assert.equal(r.status, 403);
    assert.equal(await app.ctx.db.one(`SELECT 1 AS x FROM users WHERE email = 'x@example.com'`), null);
  });

  test('production without email starts only in watch-only mode', () => {
    const env = {
      NODE_ENV: 'production', BASE_URL: 'https://videos.example.com', SESSION_SECRET: 'x'.repeat(48), ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
      DATABASE_URL: 'postgres://u:p@db/x', PAYMENTS_PROVIDER: 'off', TRUST_PROXY: '1', OPERATOR_NAME: 'A', OPERATOR_ADDRESS: 'Pune', CONTACT_EMAIL: 'a@example.com',
      GRIEVANCE_OFFICER_NAME: 'A', GRIEVANCE_OFFICER_EMAIL: 'g@example.com', LEGAL_JURISDICTION: 'Pune, India', ALLOW_UNREVIEWED_LEGAL: 'true',
    };
    const open = preflight(loadConfig(env));
    assert.ok(open.errors.some((e) => /SIGNUPS=closed/.test(e)));
    const closed = preflight(loadConfig({ ...env, SIGNUPS: 'closed' }));
    assert.deepEqual(closed.errors, []);
    assert.ok(closed.warnings.some((w) => /watching only/.test(w)));
  });
});
