import express from 'express';
import fs from 'node:fs';
import { notFound } from '../../lib/errors.js';
import { isVideoId } from '../../lib/ids.js';
import { isStaff } from '../../services/videos.js';

const NOT_FOUND = notFound('Not found.');
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.jpg': 'image/jpeg' };

/**
 * Serves processed video and thumbnails. Mounted before the session middleware so public files do not cost a
 * session lookup; a video that is not public falls back to checking the cookie itself.
 * Anything the viewer may not see answers 404, never 403, so private video ids cannot be probed.
 */
export function mediaRoutes(ctx) {
  const r = express.Router();
  const { storage } = ctx;

  /** The person behind the session cookie, if there is a live signed-in session. */
  async function sessionViewer(req) {
    const cookie = /(?:^|;\s*)__Host-vv_sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie ?? '')?.[1];
    if (!cookie) return null;
    const found = await ctx.sessions.lookup(cookie);
    return found?.session.stage === 'active' ? found.user : null;
  }

  /**
   * Can this request see the video? Public files skip the session lookup unless `withViewer` asks for it (the candidate
   * thumbnail frames are for the owner and staff only, even when the video itself is public).
   */
  async function allowed(req, id, { withViewer = false } = {}) {
    const video = await ctx.videos.get(id);
    if (!video) return null;
    const isPublic = video.status === 'ready' && video.owner_status === 'active' && video.visibility === 'public';
    if (isPublic && !withViewer) return { video, isPublic: true };
    // Not public: needs a signed-in owner (or staff), or, for unlisted, anyone holding the link.
    const viewer = await sessionViewer(req);
    if (!isPublic && !ctx.videos.canView(video, viewer)) return null;
    return { video, isPublic, privileged: !!viewer && (viewer.id === video.owner_id || isStaff(viewer)) };
  }

  function send(res, file, { isPublic, immutable, noStore }) {
    const ext = file.slice(file.lastIndexOf('.'));
    const cache = noStore ? 'private, no-store' : `${isPublic ? 'public' : 'private'}, max-age=${immutable ? 31536000 : 60}${immutable ? ', immutable' : ''}`;
    return new Promise((resolve, reject) => {
      res.sendFile(file, { dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false, headers: { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cache } }, (err) => {
        if (!err) return resolve();
        // The viewer closed the tab, skipped ahead or switched quality in the middle of a download. Players do this all
        // the time. It is not a fault on our side, so it must not become a logged 500.
        if (['ECONNABORTED', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err.code) || res.destroyed) return resolve();
        return reject(err);
      });
    });
  }

  // The chosen thumbnail. ?v= changes whenever the video changes, so it can be cached for good.
  r.get('/media/t/:file', async (req, res, next) => {
    const id = /^([A-Za-z0-9_-]{11})\.jpg$/.exec(req.params.file)?.[1];
    if (!id) return next(NOT_FOUND);
    const a = await allowed(req, id);
    if (!a || a.video.status !== 'ready' || !a.video.thumb_name) return next(NOT_FOUND);
    const file = storage.resolve(id, a.video.thumb_name);
    if (!file || !fs.existsSync(file)) return next(NOT_FOUND);
    await send(res, file, { isPublic: a.isPublic, immutable: !!req.query.v });
  });

  // Candidate frames, shown in the studio when choosing a thumbnail.
  r.get('/media/f/:id/:name', async (req, res, next) => {
    if (!isVideoId(req.params.id) || !/^thumb_[0-2]\.jpg$/.test(req.params.name)) return next(NOT_FOUND);
    const a = await allowed(req, req.params.id, { withViewer: true });
    if (!a?.privileged) return next(NOT_FOUND);
    const file = storage.resolve(req.params.id, req.params.name);
    if (!file || !fs.existsSync(file)) return next(NOT_FOUND);
    await send(res, file, { isPublic: false, noStore: true });
  });

  r.get('/media/v/:id/master.m3u8', async (req, res, next) => {
    if (!isVideoId(req.params.id)) return next(NOT_FOUND);
    const a = await allowed(req, req.params.id);
    if (!a || a.video.status !== 'ready') return next(NOT_FOUND);
    const file = storage.resolve(req.params.id, 'master.m3u8');
    if (!file || !fs.existsSync(file)) return next(NOT_FOUND);
    await send(res, file, { isPublic: a.isPublic, immutable: false });
  });

  r.get('/media/v/:id/:rendition/:file', async (req, res, next) => {
    const { id, rendition, file: name } = req.params;
    if (!isVideoId(id) || !/^\d{1,4}p$/.test(rendition) || !/^(index\.m3u8|seg_\d{5}\.ts)$/.test(name)) return next(NOT_FOUND);
    const a = await allowed(req, id);
    if (!a || a.video.status !== 'ready') return next(NOT_FOUND);
    const file = storage.resolve(id, rendition, name);
    if (!file || !fs.existsSync(file)) return next(NOT_FOUND);
    await send(res, file, { isPublic: a.isPublic, immutable: name.endsWith('.ts') });
  });

  return r;
}

export const mediaMount = { beforeSession: true, attach: (app, ctx) => app.use(mediaRoutes(ctx)) };
