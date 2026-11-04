import { HttpError } from '../lib/errors.js';
import { CARD_SELECT } from './videos.js';

const VISIBLE = `v.status = 'ready' AND v.visibility IN ('public', 'unlisted') AND u.status = 'active'`;

export function createEngagementService(ctx) {
  const { db, clock } = ctx;
  const page = async (sql, params, limit) => {
    const { rows } = await db.query(sql, params);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  };

  return {
    // ---- likes ----
    async vote(userId, videoId, value) {
      if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Invalid vote.');
      return db.tx(async () => {
        if (value === 0) await db.query('DELETE FROM video_votes WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
        else {
          await db.query(
            `INSERT INTO video_votes (user_id, video_id, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, video_id) DO UPDATE SET value = $3`,
            [userId, videoId, value],
          );
        }
        const c = await db.one(
          `UPDATE videos SET likes = (SELECT count(*) FROM video_votes WHERE video_id = $1 AND value = 1),
                             dislikes = (SELECT count(*) FROM video_votes WHERE video_id = $1 AND value = -1) WHERE id = $1 RETURNING likes, dislikes`,
          [videoId],
        );
        return { ...c, mine: value };
      });
    },
    async myVote(userId, videoId) {
      const r = await db.one('SELECT value FROM video_votes WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
      return r?.value ?? 0;
    },
    async listLiked(userId, { limit = 24, offset = 0 } = {}) {
      return page(
        `SELECT ${CARD_SELECT} FROM video_votes x JOIN videos v ON v.id = x.video_id JOIN users u ON u.id = v.owner_id
          WHERE x.user_id = $1 AND x.value = 1 AND ${VISIBLE} ORDER BY x.created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
        limit,
      );
    },

    // ---- subscriptions ----
    async subscribe(userId, channelId) {
      if (userId === channelId) throw new HttpError(400, 'You cannot subscribe to your own channel.');
      const ch = await db.one(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [channelId]);
      if (!ch) throw new HttpError(404, 'We could not find that channel.');
      await db.query('INSERT INTO subscriptions (subscriber_id, channel_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, channelId, clock()]);
    },
    async unsubscribe(userId, channelId) {
      await db.query('DELETE FROM subscriptions WHERE subscriber_id = $1 AND channel_id = $2', [userId, channelId]);
    },
    async setNotify(userId, channelId, notify) {
      await db.query('UPDATE subscriptions SET notify = $3 WHERE subscriber_id = $1 AND channel_id = $2', [userId, channelId, notify]);
    },
    async subscription(userId, channelId) {
      return db.one('SELECT notify FROM subscriptions WHERE subscriber_id = $1 AND channel_id = $2', [userId, channelId]);
    },
    async subscriberCount(channelId) {
      return (await db.one('SELECT count(*)::int AS n FROM subscriptions WHERE channel_id = $1', [channelId])).n;
    },
    async subscribedChannels(userId, limit = 60) {
      const { rows } = await db.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_hue FROM subscriptions s JOIN users u ON u.id = s.channel_id
          WHERE s.subscriber_id = $1 AND u.status = 'active' ORDER BY s.created_at DESC LIMIT $2`,
        [userId, limit],
      );
      return rows;
    },
    async subscriptionFeed(userId, { limit = 24, offset = 0 } = {}) {
      return page(
        `SELECT ${CARD_SELECT} FROM subscriptions s JOIN videos v ON v.owner_id = s.channel_id JOIN users u ON u.id = v.owner_id
          WHERE s.subscriber_id = $1 AND v.status = 'ready' AND v.visibility = 'public' AND u.status = 'active'
          ORDER BY v.published_at DESC, v.id LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
        limit,
      );
    },

    // ---- watch later ----
    async saveForLater(userId, videoId) {
      await db.query('INSERT INTO watch_later (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, videoId]);
    },
    async removeSaved(userId, videoId) {
      await db.query('DELETE FROM watch_later WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    },
    async isSaved(userId, videoId) {
      return !!(await db.one('SELECT 1 AS x FROM watch_later WHERE user_id = $1 AND video_id = $2', [userId, videoId]));
    },
    async listSaved(userId, { limit = 24, offset = 0 } = {}) {
      return page(
        `SELECT ${CARD_SELECT} FROM watch_later w JOIN videos v ON v.id = w.video_id JOIN users u ON u.id = v.owner_id
          WHERE w.user_id = $1 AND ${VISIBLE} ORDER BY w.added_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
        limit,
      );
    },

    // ---- history ----
    async listHistory(userId, { limit = 24, offset = 0 } = {}) {
      return page(
        `SELECT ${CARD_SELECT}, h.position_ms, h.completed, h.last_watched_at FROM watch_history h JOIN videos v ON v.id = h.video_id JOIN users u ON u.id = v.owner_id
          WHERE h.user_id = $1 AND ${VISIBLE} ORDER BY h.last_watched_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset],
        limit,
      );
    },
    async continueWatching(userId, limit = 6) {
      const { rows } = await db.query(
        `SELECT ${CARD_SELECT}, h.position_ms FROM watch_history h JOIN videos v ON v.id = h.video_id JOIN users u ON u.id = v.owner_id
          WHERE h.user_id = $1 AND NOT h.completed AND h.position_ms > 10000 AND ${VISIBLE} ORDER BY h.last_watched_at DESC LIMIT $2`,
        [userId, limit],
      );
      return rows;
    },
    async resumePosition(userId, videoId) {
      const r = await db.one('SELECT position_ms, completed FROM watch_history WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
      return r && !r.completed ? r.position_ms : 0;
    },
    async clearHistory(userId) {
      await db.query('DELETE FROM watch_history WHERE user_id = $1', [userId]);
    },
    async removeFromHistory(userId, videoId) {
      await db.query('DELETE FROM watch_history WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    },
    now: clock,
  };
}
