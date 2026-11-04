import { randomBytes } from 'node:crypto';
import { conflict, notFound } from '../lib/errors.js';

const CAP = 5000;
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Everything a member can do about their own account that is not signing in: profile, viewing preferences,
 * a copy of their data, and deleting the account.
 */
export function createAccountService(ctx) {
  const { db, clock, audit } = ctx;

  const api = {
    async updateProfile(userId, { displayName, bio, avatarHue, supportLinks }) {
      await db.query('UPDATE users SET display_name = $2, bio = $3, avatar_hue = $4, support_links = $5 WHERE id = $1', [
        userId,
        displayName,
        bio,
        avatarHue,
        JSON.stringify(supportLinks),
      ]);
    },

    async setPreferences(userId, { autoplay, dailyLimitMinutes }) {
      await db.query('UPDATE users SET autoplay = $2, daily_limit_minutes = $3 WHERE id = $1', [userId, autoplay, dailyLimitMinutes]);
    },

    /** A machine-readable copy of what we hold about a member. Never includes password hashes, secrets or payout details. */
    async exportData(userId) {
      const q = async (sql, params = [userId]) => (await db.query(sql, params)).rows;
      const account = await db.one(
        `SELECT id, email, email_verified_at, handle, display_name, bio, avatar_hue, role, created_at, last_login_at,
                terms_version, terms_accepted_at, creator_terms_version, creator_terms_accepted_at,
                totp_enabled_at, autoplay, daily_limit_minutes, support_links
           FROM users WHERE id = $1`,
        [userId],
      );
      if (!account) throw notFound();
      const [videos, comments, votes, subscriptions, saved, history, watchDays, notifications, contact, reports, actions, sent, received, ledger, profile, payouts, sessions] =
        await Promise.all([
          q(`SELECT id, title, description, tags, category, status, visibility, duration_ms, size_bytes, comments_enabled, has_paid_promotion, ad_status,
                    created_at, published_at, views, watch_ms, likes, dislikes, comment_count FROM videos WHERE owner_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`),
          q(`SELECT id, video_id, parent_id, body, status, created_at FROM comments WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`),
          q('SELECT video_id, value, created_at FROM video_votes WHERE user_id = $1 ORDER BY created_at DESC'),
          q(`SELECT u.handle AS channel_handle, s.notify, s.created_at FROM subscriptions s JOIN users u ON u.id = s.channel_id WHERE s.subscriber_id = $1 ORDER BY s.created_at DESC`),
          q('SELECT video_id, added_at FROM watch_later WHERE user_id = $1 ORDER BY added_at DESC'),
          q(`SELECT video_id, position_ms, watched_ms, completed, last_watched_at FROM watch_history WHERE user_id = $1 ORDER BY last_watched_at DESC LIMIT ${CAP}`),
          q('SELECT day, watch_ms FROM user_watch_days WHERE user_id = $1 ORDER BY day DESC LIMIT 400'),
          q(`SELECT kind, data, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`),
          q('SELECT subject, body, status, created_at FROM contact_messages WHERE user_id = $1 ORDER BY created_at DESC'),
          q('SELECT target_type, target_id, reason, details, status, created_at FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC'),
          q('SELECT action, target_type, target_id, ip_prefix, created_at FROM audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 500'),
          q(`SELECT id, channel_id, video_id, amount_minor, currency, status, message, anonymous, created_at, paid_at FROM payments WHERE payer_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`),
          q(`SELECT p.id, p.video_id, p.amount_minor, p.fee_minor, p.net_minor, p.currency, p.status, p.message, p.created_at, p.paid_at,
                    CASE WHEN p.anonymous THEN NULL ELSE u.handle END AS from_handle
               FROM payments p LEFT JOIN users u ON u.id = p.payer_id WHERE p.channel_id = $1 ORDER BY p.created_at DESC LIMIT ${CAP}`),
          q(`SELECT kind, amount_minor, currency, available_at, ref_type, ref_id, note, created_at FROM ledger_entries WHERE user_id = $1 ORDER BY id DESC LIMIT ${CAP}`),
          q('SELECT method, display_hint, updated_at FROM payout_profiles WHERE user_id = $1'),
          q(`SELECT id, amount_minor, currency, status, method, display_hint, requested_at, decided_at, paid_reference, paid_at, note FROM payouts WHERE user_id = $1 ORDER BY requested_at DESC`),
          ctx.sessions.listForUser(userId),
        ]);
      const subscribers = await db.one('SELECT count(*)::int AS n FROM subscriptions WHERE channel_id = $1', [userId]);
      return {
        format: 'vidverse-export-1',
        exportedAt: clock().toISOString(),
        note: `This file holds what ${ctx.config.siteName} stores about your account. It leaves out your password, your two-step secret and your recovery codes. Long lists stop at ${CAP} rows.`,
        account: { ...account, two_step_enabled: Boolean(account.totp_enabled_at), totp_enabled_at: undefined, subscribers: subscribers.n },
        videos,
        comments,
        likes_and_dislikes: votes,
        subscriptions,
        saved_for_later: saved,
        watch_history: history,
        watch_time_by_day: watchDays,
        notifications,
        signed_in_devices: sessions.map((s) => ({ started: iso(s.created_at), last_seen: iso(s.last_seen_at), browser: s.user_agent, network: s.ip_prefix })),
        messages_to_support: contact,
        reports_you_filed: reports,
        security_and_account_actions: actions,
        money: { tips_you_sent: sent, tips_you_received: received, balance_entries: ledger, payout_details: profile[0] ?? null, payouts },
      };
    },

    /** Reasons the account cannot be deleted yet. Money must be settled first: the records of it are kept by law. */
    async deletionBlockers(userId) {
      const out = [];
      const bal = await db.one('SELECT COALESCE(sum(amount_minor), 0) AS total FROM ledger_entries WHERE user_id = $1', [userId]);
      if (Number(bal?.total ?? 0) !== 0) out.push('You still have money in your balance, available or pending. Withdraw it first, or write to us if it is below the minimum payout.');
      const open = await db.one(`SELECT count(*)::int AS n FROM payouts WHERE user_id = $1 AND status IN ('requested', 'approved')`, [userId]);
      if (open.n > 0) out.push('You have a payout request that is not finished. Wait for it to be paid, or cancel it on the Payouts page.');
      const me = await db.one('SELECT role FROM users WHERE id = $1', [userId]);
      if (me?.role === 'admin') {
        const others = await db.one(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1`, [userId]);
        if (others.n === 0) out.push('You are the only administrator. Make someone else an administrator first.');
      }
      return out;
    },

    /**
     * Removes the person and what they made. The account row stays as an empty marker, because payment and payout
     * records that the law requires us to keep point at it; it holds no name, email address or password.
     */
    async deleteAccount(userId, { ip = null } = {}) {
      const blockers = await api.deletionBlockers(userId);
      if (blockers.length) throw conflict(blockers[0]);
      const user = await db.one(`SELECT email FROM users WHERE id = $1 AND status <> 'deleted'`, [userId]);
      if (!user) throw notFound();
      const videoIds = (await db.query('SELECT id FROM videos WHERE owner_id = $1', [userId])).rows.map((r) => r.id);
      const tag = randomBytes(5).toString('hex');
      const now = clock();

      await db.tx(async () => {
        const votedOn = (await db.query('SELECT DISTINCT video_id FROM video_votes WHERE user_id = $1', [userId])).rows.map((r) => r.video_id);
        const commentedOn = (await db.query('SELECT DISTINCT video_id FROM comments WHERE user_id = $1', [userId])).rows.map((r) => r.video_id);
        if (videoIds.length) await db.query(`DELETE FROM jobs WHERE status = 'queued' AND payload->>'videoId' = ANY($1::text[])`, [videoIds]);
        await db.query('DELETE FROM videos WHERE owner_id = $1', [userId]); // takes their comments, votes, history and view counts with it
        await db.query('DELETE FROM comments WHERE user_id = $1', [userId]); // and the replies under them
        await db.query('DELETE FROM video_votes WHERE user_id = $1', [userId]);
        if (votedOn.length) {
          await db.query(
            `UPDATE videos v SET likes = (SELECT count(*) FROM video_votes x WHERE x.video_id = v.id AND x.value = 1),
                                 dislikes = (SELECT count(*) FROM video_votes x WHERE x.video_id = v.id AND x.value = -1)
              WHERE v.id = ANY($1::text[])`,
            [votedOn],
          );
        }
        if (commentedOn.length) {
          await db.query(`UPDATE videos v SET comment_count = (SELECT count(*) FROM comments c WHERE c.video_id = v.id AND c.status = 'visible') WHERE v.id = ANY($1::text[])`, [commentedOn]);
        }
        await db.query('DELETE FROM subscriptions WHERE subscriber_id = $1 OR channel_id = $1', [userId]);
        await db.query('DELETE FROM watch_history WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM user_watch_days WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM watch_later WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM email_tokens WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM contact_messages WHERE user_id = $1 OR lower(email) = lower($2)', [userId, user.email]);
        await db.query('UPDATE reports SET reporter_id = NULL WHERE reporter_id = $1', [userId]);
        // Payment records stay, without the person: the payer is unlinked and the message removed.
        await db.query('UPDATE payments SET payer_id = NULL, anonymous = true, message = NULL WHERE payer_id = $1', [userId]);
        await db.query('DELETE FROM payout_profiles WHERE user_id = $1', [userId]);
        await db.query(`UPDATE payouts SET details_enc = '', display_hint = 'removed' WHERE user_id = $1`, [userId]);
        await db.query(
          `UPDATE users SET email = $2, handle = $3, display_name = 'Deleted account', bio = '', avatar_hue = 0, password_hash = '!',
                            email_verified_at = NULL, role = 'user', status = 'deleted', suspended_reason = NULL, deleted_at = $4,
                            totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0, recovery_codes = '[]',
                            support_links = '[]', autoplay = true, daily_limit_minutes = NULL, failed_logins = 0, locked_until = NULL
            WHERE id = $1`,
          [userId, `deleted-${userId}@deleted.invalid`, `deleted-${tag}`, now],
        );
      });

      // Files go after the database commit: a failure above must not leave rows pointing at missing files.
      for (const id of videoIds) ctx.storage.removeVideo(id);
      await audit.record(userId, 'user.delete', { targetType: 'user', targetId: userId, ip });
    },
  };
  return api;
}
