import { ipPrefix } from './sessions.js';

/** Who did what to what. Written for admin actions, money, security changes and moderation. Never holds secrets. */
export function createAuditService(ctx) {
  return {
    async record(actorId, action, { targetType = null, targetId = null, meta = {}, ip = null } = {}) {
      await ctx.db.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta, ip_prefix) VALUES ($1, $2, $3, $4, $5, $6)`,
        [actorId, action, targetType, targetId === null ? null : String(targetId), JSON.stringify(meta), ipPrefix(ip)],
      );
    },
    async recent(limit = 100, offset = 0) {
      const { rows } = await ctx.db.query(
        `SELECT a.*, u.handle AS actor_handle FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return rows;
    },
  };
}
