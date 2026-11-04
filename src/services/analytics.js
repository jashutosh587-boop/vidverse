import { deriveKey, hmacB64u } from '../lib/crypto.js';
import { dayString } from '../lib/format.js';

const FIRST_BEAT_MAX_MS = 12_000; // the first report of a viewing can claim at most this much
const BEAT_CAP_MS = 30_000; // no single report can claim more
const RATE_SLACK = 2.5; // media time can run up to 2x faster than the clock (playback speed), plus margin
const COUNT_AFTER_MS = 3_000; // a viewing counts towards "average watched" after this long
const QUALIFIED_MS = 30_000; // a view counts after 30 seconds, or half of a shorter video
const MAX_REWATCH = 3; // at most three full watches per viewer per day count

const BOT_RE = /(googlebot|bingbot|duckduckbot|baiduspider|yandex|slurp|facebookexternalhit|twitterbot|linkedinbot|semrush|ahrefs|petalbot|bytespider|gptbot|claudebot|ccbot|crawler|spider)/i;

export function createAnalyticsService(ctx) {
  const { db, config, clock } = ctx;

  /** A keyed hash that changes every day: enough to count unique viewers, not enough to follow anyone across days. */
  function viewerHash({ day, userId, ip, userAgent }) {
    const key = deriveKey(config.sessionSecret, `viewer:${day}`);
    return hmacB64u(key, userId ? `u:${userId}` : `a:${ip}|${userAgent ?? ''}`).slice(0, 22);
  }

  const api = {
    viewerHash,
    isBot: (ua) => BOT_RE.test(ua ?? ''),

    /**
     * Records playback progress. `deltaMs` is how much the client says it played since its last report; the server
     * distrusts it: the credit is limited by the real time since the previous report, by a per-report cap, and by
     * a per-day cap per viewer. The video's owner and crawlers are never counted.
     */
    async recordHeartbeat({ video, userId = null, ip, userAgent, positionMs = 0, deltaMs = 0 }) {
      if (!video.duration_ms || video.status !== 'ready') return { ignored: 'not_ready' };
      if (userId && userId === video.owner_id) return { ignored: 'owner' };
      if (api.isBot(userAgent)) return { ignored: 'bot' };
      const now = clock();
      const day = dayString(now);
      const hash = viewerHash({ day, userId, ip, userAgent });
      const duration = video.duration_ms;
      const position = Math.max(0, Math.min(duration, Math.round(positionMs)));

      return db.tx(async () => {
        // Reports from one viewer take turns. The row lock below protects nothing on a viewer's first report, because
        // there is no row to lock yet: a burst of first reports would each read "nothing credited so far" and each be
        // credited in full. (Found by tests/concurrency.test.js on a real Postgres server: 8 at once became 8x.)
        // The lock is per viewer, per video, per day, so different viewers never wait for each other.
        if (db.kind === 'pg') await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`beat:${video.id}:${day}:${hash}`]);
        const row = await db.one('SELECT * FROM video_view_days WHERE video_id = $1 AND day = $2 AND viewer_hash = $3 FOR UPDATE', [video.id, day, hash]);
        const elapsed = row ? now.getTime() - new Date(row.last_beat_at).getTime() : null;
        const prev = row?.watch_ms ?? 0;
        // Two limits. Per report: only what the time since the previous report allows. Overall: only what the time
        // since the first report allows, so a flood of quick reports cannot add up to more than really elapsed.
        const perReport = row ? Math.min(BEAT_CAP_MS, Math.max(0, elapsed) * RATE_SLACK + 1000) : FIRST_BEAT_MAX_MS;
        const budget = FIRST_BEAT_MAX_MS + Math.max(0, now.getTime() - new Date(row?.first_beat_at ?? now).getTime()) * RATE_SLACK;
        const allowed = Math.max(0, Math.min(perReport, budget - prev));
        const next = Math.min(prev + Math.max(0, Math.min(Math.round(deltaMs) || 0, allowed)), duration * MAX_REWATCH);
        const delta = next - prev;

        const qualifiedNow = row?.qualified || next >= Math.min(QUALIFIED_MS, duration * 0.5);
        const countedNow = row?.counted || next >= COUNT_AFTER_MS;
        const newlyQualified = qualifiedNow && !row?.qualified;
        const newlyCounted = countedNow && !row?.counted;
        const f0 = Math.min(prev, duration) / duration;
        const f1 = Math.min(next, duration) / duration;
        const retentionDelta = newlyCounted ? f1 : row?.counted ? f1 - f0 : 0;

        await db.query(
          `INSERT INTO video_view_days (video_id, day, viewer_hash, watch_ms, qualified, counted, last_beat_at, first_beat_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (video_id, day, viewer_hash) DO UPDATE SET watch_ms = $4, qualified = $5, counted = $6, last_beat_at = $7`,
          [video.id, day, hash, next, qualifiedNow, countedNow, now],
        );
        if (delta > 0 || newlyQualified || newlyCounted) {
          await db.query(
            `UPDATE videos SET watch_ms = watch_ms + $2, views = views + $3, retention_sum = retention_sum + $4, retention_n = retention_n + $5 WHERE id = $1`,
            [video.id, delta, newlyQualified ? 1 : 0, retentionDelta, newlyCounted ? 1 : 0],
          );
        }
        if (userId) {
          if (delta > 0) {
            await db.query(
              `INSERT INTO user_watch_days (user_id, day, watch_ms) VALUES ($1, $2, $3) ON CONFLICT (user_id, day) DO UPDATE SET watch_ms = user_watch_days.watch_ms + $3`,
              [userId, day, delta],
            );
          }
          await db.query(
            `INSERT INTO watch_history (user_id, video_id, position_ms, watched_ms, completed, last_watched_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, video_id) DO UPDATE SET position_ms = $3, watched_ms = watch_history.watched_ms + $4,
               completed = watch_history.completed OR $5, last_watched_at = $6`,
            [userId, video.id, position, delta, position >= duration * 0.95, now],
          );
        }
        if (newlyQualified && video.views + 1 > 0) await api.milestone(video, video.views + 1);
        return { credited: delta, qualified: qualifiedNow };
      });
    },

    /** A short note to the creator when a video passes 100, 1,000, 10,000 ... views. */
    async milestone(video, views) {
      if (![100, 1000, 10_000, 100_000, 1_000_000].includes(views)) return;
      await ctx.notifications.create(video.owner_id, 'milestone', { videoId: video.id, title: video.title, views });
    },

    async todayWatchMs(userId) {
      const r = await db.one('SELECT watch_ms FROM user_watch_days WHERE user_id = $1 AND day = $2', [userId, dayString(clock())]);
      return r?.watch_ms ?? 0;
    },

    /** The last `days` days of a member's own watching, oldest first, with empty days filled in. */
    async watchTimeByDay(userId, days = 7) {
      const end = clock();
      const start = new Date(end.getTime() - (days - 1) * 86400_000);
      const { rows } = await db.query('SELECT day, watch_ms FROM user_watch_days WHERE user_id = $1 AND day >= $2::date', [userId, dayString(start)]);
      const byDay = new Map(rows.map((r) => [r.day, r.watch_ms]));
      return Array.from({ length: days }, (_, i) => {
        const d = dayString(new Date(start.getTime() + i * 86400_000));
        return { day: d, watchMs: byDay.get(d) ?? 0 };
      });
    },

    /** Totals and a daily series for one channel over the last `days` days. */
    async channelOverview(ownerId, days = 28) {
      const end = clock();
      const start = new Date(end.getTime() - (days - 1) * 86400_000);
      const since = dayString(start);
      const { rows } = await db.query(
        `SELECT d.day, count(*) FILTER (WHERE d.qualified)::int AS views, COALESCE(sum(d.watch_ms), 0)::bigint AS watch_ms, count(*)::int AS viewers
           FROM video_view_days d JOIN videos v ON v.id = d.video_id WHERE v.owner_id = $1 AND d.day >= $2::date GROUP BY d.day`,
        [ownerId, since],
      );
      const byDay = new Map(rows.map((r) => [r.day, r]));
      const daily = Array.from({ length: days }, (_, i) => {
        const day = dayString(new Date(start.getTime() + i * 86400_000));
        const r = byDay.get(day);
        return { day, views: r?.views ?? 0, watchMs: r?.watch_ms ?? 0 };
      });
      const subs = await db.one(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= $2)::int AS gained FROM subscriptions WHERE channel_id = $1`,
        [ownerId, start],
      );
      const top = await db.query(
        `SELECT v.id, v.title, v.updated_at, v.status, v.duration_ms, v.views, v.likes, v.comment_count,
                CASE WHEN v.retention_n > 0 THEN v.retention_sum / v.retention_n ELSE NULL END AS avg_viewed,
                COALESCE((SELECT count(*) FROM video_view_days d WHERE d.video_id = v.id AND d.qualified AND d.day >= $2::date), 0)::int AS recent_views
           FROM videos v WHERE v.owner_id = $1 AND v.status = 'ready' ORDER BY recent_views DESC, v.views DESC LIMIT 5`,
        [ownerId, since],
      );
      return {
        days,
        daily,
        views: daily.reduce((s, d) => s + d.views, 0),
        watchMs: daily.reduce((s, d) => s + Number(d.watchMs), 0),
        subscribers: subs.total,
        subscribersGained: subs.gained,
        top: top.rows,
      };
    },

    async videoStats(videoId, days = 28) {
      const end = clock();
      const start = new Date(end.getTime() - (days - 1) * 86400_000);
      const { rows } = await db.query(
        `SELECT day, count(*) FILTER (WHERE qualified)::int AS views, COALESCE(sum(watch_ms), 0)::bigint AS watch_ms FROM video_view_days WHERE video_id = $1 AND day >= $2::date GROUP BY day`,
        [videoId, dayString(start)],
      );
      const byDay = new Map(rows.map((r) => [r.day, r]));
      return Array.from({ length: days }, (_, i) => {
        const day = dayString(new Date(start.getTime() + i * 86400_000));
        const r = byDay.get(day);
        return { day, views: r?.views ?? 0, watchMs: Number(r?.watch_ms ?? 0) };
      });
    },
  };
  return api;
}
