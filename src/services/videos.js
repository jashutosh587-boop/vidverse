import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { newVideoId } from '../lib/ids.js';
import { HttpError, notFound } from '../lib/errors.js';
import { sniffContainer } from './transcoder.js';

/** Columns every video card needs, with the channel that owns it. */
export const CARD_SELECT = `v.id, v.title, v.duration_ms, v.views, COALESCE(v.published_at, v.created_at) AS published_at, v.status, v.visibility,
  v.updated_at, v.category, v.owner_id, v.likes, v.dislikes, v.tags, u.handle AS channel_handle, u.display_name AS channel_name, u.avatar_hue AS channel_hue`;
export const PUBLIC_VIDEO = `v.status = 'ready' AND v.visibility = 'public' AND u.status = 'active'`;

const UPDATABLE = new Set(['title', 'description', 'tags', 'category', 'visibility', 'comments_enabled', 'has_paid_promotion', 'thumb_kind', 'thumb_name']);

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'moderator';

export function createVideoService(ctx) {
  const { db, config, clock, storage } = ctx;

  /** Announces a newly public video to the subscribers who asked for notifications. Runs once per video. */
  async function publishIfNeeded(videoId) {
    const v = await db.one(
      `UPDATE videos SET published_at = $2 WHERE id = $1 AND status = 'ready' AND visibility = 'public' AND published_at IS NULL
       RETURNING id, title, owner_id`,
      [videoId, clock()],
    );
    if (!v) return false;
    const ch = await db.one('SELECT handle, display_name FROM users WHERE id = $1', [v.owner_id]);
    await db.query(
      `INSERT INTO notifications (user_id, kind, data, created_at)
       SELECT s.subscriber_id, 'new_video', $2::jsonb, $3 FROM subscriptions s WHERE s.channel_id = $1 AND s.notify`,
      [v.owner_id, JSON.stringify({ videoId: v.id, title: v.title, channel: ch.display_name, handle: ch.handle }), clock()],
    );
    return true;
  }

  const api = {
    publishIfNeeded,

    canView(video, viewer) {
      if (!video) return false;
      if (viewer && (viewer.id === video.owner_id || isStaff(viewer))) return true;
      return video.status === 'ready' && video.owner_status === 'active' && (video.visibility === 'public' || video.visibility === 'unlisted');
    },

    async get(id) {
      return db.one(
        `SELECT v.*, u.handle AS channel_handle, u.display_name AS channel_name, u.avatar_hue AS channel_hue, u.status AS owner_status, u.bio AS channel_bio
           FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.id = $1`,
        [id],
      );
    },

    /** A video the viewer is allowed to see, or throws a 404 (never confirming that a hidden video exists). */
    async getVisible(id, viewer) {
      const v = await api.get(id);
      if (!api.canView(v, viewer)) throw notFound('We could not find that video.');
      return v;
    },

    async uploadsToday(ownerId) {
      const since = new Date(clock().getTime() - 24 * 3600_000);
      const r = await db.one('SELECT count(*)::int AS n FROM videos WHERE owner_id = $1 AND created_at >= $2', [ownerId, since]);
      return r.n;
    },
    async storageUsed(ownerId) {
      const r = await db.one(`SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM videos WHERE owner_id = $1 AND status <> 'failed'`, [ownerId]);
      return r.n;
    },

    async createDraft(ownerId, meta) {
      if ((await api.uploadsToday(ownerId)) >= config.uploads.dailyLimit) {
        throw new HttpError(429, `You can start up to ${config.uploads.dailyLimit} uploads a day. Try again tomorrow.`, { code: 'upload_limit' });
      }
      const ad = config.ads.defaultEligible ? 'eligible' : 'none';
      // Every time the app later compares with its own clock (daily upload limit, cleanup of abandoned uploads) must be
      // stamped by that same clock, not by the database's `now()`; otherwise the two can disagree (tests, clock drift).
      const stamped = clock();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await db.one(
            `INSERT INTO videos (id, owner_id, title, description, tags, category, visibility, comments_enabled, has_paid_promotion, ad_status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
            [newVideoId(), ownerId, meta.title, meta.description, meta.tags, meta.category, meta.visibility, meta.comments_enabled, meta.has_paid_promotion, ad, stamped],
          );
        } catch (e) {
          if (e?.code !== '23505') throw e; // id collision: try another
        }
      }
      throw new Error('could not allocate a video id');
    },

    /**
     * Streams the request body to disk with a hard size cap, then queues processing.
     * The caller has already checked who is uploading. Only the first bytes are inspected here; ffprobe does the rest.
     */
    async receiveUpload(video, req) {
      if (video.status !== 'uploading') throw new HttpError(409, 'This video already has a file.');
      const declared = Number(req.headers['content-length']);
      if (!Number.isInteger(declared) || declared <= 0) throw new HttpError(411, 'The upload must declare its size.');
      if (declared > config.uploads.maxBytes) throw new HttpError(413, `Files can be at most ${Math.round(config.uploads.maxBytes / 1024 ** 2)} MB.`, { code: 'too_large' });
      const used = await api.storageUsed(video.owner_id);
      if (used + declared > config.uploads.storageQuotaBytes) throw new HttpError(413, 'This upload would go over your storage allowance. Delete a video you no longer need.', { code: 'quota' });

      const final = storage.incomingPath(video.id);
      const part = `${final}.part`;
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length;
          if (bytes > declared || bytes > config.uploads.maxBytes) return cb(new HttpError(413, 'The upload was larger than it declared.'));
          cb(null, chunk);
        },
      });
      try {
        await pipeline(req, counter, fs.createWriteStream(part, { mode: 0o600 }));
      } catch (e) {
        fs.rmSync(part, { force: true });
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, 'The upload was interrupted. Try again.', { code: 'interrupted' });
      }
      if (bytes !== declared) {
        fs.rmSync(part, { force: true });
        throw new HttpError(400, 'The upload was incomplete. Try again.', { code: 'interrupted' });
      }
      if (!sniffContainer(part)) {
        fs.rmSync(part, { force: true });
        throw new HttpError(415, 'That file type is not supported. Upload an MP4, MOV, WebM, MKV or AVI video.', { code: 'unsupported' });
      }
      fs.renameSync(part, final);
      await db.query(`UPDATE videos SET status = 'processing', size_bytes = $2, updated_at = $3 WHERE id = $1 AND status = 'uploading'`, [video.id, bytes, clock()]);
      await ctx.jobs.enqueue('transcode', { videoId: video.id }, { dedupeKey: `transcode:${video.id}` });
      return { bytes };
    },

    async update(id, patch) {
      for (const k of Object.keys(patch)) if (!UPDATABLE.has(k)) throw new Error(`column not updatable: ${k}`);
      const sets = [];
      const params = [id];
      for (const [k, v] of Object.entries(patch)) {
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      params.push(clock());
      const row = await db.one(`UPDATE videos SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $1 RETURNING *`, params);
      await publishIfNeeded(id);
      return row;
    },

    async markReady(id, data) {
      await db.query(
        `UPDATE videos SET status = 'ready', duration_ms = $2, width = $3, height = $4, renditions = $5, poster_candidates = $6, thumb_kind = 'frame',
                thumb_name = $7, size_bytes = $8, fail_reason = NULL, updated_at = $9 WHERE id = $1 AND status = 'processing'`,
        [id, data.durationMs, data.width, data.height, JSON.stringify(data.renditions), JSON.stringify(data.posters), data.thumbName, data.sizeBytes, clock()],
      );
      await publishIfNeeded(id);
    },

    async markFailed(id, reason) {
      await db.query(`UPDATE videos SET status = 'failed', fail_reason = $2, updated_at = $3 WHERE id = $1 AND status IN ('processing', 'uploading')`, [id, String(reason).slice(0, 300), clock()]);
    },

    /** Hard delete by the owner: files first, then the row (comments, votes and history go with it). */
    async deleteVideo(id) {
      // A catalog video deleted from the site (by staff, or purged 30 days after removal) must not return on the next import.
      await db.query(
        `INSERT INTO catalog_skips (provider, key, reason, created_at) SELECT origin ->> 'provider', origin ->> 'key', 'deleted from the site', $2
           FROM videos WHERE id = $1 AND origin IS NOT NULL ON CONFLICT (provider, key) DO NOTHING`,
        [id, clock()],
      );
      storage.removeVideo(id);
      await db.query('DELETE FROM videos WHERE id = $1', [id]);
    },

    async removeByStaff(id, actorId, reason) {
      const v = await db.one(`UPDATE videos SET status = 'removed', removed_reason = $2, ad_status = 'none', updated_at = $3 WHERE id = $1 AND status <> 'removed' RETURNING owner_id, title`, [id, reason, clock()]);
      if (!v) return false;
      await ctx.notifications.create(v.owner_id, 'policy', { videoId: id, title: v.title, reason });
      await ctx.audit.record(actorId, 'video.remove', { targetType: 'video', targetId: id, meta: { reason } });
      return true;
    },

    async restoreByStaff(id, actorId) {
      const v = await db.one(`UPDATE videos SET status = 'ready', removed_reason = NULL, ad_status = $3, updated_at = $2 WHERE id = $1 AND status = 'removed' RETURNING owner_id`, [id, clock(), config.ads.defaultEligible ? 'eligible' : 'none']);
      if (!v) return false;
      await ctx.audit.record(actorId, 'video.restore', { targetType: 'video', targetId: id });
      return true;
    },

    async listByOwner(ownerId, { limit = 24, offset = 0 } = {}) {
      const { rows } = await db.query(
        `SELECT ${CARD_SELECT}, v.fail_reason, v.size_bytes, v.comment_count, v.created_at FROM videos v JOIN users u ON u.id = v.owner_id
          WHERE v.owner_id = $1 ORDER BY v.created_at DESC, v.id LIMIT $2 OFFSET $3`,
        [ownerId, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    async listChannel(channelId, { sort = 'new', limit = 24, offset = 0 } = {}) {
      const order = sort === 'popular' ? 'v.views DESC, v.published_at DESC' : 'v.published_at DESC';
      const { rows } = await db.query(
        `SELECT ${CARD_SELECT} FROM videos v JOIN users u ON u.id = v.owner_id
          WHERE v.owner_id = $1 AND ${PUBLIC_VIDEO} ORDER BY ${order}, v.id LIMIT $2 OFFSET $3`,
        [channelId, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    async countByOwner(ownerId) {
      const r = await db.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ready')::int AS ready FROM videos WHERE owner_id = $1`, [ownerId]);
      return r;
    },

    /** Videos stuck in "uploading" for a day are abandoned; "removed" ones are purged after 30 days. */
    async cleanup() {
      const now = clock();
      const stale = await db.query(`SELECT id FROM videos WHERE (status = 'uploading' AND created_at < $1) OR (status = 'removed' AND updated_at < $2)`, [
        new Date(now.getTime() - 24 * 3600_000),
        new Date(now.getTime() - 30 * 24 * 3600_000),
      ]);
      for (const { id } of stale.rows) await api.deleteVideo(id);
      return stale.rows.length;
    },
  };
  return api;
}
