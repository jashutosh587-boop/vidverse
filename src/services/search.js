import { CARD_SELECT, PUBLIC_VIDEO } from './videos.js';
import { avgViewed } from '../lib/ranking.js';

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
export const tokensOf = (q) => (String(q ?? '').toLowerCase().normalize('NFC').match(WORD) ?? []).map((t) => t.slice(0, 40)).slice(0, 8);
const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&');

export function createSearchService(ctx) {
  const { db } = ctx;
  return {
    tokensOf,

    /** Every word must match the start of a word in the title, tags or description; close spellings of the title also match. */
    async videos(q, { sort = 'relevance', limit = 24, offset = 0 } = {}) {
      const tokens = tokensOf(q);
      if (!tokens.length) return { items: [], hasMore: false };
      const tsq = tokens.map((t) => `${t}:*`).join(' & ');
      const text = tokens.join(' ');
      const base = `SELECT ${CARD_SELECT}, v.retention_sum, v.retention_n, ts_rank(to_tsvector('simple', v.search_text), to_tsquery('simple', $1)) AS rank,
                           similarity(lower(v.title), $2) AS sim
                      FROM videos v JOIN users u ON u.id = v.owner_id
                     WHERE ${PUBLIC_VIDEO} AND (to_tsvector('simple', v.search_text) @@ to_tsquery('simple', $1) OR lower(v.title) % $2)`;
      if (sort === 'new' || sort === 'views') {
        const order = sort === 'new' ? 'v.published_at DESC' : 'v.views DESC, v.published_at DESC';
        const { rows } = await db.query(`${base} ORDER BY ${order}, v.id LIMIT $3 OFFSET $4`, [tsq, text, limit + 1, offset]);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      const { rows } = await db.query(`${base} LIMIT 300`, [tsq, text]);
      const ranked = rows
        .map((v) => ({ v, s: (Number(v.rank) * 2 + Number(v.sim)) * (0.5 + avgViewed(v)) * Math.log10(Number(v.views) + 10) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.v);
      return { items: ranked.slice(offset, offset + limit), hasMore: ranked.length > offset + limit };
    },

    async channels(q, { limit = 5 } = {}) {
      const tokens = tokensOf(q);
      if (!tokens.length) return [];
      const text = tokens.join(' ');
      const { rows } = await db.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_hue, u.bio, (SELECT count(*) FROM subscriptions s WHERE s.channel_id = u.id)::int AS subscribers
           FROM users u
          WHERE u.status = 'active'
            AND (lower(u.handle) LIKE $1 || '%' ESCAPE '\\' OR lower(u.display_name) LIKE '%' || $1 || '%' ESCAPE '\\' OR lower(u.display_name) % $2)
            AND EXISTS (SELECT 1 FROM videos v WHERE v.owner_id = u.id AND v.status = 'ready' AND v.visibility = 'public')
          ORDER BY (lower(u.handle) = $2 OR lower(u.display_name) = $2) DESC, subscribers DESC LIMIT $3`,
        [likeEscape(text), text, limit],
      );
      return rows;
    },

    async suggest(q, { limit = 8 } = {}) {
      const tokens = tokensOf(q);
      if (!tokens.length || tokens.join('').length < 2) return [];
      const tsq = tokens.map((t) => `${t}:*`).join(' & ');
      const [vids, chans] = await Promise.all([
        db.query(`SELECT v.id, v.title FROM videos v JOIN users u ON u.id = v.owner_id WHERE ${PUBLIC_VIDEO} AND to_tsvector('simple', v.search_text) @@ to_tsquery('simple', $1) ORDER BY v.views DESC LIMIT $2`, [tsq, limit]),
        this.channels(q, { limit: 2 }),
      ]);
      return [
        ...chans.map((c) => ({ label: c.display_name, href: `/@${c.handle}`, kind: 'channel' })),
        ...vids.rows.map((v) => ({ label: v.title, href: `/watch/${v.id}`, kind: 'video' })),
      ].slice(0, limit);
    },
  };
}
