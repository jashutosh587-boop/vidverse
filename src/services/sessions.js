import { randomToken, sha256Hex } from '../lib/crypto.js';

const DAY = 24 * 3600 * 1000;
export const IDLE_MS = 14 * DAY;
export const ABSOLUTE_MS = 60 * DAY;
export const MFA_WINDOW_MS = 10 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/** A coarse network prefix (never the full address) for the "devices" list and the audit log. */
export function ipPrefix(ip) {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return null;
}

export function createSessionService(ctx) {
  const { db, clock } = ctx;
  return {
    /** Starts a session and returns the cookie value. Only its SHA-256 is stored. */
    async create(userId, { userAgent, ip, stage = 'active' } = {}) {
      const token = randomToken(32);
      const now = clock();
      const expires = new Date(now.getTime() + (stage === 'mfa' ? MFA_WINDOW_MS : ABSOLUTE_MS));
      const idle = new Date(now.getTime() + (stage === 'mfa' ? MFA_WINDOW_MS : IDLE_MS));
      await db.query(
        `INSERT INTO sessions (id, user_id, stage, created_at, last_seen_at, idle_expires_at, expires_at, user_agent, ip_prefix)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
        [sha256Hex(token), userId, stage, now, idle, expires, (userAgent ?? '').slice(0, 200), ipPrefix(ip)],
      );
      return { token, expiresAt: expires };
    },

    /** Returns { session, user } for a live cookie value, or null. Suspended and deleted accounts get null. */
    async lookup(token) {
      const now = clock();
      const row = await db.one(
        `SELECT s.id AS sid, s.stage, s.created_at AS s_created, s.last_seen_at, s.expires_at,
                u.id, u.email, u.email_verified_at, u.handle, u.display_name, u.avatar_hue, u.bio, u.role, u.status,
                u.terms_version, u.creator_terms_version, u.totp_enabled_at, u.autoplay, u.daily_limit_minutes,
                u.support_links, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > $2 AND s.idle_expires_at > $2`,
        [sha256Hex(token), now],
      );
      if (!row || row.status !== 'active') return null;
      const { sid, stage, s_created, last_seen_at, expires_at, ...user } = row;
      if (stage === 'active' && now.getTime() - new Date(last_seen_at).getTime() > TOUCH_EVERY_MS) {
        const idle = new Date(Math.min(now.getTime() + IDLE_MS, new Date(expires_at).getTime()));
        await db.query('UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [sid, now, idle]);
      }
      return { session: { id: sid, stage, createdAt: s_created }, user };
    },

    async destroy(token) {
      await db.query('DELETE FROM sessions WHERE id = $1', [sha256Hex(token)]);
    },
    async destroyById(userId, sessionId) {
      await db.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
    },
    async destroyAllForUser(userId, exceptSessionId = null) {
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)', [userId, exceptSessionId]);
    },
    async listForUser(userId) {
      const { rows } = await db.query(
        `SELECT id, created_at, last_seen_at, user_agent, ip_prefix FROM sessions
          WHERE user_id = $1 AND stage = 'active' AND expires_at > $2 AND idle_expires_at > $2 ORDER BY last_seen_at DESC`,
        [userId, clock()],
      );
      return rows;
    },
    async purgeExpired() {
      const now = clock();
      const r = await db.query('DELETE FROM sessions WHERE expires_at <= $1 OR idle_expires_at <= $1', [now]);
      return r.rowCount;
    },
  };
}
