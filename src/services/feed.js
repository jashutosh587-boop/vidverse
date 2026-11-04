import { CARD_SELECT, PUBLIC_VIDEO } from './videos.js';
import { score, trendScore, diversify, affinityOf } from '../lib/ranking.js';
import { dayString } from '../lib/format.js';

const RANK_COLS = 'v.retention_sum, v.retention_n';

export function createFeedService(ctx) {
  const { db, clock } = ctx;

  async function recentViews(ids, days) {
    if (!ids.length) return new Map();
    const since = dayString(new Date(clock().getTime() - (days - 1) * 86400_000));
    const { rows } = await db.query(
      `SELECT video_id, count(*) FILTER (WHERE qualified)::int AS n FROM video_view_days WHERE day >= $1::date AND video_id = ANY($2::text[]) GROUP BY video_id`,
      [since, ids],
    );
    return new Map(rows.map((r) => [r.video_id, r.n]));
  }

  /** What a signed-in viewer has been watching lately, as category and tag weights between 0 and 1. */
  async function profileOf(userId) {
    const { rows } = await db.query(
      `SELECT v.category, v.tags, v.duration_ms, h.watched_ms, h.last_watched_at FROM watch_history h JOIN videos v ON v.id = h.video_id
        WHERE h.user_id = $1 ORDER BY h.last_watched_at DESC LIMIT 60`,
      [userId],
    );
    if (!rows.length) return null;
    const now = clock().getTime();
    const categories = new Map();
    const tags = new Map();
    for (const r of rows) {
      const watched = Math.min(1, Number(r.watched_ms) / Math.max(1, r.duration_ms ?? 1));
      const recency = 0.5 ** ((now - new Date(r.last_watched_at).getTime()) / (14 * 86400_000));
      const w = watched * recency;
      categories.set(r.category, (categories.get(r.category) ?? 0) + w);
      for (const t of r.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + w);
    }
    const norm = (m) => {
      const max = Math.max(1e-9, ...m.values());
      for (const [k, v] of m) m.set(k, v / max);
    };
    norm(categories);
    norm(tags);
    return { categories, tags };
  }

  async function candidates(extraWhere = '', params = []) {
    const sql = (order) => `SELECT ${CARD_SELECT}, ${RANK_COLS} FROM videos v JOIN users u ON u.id = v.owner_id WHERE ${PUBLIC_VIDEO} ${extraWhere} ORDER BY ${order} LIMIT 200`;
    const [fresh, popular] = await Promise.all([db.query(sql('v.published_at DESC'), params), db.query(sql('v.views DESC, v.published_at DESC'), params)]);
    const byId = new Map();
    for (const r of [...fresh.rows, ...popular.rows]) byId.set(r.id, r);
    return [...byId.values()];
  }

  return {
    profileOf,

    /** Home: everyone sees the same quality ranking; signed-in viewers also get a nudge towards what they watch. */
    async home(userId, { category = null, limit = 24, offset = 0 } = {}) {
      const now = clock();
      const rows = await candidates(category ? 'AND v.category = $1' : '', category ? [category] : []);
      const [recent, profile, done] = await Promise.all([
        recentViews(rows.map((r) => r.id), 14),
        userId ? profileOf(userId) : null,
        userId ? db.query('SELECT video_id FROM watch_history WHERE user_id = $1 AND completed', [userId]) : { rows: [] },
      ]);
      const watched = new Set(done.rows.map((r) => r.video_id));
      const ranked = rows
        .map((v) => ({ v, s: score(v, { now, recentViews: recent.get(v.id) ?? 0, affinity: affinityOf(v, profile), watched: watched.has(v.id) }) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.v);
      const list = diversify(ranked);
      return { items: list.slice(offset, offset + limit), hasMore: list.length > offset + limit };
    },

    async trending({ category = null, limit = 24, offset = 0 } = {}) {
      const rows = await candidates(category ? 'AND v.category = $1' : '', category ? [category] : []);
      const recent = await recentViews(rows.map((r) => r.id), 3);
      const ranked = rows
        .filter((v) => (recent.get(v.id) ?? 0) > 0)
        .map((v) => ({ v, s: trendScore(v, { recentViews: recent.get(v.id) }) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.v);
      const list = diversify(ranked, { perChannel: 2, window: 20 });
      return { items: list.slice(offset, offset + limit), hasMore: list.length > offset + limit };
    },

    /** "Up next": the same channel, then the same topics, ranked by quality. */
    async related(video, { limit = 12 } = {}) {
      const now = clock();
      const rows = (await candidates()).filter((v) => v.id !== video.id);
      const recent = await recentViews(rows.map((r) => r.id), 14);
      const tags = new Set(video.tags ?? []);
      const ranked = rows
        .map((v) => {
          const overlap = (v.tags ?? []).filter((t) => tags.has(t)).length;
          const fit = (v.category === video.category ? 0.35 : 0) + Math.min(0.5, overlap * 0.25) + (v.owner_id === video.owner_id ? 0.25 : 0);
          return { v, s: score(v, { now, recentViews: recent.get(v.id) ?? 0 }) * (0.25 + fit) };
        })
        .sort((a, b) => b.s - a.s)
        .map((x) => x.v);
      return diversify(ranked, { perChannel: 3, window: limit }).slice(0, limit);
    },

    async newest({ limit = 12 } = {}) {
      const { rows } = await db.query(`SELECT ${CARD_SELECT} FROM videos v JOIN users u ON u.id = v.owner_id WHERE ${PUBLIC_VIDEO} ORDER BY v.published_at DESC LIMIT $1`, [limit]);
      return rows;
    },
  };
}
