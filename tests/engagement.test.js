import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember, PASSWORD } from './helpers/users.js';
import { dayString } from '../src/lib/format.js';

const SEC = 1000;
const DAY = 86_400_000;
const flash = async (client, path) => /class="flash flash-(?:success|error|info)"[^>]*>([^<]*)</.exec((await client.get(path)).text)?.[1];

describe('watching, counting and reacting', () => {
  let app;
  let owner;
  let oc;
  let fan;
  let fc;
  let stranger;
  let sc;

  const addVideo = async (id, over = {}) => {
    const v = { title: `Video ${id}`, description: '', tags: '{}', status: 'ready', visibility: 'public', duration_ms: 120_000, owner: owner.id, comments: true, ...over };
    await app.ctx.db.query(
      `INSERT INTO videos (id, owner_id, title, description, tags, status, visibility, duration_ms, comments_enabled, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $10, $10)`,
      [id, v.owner, v.title, v.description, v.tags, v.status, v.visibility, v.duration_ms, v.comments, app.clock.now()],
    );
    return id;
  };
  const beat = (client, id, body, ua = 'Mozilla/5.0 test browser') => client.postJson(`/api/videos/${id}/heartbeat`, body, { headers: { 'user-agent': ua } });
  const stats = (id) => app.ctx.db.one('SELECT views, watch_ms, retention_n, retention_sum FROM videos WHERE id = $1', [id]);

  before(async () => {
    app = await startTestApp();
    oc = app.client();
    fc = app.client();
    sc = app.client();
    owner = await createMember(app, oc, { email: 'asha@example.com', handle: 'asha' });
    fan = await createMember(app, fc, { email: 'fan@example.com', handle: 'fanny' });
    stranger = await createMember(app, sc, { email: 'rohan@example.com', handle: 'rohan' });
  });
  after(() => app.close());

  describe('view counting cannot be inflated', () => {
    test('the first report of a viewing can claim only a few seconds, however much it asks for', async () => {
      const id = await addVideo('VIEWAAAAAA1');
      const r = await beat(fc, id, { position: 60_000, delta: 60_000 });
      assert.equal(r.status, 204);
      const s = await stats(id);
      assert.ok(s.watch_ms > 0 && s.watch_ms <= 12_000, `credited ${s.watch_ms}`);
      assert.equal(s.views, 0, 'a view needs real time');
    });

    test('a flood of reports at once adds almost nothing, because credit follows the clock, not the claim', async () => {
      const id = await addVideo('VIEWAAAAAA2');
      for (let i = 0; i < 40; i++) await beat(fc, id, { position: i * 30_000, delta: 30_000 });
      const s = await stats(id);
      assert.ok(s.watch_ms <= 12_000, `credited ${s.watch_ms}: forty claimed half-minutes are worth no more than the first few seconds`);
      assert.equal(s.views, 0);
    });

    test('genuine watching counts: a view after 30 real seconds, once per person per day', async () => {
      const id = await addVideo('VIEWAAAAAA3');
      for (let i = 0; i < 6; i++) {
        await beat(fc, id, { position: i * 10_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      let s = await stats(id);
      assert.equal(s.views, 1);
      assert.ok(s.watch_ms >= 30_000 && s.watch_ms <= 62_000, `credited ${s.watch_ms}`);
      for (let i = 0; i < 6; i++) {
        await beat(fc, id, { position: 60_000 + i * 10_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      s = await stats(id);
      assert.equal(s.views, 1, 'more watching by the same person is more watch time, not more views');
      assert.ok(s.watch_ms > 60_000);
      // a different person
      for (let i = 0; i < 4; i++) {
        await beat(sc, id, { position: i * 10_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      assert.equal((await stats(id)).views, 2);
    });

    test('reports cannot claim playback faster than twice real time', async () => {
      const id = await addVideo('VIEWAAAAAA4');
      await beat(fc, id, { position: 0, delta: 1000 });
      const before = (await stats(id)).watch_ms;
      app.clock.advance(10 * SEC);
      await beat(fc, id, { position: 30_000, delta: 30_000 });
      const gained = (await stats(id)).watch_ms - before;
      assert.ok(gained <= 10 * SEC * 2.5 + 1000, `gained ${gained} in 10 s`);
      assert.ok(gained >= 10 * SEC, 'but real watching, even at double speed, is believed');
    });

    test('nonsense in the report is harmless', async () => {
      const id = await addVideo('VIEWAAAAAA5');
      for (const body of [{}, { position: 'abc', delta: 'x' }, { position: -50, delta: -9999 }, { position: 1e99, delta: 1e99 }, { position: null, delta: null }, { position: [1], delta: { a: 1 } }, { position: Infinity, delta: NaN }]) {
        const r = await beat(fc, id, body);
        assert.equal(r.status, 204, JSON.stringify(body));
      }
      const s = await stats(id);
      assert.ok(s.watch_ms >= 0 && s.watch_ms <= 15_000);
      assert.equal((await app.ctx.db.one(`SELECT position_ms FROM watch_history WHERE user_id = $1 AND video_id = $2`, [fan.id, id])).position_ms <= 120_000, true, 'position is kept inside the video');
    });

    test('crawlers and the video’s own channel are never counted', async () => {
      const id = await addVideo('VIEWAAAAAA6');
      for (let i = 0; i < 5; i++) {
        await beat(oc, id, { position: i * 10_000, delta: 10_000 });
        await beat(app.client(), id, { position: i * 10_000, delta: 10_000 }, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
        app.clock.advance(10 * SEC);
      }
      const s = await stats(id);
      assert.deepEqual({ v: s.views, w: s.watch_ms }, { v: 0, w: 0 });
    });

    test('signed-out viewers are counted too (once per browser per day), and again on a new day', async () => {
      const id = await addVideo('VIEWAAAAAA7');
      const anon = app.client();
      for (let i = 0; i < 5; i++) {
        await beat(anon, id, { position: i * 10_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      assert.equal((await stats(id)).views, 1);
      app.clock.advance(DAY);
      for (let i = 0; i < 5; i++) {
        await beat(anon, id, { position: i * 10_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      assert.equal((await stats(id)).views, 2);
    });

    test('one person cannot loop a short video forever: credit stops at three full watches a day', async () => {
      const id = await addVideo('VIEWAAAAAA8', { duration_ms: 20_000 });
      for (let i = 0; i < 80; i++) {
        await beat(fc, id, { position: (i * 10_000) % 20_000, delta: 10_000 });
        app.clock.advance(10 * SEC);
      }
      const s = await stats(id);
      assert.equal(s.watch_ms, 60_000);
      assert.equal(s.views, 1);
    });

    test('a video you may not see cannot be reported on, and neither can one that does not exist', async () => {
      const id = await addVideo('VIEWAAAAAA9', { visibility: 'private' });
      assert.equal((await beat(fc, id, { position: 0, delta: 1000 })).status, 404);
      assert.equal((await beat(fc, 'NOPENOPENOP', { position: 0, delta: 1000 })).status, 404);
      assert.equal((await beat(fc, 'bad id!', { position: 0, delta: 1000 })).status, 400);
      assert.equal((await stats(id)).watch_ms, 0);
    });

    test('a signed-in viewer gets a resume point and a history entry, and can clear them', async () => {
      const id = await addVideo('VIEWAAAAAB1');
      await beat(fc, id, { position: 47_000, delta: 5000 });
      const page = await fc.get(`/watch/${id}`);
      assert.match(page.text, /data-resume="47"|"resume":\s*47|resume[^>]*47/);
      assert.ok((await fc.get('/history')).text.includes(`Video ${id}`));
      assert.ok(!(await sc.get('/history')).text.includes(`Video ${id}`), 'someone else’s history is theirs alone');
      await fc.post('/history/clear');
      assert.ok(!(await fc.get('/history')).text.includes(`Video ${id}`));
    });
  });

  describe('likes, subscriptions and watch later', () => {
    let vid;
    before(async () => {
      vid = await addVideo('LIKEAAAAAA1');
    });
    const vote = (c, value, id = vid) => c.post('/actions/vote', { video: id, value }, { headers: { 'x-requested-with': 'fetch' } });

    test('a signed-in person can like, change to dislike, and take it back; the counts always agree with the votes', async () => {
      const like = await vote(fc, '1');
      assert.deepEqual(like.json(), { likes: 1, dislikes: 0, mine: 1 });
      assert.equal((await vote(sc, '1')).json().likes, 2);
      assert.deepEqual((await vote(fc, '-1')).json(), { likes: 1, dislikes: 1, mine: -1 });
      assert.deepEqual((await vote(fc, '-1')).json(), { likes: 1, dislikes: 1, mine: -1 }, 'voting twice is the same as once');
      assert.deepEqual((await vote(fc, '0')).json(), { likes: 1, dislikes: 0, mine: 0 });
      const row = await app.ctx.db.one('SELECT likes, dislikes FROM videos WHERE id = $1', [vid]);
      assert.deepEqual({ l: row.likes, d: row.dislikes }, { l: 1, d: 0 });
    });

    test('signed-out visitors are asked to sign in; bad values, own videos and hidden videos are refused', async () => {
      const anon = app.client();
      assert.equal((await vote(anon, '1')).status, 401);
      const plain = await anon.post('/actions/vote', { video: vid, value: '1', next: `/watch/${vid}` });
      assert.equal(plain.status, 303);
      assert.match(plain.location, /^\/login\?next=/);
      assert.equal((await vote(fc, '7')).status, 400);
      assert.equal((await vote(fc, '1', 'bad id!')).status, 400);
      assert.equal((await vote(oc, '1')).status, 400, 'you cannot rate your own video');
      const hidden = await addVideo('LIKEAAAAAA2', { visibility: 'private' });
      assert.equal((await vote(fc, '1', hidden)).status, 404);
      assert.equal((await app.ctx.db.one('SELECT likes FROM videos WHERE id = $1', [hidden])).likes, 0);
    });

    test('subscribing, the bell, and unsubscribing', async () => {
      const sub = (c, on, extra = {}) => c.post('/actions/subscribe', { channel: owner.id, on, ...extra }, { headers: { 'x-requested-with': 'fetch' } });
      assert.deepEqual((await sub(fc, '1')).json(), { subscribed: true, notify: false, subscribers: 1, ...{} });
      assert.equal((await sub(fc, '1')).json().subscribers, 1, 'twice is still one');
      assert.equal((await sub(sc, '1')).json().subscribers, 2);
      assert.equal((await sub(oc, '1')).status, 400, 'not to yourself');
      assert.equal((await sub(fc, '1', { channel: 'not-a-uuid' })).status, 400);
      assert.equal((await sub(fc, '1', { channel: '00000000-0000-4000-8000-000000000000' })).status, 404);
      const bell = (c, on) => c.post('/actions/notify', { channel: owner.id, on }, { headers: { 'x-requested-with': 'fetch' } });
      assert.equal((await bell(app.client(), '1')).status, 401);
      assert.equal((await bell(fc, '1')).json().notify, true);
      assert.equal((await sub(sc, '0')).json().subscribers, 1);
      assert.equal((await bell(sc, '1')).status, 400, 'no bell without a subscription');
      assert.ok((await fc.get('/subscriptions')).text.includes('Video LIKEAAAAAA1'), 'the feed shows the channel’s videos');
      assert.ok(!(await sc.get('/subscriptions')).text.includes('Video LIKEAAAAAA1'), 'and only to those who subscribe');
    });

    test('only subscribers who switched the bell on hear about a newly published video, once', async () => {
      const draft = await addVideo('LIKEAAAAAA3', { status: 'ready', visibility: 'private' });
      await app.ctx.db.query(`UPDATE videos SET published_at = NULL WHERE id = $1`, [draft]);
      await sc.post('/actions/subscribe', { channel: owner.id, on: '1' }, { headers: { 'x-requested-with': 'fetch' } });
      const count = async (who) => (await app.ctx.db.one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'new_video' AND data->>'videoId' = $2`, [who.id, draft])).n;
      await app.ctx.db.query(`UPDATE videos SET visibility = 'public' WHERE id = $1`, [draft]);
      await app.ctx.videos.publishIfNeeded(draft);
      await app.ctx.videos.publishIfNeeded(draft);
      assert.deepEqual([await count(fan), await count(stranger)], [1, 0]);
      assert.match((await fc.get('/notifications')).text, /LIKEAAAAAA3|Video LIKEAAAAAA3/);
      assert.ok(!(await sc.get('/notifications')).text.includes('Video LIKEAAAAAA3'));
    });

    test('Watch later is private to each person', async () => {
      const save = (c, on, id = vid) => c.post('/actions/save', { video: id, on }, { headers: { 'x-requested-with': 'fetch' } });
      assert.equal((await save(fc, '1')).json().saved, true);
      assert.ok((await fc.get('/watch-later')).text.includes('Video LIKEAAAAAA1'));
      assert.ok(!(await sc.get('/watch-later')).text.includes('Video LIKEAAAAAA1'));
      assert.equal((await save(fc, '0')).json().saved, false);
      assert.ok(!(await fc.get('/watch-later')).text.includes('Video LIKEAAAAAA1'));
      assert.equal((await save(fc, '1', 'NOPENOPENOP')).status, 404);
      assert.equal((await save(app.client(), '1')).status, 401);
    });

    test('autoplay is a setting that is remembered, and the daily limit is validated', async () => {
      assert.equal((await fc.postJson('/api/preferences/autoplay', { on: false })).json().autoplay, false);
      assert.equal((await app.ctx.db.one('SELECT autoplay FROM users WHERE id = $1', [fan.id])).autoplay, false);
      assert.equal((await fc.post('/settings/preferences', { daily_limit: '5' })).status, 422);
      assert.equal((await fc.post('/settings/preferences', { daily_limit: 'lots' })).status, 422);
      assert.equal((await fc.post('/settings/preferences', { daily_limit: '45', autoplay: '1' })).status, 303);
      const u = await app.ctx.db.one('SELECT autoplay, daily_limit_minutes FROM users WHERE id = $1', [fan.id]);
      assert.deepEqual({ a: u.autoplay, d: u.daily_limit_minutes }, { a: true, d: 45 });
      await fc.post('/settings/preferences', { daily_limit: '' });
      assert.equal((await app.ctx.db.one('SELECT daily_limit_minutes FROM users WHERE id = $1', [fan.id])).daily_limit_minutes, null);
    });
  });

  describe('comments', () => {
    let vid;
    before(async () => {
      vid = await addVideo('COMMAAAAAA1');
    });
    const say = (c, body, extra = {}, id = vid) => c.post(`/videos/${id}/comments`, { body, ...extra });

    test('a confirmed member can comment; the text is shown as text, not as markup', async () => {
      const r = await say(fc, 'Great video <script>alert(1)</script> & <b>bold</b>');
      assert.equal(r.status, 303);
      const page = (await app.client().get(`/watch/${vid}`)).text;
      assert.ok(page.includes('Great video &lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;'));
      assert.ok(!page.includes('<script>alert(1)'));
      assert.equal((await app.ctx.db.one('SELECT comment_count FROM videos WHERE id = $1', [vid])).comment_count, 1);
      assert.equal((await app.ctx.db.one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'comment'`, [owner.id])).n, 1, 'the owner is told');
    });

    test('empty, too long, duplicate and link-stuffed comments are refused with a reason', async () => {
      const cases = [
        ['   ', /Write a comment|required/],
        ['x'.repeat(1001), /at most 1000/],
        ['Great video <script>alert(1)</script> & <b>bold</b>', /already posted/],
        ['see http://a.example/1 http://b.example/2 http://c.example/3', /at most two links/],
      ];
      for (const [body, expected] of cases) {
        const r = await say(fc, body);
        assert.equal(r.status, 303, body.slice(0, 20));
        assert.match(await flash(fc, `/watch/${vid}`), expected);
      }
      assert.equal((await app.ctx.db.one('SELECT comment_count FROM videos WHERE id = $1', [vid])).comment_count, 1);
    });

    test('signed-out visitors and unconfirmed accounts cannot comment', async () => {
      const signedOut = await say(app.client(), 'hello there');
      assert.equal(signedOut.status, 303);
      assert.match(signedOut.location, /^\/login/);
      const raw = app.client();
      await createMember(app, raw, { email: 'raw@example.com', handle: 'rawuser', verify: false, signIn: false });
      await app.ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE handle = 'rawuser'`);
      await raw.post('/login', { email: 'raw@example.com', password: PASSWORD });
      await app.ctx.db.query(`UPDATE users SET email_verified_at = NULL WHERE handle = 'rawuser'`);
      assert.ok([401, 403].includes((await say(raw, 'hello there')).status));
    });

    test('replies go one level deep, notify the person replied to, and cannot cross videos', async () => {
      const top = (await app.ctx.db.one(`SELECT id FROM comments WHERE video_id = $1 AND parent_id IS NULL`, [vid])).id;
      await say(sc, 'Thanks for the tip', { parent_id: String(top) });
      const reply = await app.ctx.db.one(`SELECT id, parent_id FROM comments WHERE body = 'Thanks for the tip'`);
      assert.equal(String(reply.parent_id), String(top));
      assert.equal((await app.ctx.db.one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'reply'`, [fan.id])).n, 1);
      await say(sc, 'A reply to a reply', { parent_id: String(reply.id) });
      assert.match(await flash(sc, `/watch/${vid}`), /could not find the comment/);
      const other = await addVideo('COMMAAAAAA2');
      await say(sc, 'Wrong video', { parent_id: String(top) }, other);
      assert.match(await flash(sc, `/watch/${other}`), /could not find the comment/);
    });

    test('comments can be turned off for a video', async () => {
      const closed = await addVideo('COMMAAAAAA3', { comments: false });
      await say(fc, 'Anybody there?', {}, closed);
      assert.match(await flash(fc, `/watch/${closed}`), /turned off/);
      assert.equal((await app.ctx.db.query('SELECT 1 FROM comments WHERE video_id = $1', [closed])).rows.length, 0);
    });

    test('the author and the channel owner can delete a comment, a stranger cannot, and replies go with it', async () => {
      const top = (await app.ctx.db.one(`SELECT id FROM comments WHERE video_id = $1 AND parent_id IS NULL`, [vid])).id;
      const del = (c, id) => c.post(`/comments/${id}/delete`);
      await del(sc, top);
      assert.equal((await app.ctx.db.one('SELECT status FROM comments WHERE id = $1', [top])).status, 'visible', 'a stranger cannot');
      await del(fc, top);
      const rows = (await app.ctx.db.query('SELECT status FROM comments WHERE video_id = $1', [vid])).rows;
      assert.ok(rows.every((r) => r.status === 'removed'), 'the comment and its replies are gone');
      assert.equal((await app.ctx.db.one('SELECT comment_count FROM videos WHERE id = $1', [vid])).comment_count, 0);
      await say(sc, 'Owner will remove this');
      const mine = (await app.ctx.db.one(`SELECT id FROM comments WHERE body = 'Owner will remove this'`)).id;
      await del(oc, mine);
      assert.equal((await app.ctx.db.one('SELECT status FROM comments WHERE id = $1', [mine])).status, 'removed');
      assert.equal((await del(fc, 'abc')).status, 404);
    });
  });

  describe('reports', () => {
    test('anyone signed in can report a video, a comment or a person; the same report twice is one report', async () => {
      const vid = await addVideo('REPOAAAAAA1');
      await fc.post(`/videos/${vid}/comments`, { body: 'Offensive words here' });
      const comment = (await app.ctx.db.one(`SELECT id FROM comments WHERE body = 'Offensive words here'`)).id;
      for (const [type, id] of [['video', vid], ['comment', String(comment)], ['user', fan.id]]) {
        const form = await sc.get(`/report?type=${type}&id=${id}`);
        assert.equal(form.status, 200, type);
        const r = await sc.post('/report', { type, id, reason: 'harassment', details: 'because <b>reasons</b>' });
        assert.equal(r.status, 303, type);
        await sc.post('/report', { type, id, reason: 'spam' });
      }
      assert.equal((await app.ctx.db.query(`SELECT 1 FROM reports WHERE reporter_id = $1 AND status = 'open'`, [stranger.id])).rows.length, 3);
      assert.equal((await app.ctx.db.one(`SELECT ad_status FROM videos WHERE id = $1`, [vid])).ad_status, 'limited', 'no ads next to a reported video until a moderator looks');
    });

    test('bad reasons, unknown targets, hidden videos and self-reports are refused', async () => {
      const vid = await addVideo('REPOAAAAAA2', { visibility: 'private' });
      assert.equal((await sc.get(`/report?type=video&id=${vid}`)).status, 404, 'a private video cannot even be reported by a stranger');
      const pub = await addVideo('REPOAAAAAA3');
      assert.equal((await sc.post('/report', { type: 'video', id: pub, reason: 'bogus' })).status, 400);
      assert.equal((await sc.post('/report', { type: 'planet', id: pub, reason: 'spam' })).status, 404);
      assert.equal((await sc.post('/report', { type: 'user', id: stranger.id, reason: 'spam' })).status, 400, 'not yourself');
      assert.equal((await app.client().get(`/report?type=video&id=${pub}`)).status, 303, 'sign in first');
    });
  });

  describe('search', () => {
    before(async () => {
      await addVideo('SEARAAAAAA1', { title: 'Perfect dal tadka in ten minutes', tags: '{dal,cooking}', description: 'Toor dal and ghee.' });
      await addVideo('SEARAAAAAA2', { title: 'Pressure cooker basics', tags: '{cooking,beginners}', description: 'How to dal safely.' });
      await addVideo('SEARAAAAAA3', { title: 'दाल तड़का बनाने की विधि', tags: '{दाल,रसोई}', description: 'मराठी आणि हिंदी: साधी कृती' });
      await addVideo('SEARAAAAAA4', { title: 'Secret dal recipe', visibility: 'private', tags: '{dal}' });
      await addVideo('SEARAAAAAA5', { title: '100% juice & 50_50 split', tags: '{math}' });
    });
    const found = async (q, extra = '') => {
      const page = (await app.client().get(`/results?q=${encodeURIComponent(q)}${extra}`)).text;
      return ['SEARAAAAAA1', 'SEARAAAAAA2', 'SEARAAAAAA3', 'SEARAAAAAA4', 'SEARAAAAAA5'].filter((id) => page.includes(`/watch/${id}`));
    };

    test('every word must match, from the start of a word, in the title, tags or description', async () => {
      assert.deepEqual(await found('dal'), ['SEARAAAAAA1', 'SEARAAAAAA2']);
      assert.deepEqual(await found('dal tadka'), ['SEARAAAAAA1']);
      assert.deepEqual(await found('press'), ['SEARAAAAAA2'], 'a prefix is enough');
      assert.deepEqual(await found('ghee'), ['SEARAAAAAA1'], 'the description is searched');
      assert.deepEqual(await found('beginners'), ['SEARAAAAAA2'], 'and the tags');
      assert.deepEqual(await found('DAL TADKA'), ['SEARAAAAAA1'], 'capitals do not matter');
    });

    test('private videos never appear', async () => {
      assert.ok(!(await found('secret')).includes('SEARAAAAAA4'));
      assert.ok(!(await found('dal')).includes('SEARAAAAAA4'));
    });

    test('Hindi and Marathi text is found, by title, tag or description', async () => {
      assert.deepEqual(await found('दाल'), ['SEARAAAAAA3']);
      assert.deepEqual(await found('तड़का'), ['SEARAAAAAA3']);
      assert.deepEqual(await found('रसोई'), ['SEARAAAAAA3']);
      assert.deepEqual(await found('मराठी'), ['SEARAAAAAA3']);
      assert.deepEqual(await found('कृती'), ['SEARAAAAAA3']);
    });

    test('symbols that mean something to a database are just characters', async () => {
      for (const q of ['%', '_', '100%', '50_50', "'; DROP TABLE videos; --", '" OR 1=1', '\\', 'a & b | !c', ':*', '(((', '<script>', '́', '😀😀', 'a'.repeat(500), '..', '& &:*']) {
        const r = await app.client().get(`/results?q=${encodeURIComponent(q)}`);
        assert.equal(r.status, 200, `q=${q.slice(0, 20)}`);
      }
      assert.deepEqual(await found('100%'), ['SEARAAAAAA5']);
      assert.deepEqual(await found('50_50'), ['SEARAAAAAA5']);
      assert.ok((await app.ctx.db.one('SELECT count(*)::int AS n FROM videos')).n > 5, 'the table is still there');
      const shown = (await app.client().get(`/results?q=${encodeURIComponent('"><script>x</script>')}`)).text;
      assert.ok(!shown.includes('<script>x</script>'));
    });

    test('an empty search shows an empty page, the suggest box answers JSON, and sorting works', async () => {
      assert.equal((await app.client().get('/results?q=')).status, 200);
      assert.equal((await app.client().get('/results')).status, 200);
      const sug = await app.client().get('/api/suggest?q=dal');
      assert.equal(sug.status, 200);
      assert.ok(sug.json().items.some((i) => i.kind === 'video' && i.href === '/watch/SEARAAAAAA1'));
      assert.ok(!sug.json().items.some((i) => i.href.includes('SEARAAAAAA4')));
      assert.equal((await app.client().get('/api/suggest?q=d')).json().items.length, 0, 'one letter is too little to suggest from');
      await app.ctx.db.query(`UPDATE videos SET views = 500 WHERE id = 'SEARAAAAAA2'`);
      const byViews = (await app.client().get('/results?q=dal&sort=views')).text;
      assert.ok(byViews.indexOf('SEARAAAAAA2') < byViews.indexOf('SEARAAAAAA1'));
      assert.equal((await app.client().get('/results?q=dal&sort=bogus')).status, 200);
    });

    test('a channel is found by name or handle', async () => {
      assert.match((await app.client().get('/results?q=asha')).text, /@asha/);
      assert.match((await app.client().get('/results?q=ash')).text, /@asha/);
    });
  });
  describe('time watched and the daily reminder', () => {
    // Writes this member's watching for the last few days straight into the table the counter fills: {0: 45} is 45 minutes today.
    const setWatch = async (userId, minutesByDaysAgo) => {
      await app.ctx.db.query('DELETE FROM user_watch_days WHERE user_id = $1', [userId]);
      for (const [ago, minutes] of Object.entries(minutesByDaysAgo)) {
        const day = dayString(new Date(app.clock.now().getTime() - Number(ago) * DAY));
        await app.ctx.db.query('INSERT INTO user_watch_days (user_id, day, watch_ms) VALUES ($1, $2, $3)', [userId, day, minutes * 60_000]);
      }
    };

    test('the history page shows time watched today and the daily average, to that member only', async () => {
      await setWatch(fan.id, { 0: 45, 1: 15 });
      await setWatch(stranger.id, {});
      const mine = (await fc.get('/history')).text;
      assert.match(mine, /Time watched/);
      assert.match(mine, /45 minutes/, 'today');
      assert.match(mine, /9 minutes/, 'the average over seven days: (45 + 15) / 7 is about 9');
      assert.match(mine, /60 in total/, 'the chart says so for people who cannot see it');
      const theirs = (await sc.get('/history')).text;
      assert.match(theirs, /0 minutes/);
      assert.ok(!theirs.includes('45 minutes') && !theirs.includes('60 in total'), 'nobody else sees my time');
      const signedOut = await app.client().get('/history');
      assert.notEqual(signedOut.status, 200);
      assert.ok(!signedOut.text.includes('Time watched'));
    });

    test('the daily reminder appears once the limit the member chose is reached, for that member only, and never blocks anything', async () => {
      const reminder = 'You set a reminder at';
      await app.ctx.db.query('UPDATE users SET daily_limit_minutes = 30 WHERE id = $1', [fan.id]);
      await setWatch(fan.id, { 0: 29 });
      assert.ok(!(await fc.get('/')).text.includes(reminder), 'below the limit: nothing');
      await setWatch(fan.id, { 0: 30 });
      assert.match((await fc.get('/')).text, /You set a reminder at 30 minutes a day, and you have watched 30 minutes today\. Time for a break\?/, 'at the limit');
      await setWatch(fan.id, { 0: 31, 1: 500 });
      const over = await fc.get('/');
      assert.equal(over.status, 200, 'a reminder, not a lock-out');
      assert.match(over.text, /watched 31 minutes today/, 'only today counts');
      assert.equal((await fc.get('/trending')).status, 200);
      // Someone who set no limit is never nagged, however much they watch; neither is a signed-out visitor.
      await app.ctx.db.query('UPDATE users SET daily_limit_minutes = NULL WHERE id = $1', [stranger.id]);
      await setWatch(stranger.id, { 0: 600 });
      assert.ok(!(await sc.get('/')).text.includes(reminder));
      assert.ok(!(await app.client().get('/')).text.includes(reminder));
      // Turning the reminder off in Settings takes it away at once.
      assert.equal((await fc.post('/settings/preferences', { daily_limit: '', autoplay: '1' })).status, 303);
      assert.ok(!(await fc.get('/')).text.includes(reminder));
    });
  });
});
