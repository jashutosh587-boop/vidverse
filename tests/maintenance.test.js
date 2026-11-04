import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/app.js';
import { createMember } from './helpers/users.js';

/**
 * The hourly housekeeping job, and the other rules that compare a stored time with "now". All of them read the time from
 * the application's clock, so these tests move that clock by hand. They also guard a mistake that is easy to make and
 * hard to see: stamping a row with the database's own now() and then comparing it with the application's clock. The
 * two agree in production and can disagree anywhere else, which once made a test pass in the morning and fail after lunch.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DRAFT = { title: 'Draft', description: '', tags: [], category: 'food', visibility: 'public', comments_enabled: true, has_paid_promotion: false };

describe('housekeeping, and the rules that compare stored times with now', () => {
  let app;
  let n = 0;
  before(async () => {
    app = await startTestApp();
    app.ctx.jobs.register('noop', async () => {}); // rows inserted by hand below use this kind
  });
  after(async () => {
    await app.close();
  });

  const db = () => app.ctx.db;
  const count = async (sql, params = []) => (await db().one(sql, params)).n;
  const ago = (ms) => new Date(app.clock.now().getTime() - ms);
  /** A confirmed member who is signed in. */
  async function member(tag) {
    n += 1;
    return createMember(app, app.client(), { email: `${tag}${n}@example.com`, handle: `${tag}${n}` });
  }
  /** Queues the housekeeping job and runs the queue, as the worker would. */
  async function housekeeping() {
    await app.ctx.jobs.enqueue('maintenance', {});
    await app.ctx.jobs.drain();
  }

  test('new videos, subscriptions and notifications carry the application clock, not the database clock', async () => {
    const owner = await member('stamp');
    const fan = await member('stampfan');
    app.clock.advance(3 * DAY); // far from real time on purpose
    const video = await app.ctx.videos.createDraft(owner.id, DRAFT);
    await app.ctx.engagement.subscribe(fan.id, owner.id);
    await app.ctx.notifications.create(owner.id, 'comment', { title: 'hello' });
    const now = app.clock.now().getTime();
    assert.equal(new Date(video.created_at).getTime(), now, 'video created_at');
    assert.equal(new Date(video.updated_at).getTime(), now, 'video updated_at');
    const sub = await db().one('SELECT created_at FROM subscriptions WHERE subscriber_id = $1 AND channel_id = $2', [fan.id, owner.id]);
    assert.equal(new Date(sub.created_at).getTime(), now, 'subscription created_at');
    const note = await db().one('SELECT created_at FROM notifications WHERE user_id = $1 AND kind = $2', [owner.id, 'comment']);
    assert.equal(new Date(note.created_at).getTime(), now, 'notification created_at');
  });

  test('housekeeping is queued once an hour, however many workers ask for it', async () => {
    const queued = () => count(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'maintenance'`);
    app.clock.advance(HOUR); // a fresh hour: starting the app may already have queued the first one
    const before = await queued();
    await app.ctx.maintenance.schedule();
    await app.ctx.maintenance.schedule();
    assert.equal(await queued(), before + 1);
    app.clock.advance(HOUR);
    await app.ctx.maintenance.schedule();
    assert.equal(await queued(), before + 2);
  });

  test('notifications are kept for 90 days, then removed', async () => {
    const u = await member('note');
    await app.ctx.notifications.create(u.id, 'comment', { title: 'old' });
    app.clock.advance(60 * DAY);
    await app.ctx.notifications.create(u.id, 'comment', { title: 'newer' });
    app.clock.advance(29 * DAY); // the first is 89 days old
    await housekeeping();
    assert.equal(await count('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [u.id]), 2);
    app.clock.advance(2 * DAY); // 91 days and 31 days old
    await housekeeping();
    const left = (await db().query('SELECT data FROM notifications WHERE user_id = $1', [u.id])).rows;
    assert.deepEqual(
      left.map((r) => r.data.title),
      ['newer'],
    );
  });

  test('an upload left unfinished for a day is deleted, and a newer one is not', async () => {
    const u = await member('draft');
    const old = await app.ctx.videos.createDraft(u.id, DRAFT);
    app.clock.advance(23 * HOUR);
    const recent = await app.ctx.videos.createDraft(u.id, DRAFT);
    app.clock.advance(2 * HOUR); // 25 hours and 2 hours old
    await housekeeping();
    assert.ok(!(await app.ctx.videos.get(old.id)), 'the abandoned upload is gone');
    assert.ok(await app.ctx.videos.get(recent.id), 'the recent one is not');
  });

  test('a video removed by staff is erased for good after 30 days, not before', async () => {
    const u = await member('gone');
    const v = await app.ctx.videos.createDraft(u.id, DRAFT);
    await db().query(`UPDATE videos SET status = 'ready' WHERE id = $1`, [v.id]);
    assert.equal(await app.ctx.videos.removeByStaff(v.id, u.id, 'test'), true);
    app.clock.advance(29 * DAY);
    await housekeeping();
    assert.ok(await app.ctx.videos.get(v.id), 'still there after 29 days, so a mistake can be undone');
    app.clock.advance(2 * DAY);
    await housekeeping();
    assert.ok(!(await app.ctx.videos.get(v.id)), 'gone after 31 days');
  });

  test('email confirmation and password-reset links are cleared a week after they expire', async () => {
    n += 1;
    const email = `link${n}@example.com`;
    await createMember(app, app.client(), { email, handle: `link${n}`, verify: false, signIn: false });
    const links = () => count(`SELECT count(*)::int AS n FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE lower(u.email) = $1`, [email]);
    const { expires_at: expires } = await db().one(`SELECT t.expires_at FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE lower(u.email) = $1`, [email]);
    app.clock.advance(new Date(expires).getTime() - app.clock.now().getTime() + 6 * DAY);
    await housekeeping();
    assert.equal(await links(), 1, 'six days after expiry it is still there');
    app.clock.advance(2 * DAY);
    await housekeeping();
    assert.equal(await links(), 0, 'eight days after expiry it is gone');
  });

  test('sessions end after 14 idle days, and housekeeping clears them away', async () => {
    const idle = await member('idle');
    app.clock.advance(13 * DAY);
    const busy = await member('busy');
    app.clock.advance(2 * DAY); // the first has been idle for 15 days, the second for 2
    await housekeeping();
    const sessions = (id) => count('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [id]);
    assert.equal(await sessions(idle.id), 0);
    assert.ok((await sessions(busy.id)) >= 1);
  });

  test('daily counters are kept for 400 days', async () => {
    const u = await member('days');
    const v = await app.ctx.videos.createDraft(u.id, DRAFT);
    const day = (days) => ago(days * DAY).toISOString().slice(0, 10);
    for (const days of [401, 399]) {
      await db().query('INSERT INTO user_watch_days (user_id, day, watch_ms) VALUES ($1, $2, 60000)', [u.id, day(days)]);
      await db().query(
        `INSERT INTO video_view_days (video_id, day, viewer_hash, watch_ms, qualified, counted, last_beat_at) VALUES ($1, $2, $3, 60000, true, true, $4)`,
        [v.id, day(days), `hash${days}`, app.clock.now()],
      );
    }
    await housekeeping();
    const mine = (await db().query('SELECT day::text AS day FROM user_watch_days WHERE user_id = $1', [u.id])).rows.map((r) => r.day);
    const views = (await db().query('SELECT day::text AS day FROM video_view_days WHERE video_id = $1', [v.id])).rows.map((r) => r.day);
    assert.deepEqual(mine, [day(399)]);
    assert.deepEqual(views, [day(399)]);
  });

  test('finished jobs are kept for two weeks', async () => {
    for (const [key, days] of [['finished-old', 15], ['finished-recent', 13]]) {
      await db().query(`INSERT INTO jobs (kind, payload, status, run_after, finished_at, dedupe_key) VALUES ('noop', '{}', 'done', $1, $1, $2)`, [ago(days * DAY), key]);
    }
    await housekeeping();
    const left = (await db().query(`SELECT dedupe_key FROM jobs WHERE dedupe_key LIKE 'finished-%'`)).rows.map((r) => r.dedupe_key);
    assert.deepEqual(left, ['finished-recent']);
  });

  test('a job whose worker died is put back in the queue after 30 minutes, and one that is still working is left alone', async () => {
    await db().query(
      `INSERT INTO jobs (kind, payload, status, locked_at, locked_by, dedupe_key) VALUES ('noop', '{}', 'running', $1, 'dead', 'stuck'), ('noop', '{}', 'running', $2, 'busy', 'working')`,
      [ago(31 * MIN), ago(5 * MIN)],
    );
    assert.equal(await app.ctx.jobs.recoverStuck(), 1);
    const status = async (key) => (await db().one('SELECT status FROM jobs WHERE dedupe_key = $1', [key])).status;
    assert.equal(await status('stuck'), 'queued');
    assert.equal(await status('working'), 'running');
  });

  test('the channel overview counts new subscribers over the last 28 days by the application clock', async () => {
    const owner = await member('chan');
    const fan = await member('fan');
    await app.ctx.engagement.subscribe(fan.id, owner.id);
    app.clock.advance(10 * DAY);
    let overview = await app.ctx.analytics.channelOverview(owner.id);
    assert.deepEqual([overview.subscribers, overview.subscribersGained], [1, 1]);
    app.clock.advance(19 * DAY); // 29 days after
    overview = await app.ctx.analytics.channelOverview(owner.id);
    assert.deepEqual([overview.subscribers, overview.subscribersGained], [1, 0]);
  });
});
