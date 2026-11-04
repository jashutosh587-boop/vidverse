import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_VERSION } from '../../config.js';
import { HttpError, ValidationError, notFound } from '../../lib/errors.js';
import { isVideoId } from '../../lib/ids.js';
import { parseInput } from '../../lib/validate.js';
import { videoMetaSchema } from '../../lib/video-meta.js';
import { processCustomThumbnail, Rejection } from '../../services/transcoder.js';
import { limit } from '../middleware/limit.js';
import { requireUser, requireVerified, creatorTermsAccepted } from '../guards.js';
import { pageOf } from '../util.js';
import * as v from '../views/pages/studio.js';

export function studioRoutes(ctx) {
  const r = express.Router();
  const { config } = ctx;
  const uploadLimit = limit(ctx, { name: 'upload', limit: 60, windowMs: 3600_000, key: (req) => req.user?.id ?? req.ip });

  r.use('/studio', requireUser);
  r.use('/api/studio', requireUser);

  async function owned(req) {
    if (!isVideoId(req.params.id)) throw notFound('We could not find that video.');
    const video = await ctx.videos.get(req.params.id);
    if (!video || video.owner_id !== req.user.id) throw notFound('We could not find that video.');
    return video;
  }

  const gateMessage = (user) => {
    if (!user.email_verified_at) return 'Confirm your email address before uploading. We sent a link when you signed up.';
    if (!creatorTermsAccepted(user, LEGAL_VERSION)) return null;
    return '';
  };

  // ---------------------------------------------------------------- pages

  r.get('/studio', async (req, res) => {
    const [overview, list, counts, payout] = await Promise.all([
      ctx.analytics.channelOverview(req.user.id),
      ctx.videos.listByOwner(req.user.id, { limit: 5 }),
      ctx.videos.countByOwner(req.user.id),
      ctx.monetization ? ctx.monetization.payoutProfile(req.user.id) : null,
    ]);
    const steps = [
      { label: 'Confirm your email address', done: !!req.user.email_verified_at },
      { label: 'Accept the creator terms', done: creatorTermsAccepted(req.user, LEGAL_VERSION), href: '/studio/terms' },
      { label: 'Upload your first video', done: counts.ready > 0, href: '/studio/upload' },
      ...(ctx.monetization ? [{ label: 'Add payout details so tips can reach you', done: !!payout, href: '/studio/payouts' }] : []),
    ];
    const money = ctx.monetization ? await ctx.monetization.balances(req.user.id) : null;
    await res.page(v.studioDashboard(req, { overview, videos: list.items, steps: steps.every((s) => s.done) ? [] : steps, money }), { title: 'Studio', noindex: true });
  });

  r.get('/studio/videos', async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, 20);
    const { items, hasMore } = await ctx.videos.listByOwner(req.user.id, { limit: size, offset });
    await res.page(v.studioVideos(req, { items, hasMore, page }), { title: 'Your videos', noindex: true });
  });

  r.get('/studio/terms', (req, res) => res.page(v.creatorTermsPage(req, {}), { title: 'Creator terms', noindex: true }));
  r.post('/studio/terms', async (req, res) => {
    if (req.body.agree !== '1') return res.status(422).page(v.creatorTermsPage(req, { error: 'Tick the box to confirm, then continue.' }), { title: 'Creator terms', noindex: true });
    await ctx.db.query('UPDATE users SET creator_terms_version = $2, creator_terms_accepted_at = $3 WHERE id = $1', [req.user.id, LEGAL_VERSION, ctx.clock()]);
    await ctx.audit.record(req.user.id, 'creator.terms_accepted', { targetType: 'user', targetId: req.user.id, meta: { version: LEGAL_VERSION }, ip: req.ip });
    res.redirect(303, '/studio/upload');
  });

  r.get('/studio/upload', async (req, res) => {
    const gate = gateMessage(req.user);
    if (gate === null) return res.redirect(303, '/studio/terms');
    const remaining = Math.max(0, config.uploads.dailyLimit - (await ctx.videos.uploadsToday(req.user.id)));
    await res.page(v.studioUpload(req, { maxBytes: config.uploads.maxBytes, remainingToday: remaining, gate }), { title: 'Upload a video', noindex: true, scripts: ['js/upload.js'] });
  });

  r.get('/studio/videos/:id', async (req, res) => {
    const video = await owned(req);
    const stats = video.status === 'ready' ? await ctx.analytics.videoStats(video.id) : null;
    await res.page(v.studioEdit(req, { video, stats, saved: req.query.saved === '1' }), { title: 'Edit video', noindex: true, scripts: ['js/upload.js'] });
  });

  r.post('/studio/videos/:id', async (req, res) => {
    const video = await owned(req);
    if (video.status === 'removed') throw new HttpError(403, 'This video was removed and cannot be edited.');
    const { data, errors } = parseInput(videoMetaSchema, req.body);
    if (errors) {
      const values = { ...video, ...req.body, comments_enabled: req.body.comments_enabled === '1', has_paid_promotion: req.body.has_paid_promotion === '1' };
      return res.status(422).page(v.studioEdit(req, { video, values, errors }), { title: 'Edit video', noindex: true, scripts: ['js/upload.js'] });
    }
    await ctx.videos.update(video.id, data);
    res.redirect(303, `/studio/videos/${video.id}?saved=1`);
  });

  r.post('/studio/videos/:id/thumbnail', async (req, res) => {
    const video = await owned(req);
    const chosen = String(req.body.thumb ?? '');
    if (video.status !== 'ready' || !(video.poster_candidates ?? []).some((p) => p.name === chosen)) throw new HttpError(400, 'Choose one of the frames shown.');
    await ctx.videos.update(video.id, { thumb_kind: 'frame', thumb_name: chosen });
    res.redirect(303, `/studio/videos/${video.id}?saved=1`);
  });

  r.post('/studio/videos/:id/delete', async (req, res) => {
    const video = await owned(req);
    if (req.body.confirm !== '1') throw new HttpError(400, 'Tick the box to confirm the deletion.');
    await ctx.videos.deleteVideo(video.id);
    await ctx.audit.record(req.user.id, 'video.delete', { targetType: 'video', targetId: video.id, ip: req.ip });
    res.flash('success', 'Video deleted.');
    res.redirect(303, '/studio/videos');
  });

  // ---------------------------------------------------------------- upload API (used by public/js/upload.js)

  r.post('/api/studio/videos', requireVerified, uploadLimit, async (req, res) => {
    if (!creatorTermsAccepted(req.user, LEGAL_VERSION)) throw new HttpError(403, 'Accept the creator terms first.', { code: 'creator_terms' });
    const { data, errors } = parseInput(videoMetaSchema, req.body);
    if (errors) throw new ValidationError(errors);
    const draft = await ctx.videos.createDraft(req.user.id, data);
    res.status(201).json({ id: draft.id });
  });

  r.put('/api/studio/videos/:id/source', requireVerified, uploadLimit, async (req, res) => {
    const video = await owned(req);
    const out = await ctx.videos.receiveUpload(video, req);
    res.status(202).json({ status: 'processing', bytes: out.bytes });
  });

  r.get('/api/studio/videos/:id/status', async (req, res) => {
    const video = await owned(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: video.status, failReason: video.fail_reason, durationMs: video.duration_ms });
  });

  r.put('/api/studio/videos/:id/thumbnail', requireVerified, uploadLimit, express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
    const video = await owned(req);
    if (video.status !== 'ready') throw new HttpError(409, 'The video is not ready yet.');
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw new HttpError(400, 'Send an image file.');
    const dir = ctx.storage.ensureVideoDir(video.id);
    const tmp = path.join(dir, `upload-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, req.body, { mode: 0o600 });
    try {
      await processCustomThumbnail({ input: tmp, output: path.join(dir, 'custom.jpg') });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e instanceof Rejection) throw new HttpError(415, e.message);
      throw e;
    }
    await ctx.videos.update(video.id, { thumb_kind: 'custom', thumb_name: 'custom.jpg' });
    res.json({ ok: true });
  });

  return r;
}

export const studioMount = { attach: (app, ctx) => app.use(studioRoutes(ctx)) };
