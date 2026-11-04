import { HttpError } from '../lib/errors.js';
import { isStaff } from './videos.js';

export const REPORT_REASONS = [
  ['spam', 'Spam or scam'],
  ['misleading', 'Misleading title or thumbnail'],
  ['harassment', 'Harassment or bullying'],
  ['hate', 'Hate speech'],
  ['violence', 'Violent or dangerous'],
  ['sexual', 'Sexual content'],
  ['child_safety', 'Child safety'],
  ['copyright', 'Copyright'],
  ['illegal', 'Illegal content'],
  ['other', 'Something else'],
];
export const REASON_IDS = REPORT_REASONS.map(([id]) => id);

export function createModerationService(ctx) {
  const { db, clock, config } = ctx;
  const restoreAds = config.ads.defaultEligible ? 'eligible' : 'none';

  async function targetExists(type, id) {
    if (type === 'video') return !!(await db.one(`SELECT 1 AS x FROM videos WHERE id = $1 AND status <> 'removed'`, [id]));
    if (type === 'comment') return /^\d+$/.test(id) && !!(await db.one(`SELECT 1 AS x FROM comments WHERE id = $1 AND status = 'visible'`, [id]));
    if (type === 'user') return /^[0-9a-f-]{36}$/.test(id) && !!(await db.one(`SELECT 1 AS x FROM users WHERE id = $1 AND status = 'active'`, [id]));
    return false;
  }

  /** Suspends an active account and signs it out everywhere. Returns false when the account was not active. */
  async function suspend(userId, actor, reason) {
    const u = await db.one('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!u) throw new HttpError(404, 'We could not find that account.');
    if (u.role === 'admin' && actor.role !== 'admin') throw new HttpError(403, 'Only an admin can suspend an admin.');
    if (u.id === actor.id) throw new HttpError(400, 'You cannot suspend yourself.');
    const changed = await db.one(`UPDATE users SET status = 'suspended', suspended_reason = $2 WHERE id = $1 AND status = 'active' RETURNING id`, [userId, reason.slice(0, 300)]);
    if (!changed) return false;
    await ctx.sessions.destroyAllForUser(userId);
    await ctx.audit.record(actor.id, 'user.suspend', { targetType: 'user', targetId: userId, meta: { reason } });
    return true;
  }

  const api = {
    async report({ reporterId, targetType, targetId, reason, details = '' }) {
      if (!REASON_IDS.includes(reason)) throw new HttpError(400, 'Choose a reason.');
      if (!(await targetExists(targetType, String(targetId)))) throw new HttpError(404, 'We could not find what you are reporting.');
      const inserted = await db.one(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'open' DO NOTHING RETURNING id`,
        [reporterId, targetType, String(targetId), reason, details.slice(0, 1000), clock()],
      );
      // Brand safety: no ads next to a video someone has reported until a moderator has looked at it.
      if (inserted && targetType === 'video') await db.query(`UPDATE videos SET ad_status = 'limited' WHERE id = $1 AND ad_status = 'eligible'`, [targetId]);
      return { created: !!inserted };
    },

    async queue({ status = 'open', limit = 30, offset = 0 } = {}) {
      const { rows } = await db.query(
        `SELECT r.*, ru.handle AS reporter_handle,
                CASE r.target_type WHEN 'video' THEN (SELECT title FROM videos WHERE id = r.target_id)
                                   WHEN 'comment' THEN (SELECT left(body, 200) FROM comments WHERE id::text = r.target_id)
                                   WHEN 'user' THEN (SELECT '@' || handle FROM users WHERE id::text = r.target_id) END AS target_label,
                (SELECT count(*) FROM reports o WHERE o.target_type = r.target_type AND o.target_id = r.target_id AND o.status = 'open')::int AS open_for_target
           FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id
          WHERE r.status = $1 ORDER BY (r.reason = 'child_safety') DESC, r.created_at LIMIT $2 OFFSET $3`,
        [status, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    /**
     * decision: dismiss | remove (video or comment) | suspend (user, or the owner of the video/comment).
     * The report is claimed first, in the same transaction as the action, so two moderators cannot both
     * act on it and a failed action leaves the report open.
     */
    async resolve(reportId, actor, decision, note = '') {
      if (!isStaff(actor)) throw new HttpError(403, 'Only moderators can do that.');
      if (!['dismiss', 'remove', 'suspend'].includes(decision)) throw new HttpError(400, 'Unknown decision.');
      await db.tx(async () => {
        const rep = await db.one(
          `UPDATE reports SET status = $2, handled_by = $3, handled_at = $4, resolution_note = $5
            WHERE id = $1 AND status = 'open' RETURNING *`,
          [reportId, decision === 'dismiss' ? 'dismissed' : 'actioned', actor.id, clock(), note.slice(0, 500)],
        );
        if (!rep) {
          const exists = await db.one('SELECT 1 AS x FROM reports WHERE id = $1', [reportId]);
          throw exists ? new HttpError(409, 'That report was already handled.') : new HttpError(404, 'We could not find that report.');
        }
        if (decision === 'remove') {
          if (rep.target_type === 'video') await ctx.videos.removeByStaff(rep.target_id, actor.id, note || 'Removed for breaking the community guidelines.');
          else if (rep.target_type === 'comment') {
            // already gone (the author may have deleted it) is the outcome we wanted anyway
            const visible = /^\d+$/.test(rep.target_id) && (await db.one(`SELECT 1 AS x FROM comments WHERE id = $1 AND status = 'visible'`, [rep.target_id]));
            if (visible) await ctx.comments.remove(Number(rep.target_id), actor);
          } else throw new HttpError(400, 'Only videos and comments can be removed.');
        } else if (decision === 'suspend') {
          let userId = rep.target_id;
          if (rep.target_type === 'video') userId = (await db.one('SELECT owner_id FROM videos WHERE id = $1', [rep.target_id]))?.owner_id;
          if (rep.target_type === 'comment') userId = (await db.one('SELECT user_id FROM comments WHERE id = $1', [rep.target_id]))?.user_id;
          if (!userId) throw new HttpError(409, 'That account no longer exists.');
          await suspend(userId, actor, note || 'Suspended for breaking the community guidelines.'); // already suspended is fine here
        }
        await ctx.audit.record(actor.id, `report.${decision}`, { targetType: rep.target_type, targetId: rep.target_id, meta: { reportId, reason: rep.reason } });
        if (rep.target_type === 'video') {
          const open = await db.one(`SELECT count(*)::int AS n FROM reports WHERE target_type = 'video' AND target_id = $1 AND status = 'open'`, [rep.target_id]);
          if (open.n === 0) await db.query(`UPDATE videos SET ad_status = $2 WHERE id = $1 AND ad_status = 'limited'`, [rep.target_id, restoreAds]);
        }
      });
    },

    async suspendUser(userId, actor, reason) {
      if (!isStaff(actor)) throw new HttpError(403, 'Only moderators can do that.');
      if (!(await suspend(userId, actor, reason))) throw new HttpError(409, 'That account is not active, so it cannot be suspended.');
    },

    async restoreUser(userId, actor) {
      if (!isStaff(actor)) throw new HttpError(403, 'Only moderators can do that.');
      const u = await db.one(`UPDATE users SET status = 'active', suspended_reason = NULL WHERE id = $1 AND status = 'suspended' RETURNING id`, [userId]);
      if (!u) throw new HttpError(409, 'That account is not suspended.');
      await ctx.audit.record(actor.id, 'user.restore', { targetType: 'user', targetId: userId });
    },
  };
  return api;
}
