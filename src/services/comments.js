import { HttpError } from '../lib/errors.js';
import { isStaff } from './videos.js';

const LINK_RE = /(https?:\/\/|www\.)/gi;

export function createCommentService(ctx) {
  const { db, clock } = ctx;

  const recount = (videoId) =>
    db.query(`UPDATE videos SET comment_count = (SELECT count(*) FROM comments WHERE video_id = $1 AND status = 'visible') WHERE id = $1`, [videoId]);

  return {
    /** Newest first, `limit` per page; each comment carries its reply count and the first few replies. */
    async list(videoId, { offset = 0, limit = 20, replyPreview = 5 } = {}) {
      const { rows } = await db.query(
        `SELECT c.id, c.body, c.created_at, c.user_id, u.handle, u.display_name, u.avatar_hue,
                (SELECT count(*) FROM comments r JOIN users ru ON ru.id = r.user_id WHERE r.parent_id = c.id AND r.status = 'visible' AND ru.status = 'active')::int AS reply_count
           FROM comments c JOIN users u ON u.id = c.user_id
          WHERE c.video_id = $1 AND c.parent_id IS NULL AND c.status = 'visible' AND u.status = 'active'
          ORDER BY c.created_at DESC, c.id DESC LIMIT $2 OFFSET $3`,
        [videoId, limit + 1, offset],
      );
      const items = rows.slice(0, limit);
      if (items.length) {
        const ids = items.map((c) => c.id);
        const replies = await db.query(
          `SELECT * FROM (
             SELECT r.id, r.parent_id, r.body, r.created_at, r.user_id, u.handle, u.display_name, u.avatar_hue,
                    row_number() OVER (PARTITION BY r.parent_id ORDER BY r.created_at, r.id) AS n
               FROM comments r JOIN users u ON u.id = r.user_id WHERE r.parent_id = ANY($1::bigint[]) AND r.status = 'visible' AND u.status = 'active') x
           WHERE n <= $2 ORDER BY parent_id, n`,
          [ids, replyPreview],
        );
        const by = new Map();
        for (const r of replies.rows) by.set(r.parent_id, [...(by.get(r.parent_id) ?? []), r]);
        for (const c of items) c.replies = by.get(c.id) ?? [];
      }
      return { items, hasMore: rows.length > limit };
    },

    /** One top-level comment with all of its replies, for "view all replies" and for landing on a reply. */
    async thread(videoId, parentId) {
      const c = await db.one(
        `SELECT c.id, c.body, c.created_at, c.user_id, u.handle, u.display_name, u.avatar_hue
           FROM comments c JOIN users u ON u.id = c.user_id
          WHERE c.id = $1 AND c.video_id = $2 AND c.parent_id IS NULL AND c.status = 'visible' AND u.status = 'active'`,
        [parentId, videoId],
      );
      if (!c) return null;
      c.replies = await this.repliesOf(parentId);
      c.reply_count = c.replies.length;
      return c;
    },

    async repliesOf(parentId) {
      const { rows } = await db.query(
        `SELECT r.id, r.parent_id, r.body, r.created_at, r.user_id, u.handle, u.display_name, u.avatar_hue
           FROM comments r JOIN users u ON u.id = r.user_id WHERE r.parent_id = $1 AND r.status = 'visible' AND u.status = 'active' ORDER BY r.created_at, r.id LIMIT 200`,
        [parentId],
      );
      return rows;
    },

    async add({ user, video, body, parentId = null }) {
      if (!video.comments_enabled) throw new HttpError(403, 'Comments are turned off for this video.');
      if ((body.match(LINK_RE) ?? []).length > 2) throw new HttpError(422, 'A comment can include at most two links.', { code: 'links' });
      let parent = null;
      if (parentId) {
        parent = await db.one(`SELECT id, user_id, video_id, parent_id FROM comments WHERE id = $1 AND status = 'visible'`, [parentId]);
        if (!parent || parent.video_id !== video.id || parent.parent_id) throw new HttpError(404, 'We could not find the comment you are replying to.');
      }
      const since = new Date(clock().getTime() - 10 * 60_000);
      if (await db.one('SELECT 1 AS x FROM comments WHERE user_id = $1 AND video_id = $2 AND body = $3 AND created_at > $4', [user.id, video.id, body, since])) {
        throw new HttpError(409, 'You already posted that.', { code: 'duplicate' });
      }
      const c = await db.one('INSERT INTO comments (video_id, user_id, parent_id, body, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [video.id, user.id, parentId, body, clock()]);
      await recount(video.id);
      const data = { videoId: video.id, title: video.title, commentId: parentId ?? c.id, by: user.display_name, handle: user.handle };
      if (video.owner_id !== user.id) await ctx.notifications.create(video.owner_id, 'comment', data);
      if (parent && parent.user_id !== user.id && parent.user_id !== video.owner_id) await ctx.notifications.create(parent.user_id, 'reply', data);
      return c.id;
    },

    /** The author, the video's owner and staff may remove a comment. */
    async remove(commentId, actor) {
      const c = await db.one(`SELECT c.id, c.user_id, c.video_id, v.owner_id FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = $1 AND c.status = 'visible'`, [commentId]);
      if (!c) throw new HttpError(404, 'We could not find that comment.');
      if (c.user_id !== actor.id && c.owner_id !== actor.id && !isStaff(actor)) throw new HttpError(403, 'You cannot remove that comment.');
      await db.query(`UPDATE comments SET status = 'removed' WHERE id = $1 OR parent_id = $1`, [commentId]);
      await recount(c.video_id);
      if (c.user_id !== actor.id) await ctx.audit.record(actor.id, 'comment.remove', { targetType: 'comment', targetId: commentId, meta: { by: isStaff(actor) && c.owner_id !== actor.id ? 'staff' : 'owner' } });
      return c.video_id;
    },
  };
}
