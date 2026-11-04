export function createNotificationService(ctx) {
  const { db } = ctx;
  return {
    async create(userId, kind, data = {}) {
      await db.query('INSERT INTO notifications (user_id, kind, data, created_at) VALUES ($1, $2, $3, $4)', [userId, kind, JSON.stringify(data), ctx.clock()]);
    },
    async unreadCount(userId) {
      const row = await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
      return row.n;
    },
    async list(userId, { limit = 30, offset = 0 } = {}) {
      const { rows } = await db.query('SELECT id, kind, data, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [userId, limit + 1, offset]);
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    async markAllRead(userId) {
      await db.query('UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL', [userId, ctx.clock()]);
    },
    async purgeOld(days = 90) {
      const cutoff = new Date(ctx.clock().getTime() - days * 86400_000);
      const r = await db.query('DELETE FROM notifications WHERE created_at < $1', [cutoff]);
      return r.rowCount;
    },
  };
}
