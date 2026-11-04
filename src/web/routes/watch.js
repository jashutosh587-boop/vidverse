import express from 'express';
import { z } from 'zod';
import { HttpError, notFound } from '../../lib/errors.js';
import { isVideoId } from '../../lib/ids.js';
import { html, safeLocalPath } from '../../lib/html.js';
import { cleanText, parseInput } from '../../lib/validate.js';
import { isoDuration } from '../../lib/format.js';
import { limit } from '../middleware/limit.js';
import { requireUser, requireVerified } from '../guards.js';
import { pageOf, plainText } from '../util.js';
import { adsAllowed, adsScripts } from '../views/ads.js';
import { watchPage, reportPage } from '../views/pages/watch.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMENT_ID = /^\d{1,18}$/;
const VOTES = new Map([['1', 1], ['-1', -1], ['0', 0]]);

const commentSchema = z.object({
  body: cleanText({ min: 1, max: 1000, multiline: true, label: 'Your comment' }),
  parent_id: z.string().regex(COMMENT_ID).optional(),
});

/** The watch page, the buttons under a video, comments, reports and view counting. */
export function watchRoutes(ctx) {
  const r = express.Router();
  const { config } = ctx;

  const actionLimit = limit(ctx, { name: 'action', limit: 120, windowMs: 60_000, key: (req) => req.user.id });
  const commentLimit = limit(ctx, { name: 'comment', limit: 20, windowMs: 3600_000, key: (req) => req.user.id });
  const reportLimit = limit(ctx, { name: 'report', limit: 10, windowMs: 3600_000, key: (req) => req.user.id });
  const userBeat = limit(ctx, { name: 'beat-user', limit: 60, windowMs: 60_000, key: (req) => req.user.id });
  const anonBeat = limit(ctx, { name: 'beat-anon', limit: 240, windowMs: 60_000 });

  /** Buttons work as plain forms and, with JavaScript, as fetch calls. The same route answers both. */
  const wantsJson = (req) => req.get('x-requested-with') === 'fetch' || req.accepts(['html', 'json']) === 'json';
  function actionUser(req, res, next) {
    if (req.user) return next();
    if (wantsJson(req)) return next(new HttpError(401, 'Sign in to continue.', { code: 'auth' }));
    return res.redirect(303, `/login?next=${encodeURIComponent(safeLocalPath(req.body?.next, '/'))}`);
  }
  function done(req, res, json, message) {
    if (wantsJson(req)) return res.json(json);
    if (message) res.flash('success', message);
    return res.redirect(303, safeLocalPath(req.body?.next, '/'));
  }
  const videoIdOf = (value) => {
    const id = String(value ?? '');
    if (!isVideoId(id)) throw new HttpError(400, 'We could not tell which video you meant.');
    return id;
  };
  const channelIdOf = (value) => {
    const id = String(value ?? '');
    if (!UUID.test(id)) throw new HttpError(400, 'We could not tell which channel you meant.');
    return id;
  };

  // ------------------------------------------------------------------ the watch page

  r.get('/watch/:id', async (req, res) => {
    if (!isVideoId(req.params.id)) throw notFound('We could not find that video.');
    const video = await ctx.videos.getVisible(req.params.id, req.user);
    const isOwner = req.user?.id === video.owner_id;
    if (video.status !== 'ready') {
      if (isOwner) return res.redirect(303, `/studio/videos/${video.id}`);
      throw notFound('We could not find that video.');
    }

    const { page: cpage, limit: csize, offset: coffset } = pageOf({ query: { page: req.query.cpage } }, 20);
    const threadId = typeof req.query.replies === 'string' && COMMENT_ID.test(req.query.replies) ? req.query.replies : null;
    const [related, subscribers, subscription, myVote, saved, resume, comments, thread, tipsEnabled] = await Promise.all([
      ctx.feed.related(video, { limit: 12 }),
      ctx.engagement.subscriberCount(video.owner_id),
      req.user ? ctx.engagement.subscription(req.user.id, video.owner_id) : null,
      req.user ? ctx.engagement.myVote(req.user.id, video.id) : 0,
      req.user ? ctx.engagement.isSaved(req.user.id, video.id) : false,
      req.user ? ctx.engagement.resumePosition(req.user.id, video.id) : 0,
      video.comments_enabled && !threadId ? ctx.comments.list(video.id, { offset: coffset, limit: csize }) : { items: [], hasMore: false },
      threadId ? ctx.comments.thread(video.id, threadId) : null,
      ctx.monetization ? ctx.monetization.tipsAvailable(video.owner_id) : false,
    ]);

    const t = Number.parseInt(String(req.query.t ?? ''), 10);
    const startAt = Number.isInteger(t) && t > 0 && t * 1000 < video.duration_ms ? t : null;
    const ads = adsAllowed(config, video, req.user);
    const isPublic = video.visibility === 'public';
    const canComment = !!req.user && !!req.user.email_verified_at && video.comments_enabled;
    const here = encodeURIComponent(`/watch/${video.id}`);
    const commentGate = req.user ? 'Confirm your email address to comment.' : html`<a href="/login?next=${here}">Sign in</a> to join the conversation.`;
    const description = (video.description || `${video.title}, a video by ${video.channel_name}.`).replace(/\s+/g, ' ').slice(0, 160);
    const baseUrl = config.baseUrl;

    await res.page(
      watchPage(req, {
        video, related, subscribers, subscribed: !!subscription, notify: !!subscription?.notify, myVote, saved, resume,
        comments, thread, cpage, next: related[0] ?? null, ads, tipsEnabled, startAt, canComment, commentGate,
        autoplay: req.user ? req.user.autoplay : true, config, now: ctx.clock(),
      }),
      {
        title: video.title,
        description,
        canonical: isPublic ? `/watch/${video.id}` : undefined,
        noindex: !isPublic,
        ogImage: isPublic ? `/media/t/${video.id}.jpg` : undefined,
        ogType: 'video.other',
        jsonLd: isPublic
          ? {
              '@context': 'https://schema.org',
              '@type': 'VideoObject',
              name: video.title,
              description,
              thumbnailUrl: [`${baseUrl}/media/t/${video.id}.jpg`],
              uploadDate: new Date(video.published_at ?? video.created_at).toISOString(),
              duration: isoDuration(video.duration_ms),
              interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: video.views },
            }
          : undefined,
        ads,
        head: ads ? adsScripts(config, res.locals.nonce) : undefined,
        scripts: ['vendor/hls.min.js', 'js/player.js', ...(ads ? ['js/ads.js'] : [])],
        bodyClass: 'watching',
      },
    );
  });

  // ------------------------------------------------------------------ counting views

  /** Called by the player every ten seconds or so. The server decides how much of the claimed time to believe. */
  r.post('/api/videos/:id/heartbeat', (req, res, next) => (req.user ? userBeat : anonBeat)(req, res, next), async (req, res) => {
    const video = await ctx.videos.getVisible(videoIdOf(req.params.id), req.user);
    const num = (x, max) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
    };
    await ctx.analytics.recordHeartbeat({
      video,
      userId: req.user?.id ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? '',
      positionMs: num(req.body?.position, video.duration_ms ?? 0),
      deltaMs: num(req.body?.delta, 60_000),
    });
    res.status(204).end();
  });

  // ------------------------------------------------------------------ buttons under the video

  r.post('/actions/vote', actionUser, actionLimit, async (req, res) => {
    const id = videoIdOf(req.body.video);
    const value = VOTES.get(String(req.body.value));
    if (value === undefined) throw new HttpError(400, 'That vote was not understood.');
    const video = await ctx.videos.getVisible(id, req.user);
    if (video.status !== 'ready') throw notFound('We could not find that video.');
    if (video.owner_id === req.user.id) throw new HttpError(400, 'You cannot rate your own video.');
    const c = await ctx.engagement.vote(req.user.id, id, value);
    return done(req, res, { likes: c.likes, dislikes: c.dislikes, mine: c.mine });
  });

  r.post('/actions/save', actionUser, actionLimit, async (req, res) => {
    const id = videoIdOf(req.body.video);
    const on = req.body.on === '1';
    if (on) {
      const video = await ctx.videos.getVisible(id, req.user);
      if (video.status !== 'ready') throw notFound('We could not find that video.');
      await ctx.engagement.saveForLater(req.user.id, id);
    } else {
      await ctx.engagement.removeSaved(req.user.id, id);
    }
    return done(req, res, { saved: on }, on ? 'Saved to Watch later.' : 'Removed from Watch later.');
  });

  r.post('/actions/subscribe', actionUser, actionLimit, async (req, res) => {
    const channel = channelIdOf(req.body.channel);
    const on = req.body.on === '1';
    if (on) await ctx.engagement.subscribe(req.user.id, channel);
    else await ctx.engagement.unsubscribe(req.user.id, channel);
    const subscribers = await ctx.engagement.subscriberCount(channel);
    return done(req, res, { subscribed: on, notify: false, subscribers }, on ? 'Subscribed. Turn on the bell if you want to hear about new videos.' : 'Unsubscribed.');
  });

  r.post('/actions/notify', actionUser, actionLimit, async (req, res) => {
    const channel = channelIdOf(req.body.channel);
    const on = req.body.on === '1';
    if (!(await ctx.engagement.subscription(req.user.id, channel))) throw new HttpError(400, 'Subscribe to the channel first.');
    await ctx.engagement.setNotify(req.user.id, channel, on);
    return done(req, res, { notify: on }, on ? 'You will be notified about new videos from this channel.' : 'Notifications for this channel are off.');
  });

  r.post('/api/preferences/autoplay', requireUser, actionLimit, async (req, res) => {
    const on = req.body?.on === true || req.body?.on === '1';
    await ctx.db.query('UPDATE users SET autoplay = $2 WHERE id = $1', [req.user.id, on]);
    res.json({ autoplay: on });
  });

  // ------------------------------------------------------------------ comments

  r.post('/videos/:id/comments', requireVerified, commentLimit, async (req, res) => {
    const video = await ctx.videos.getVisible(videoIdOf(req.params.id), req.user);
    const bounce = (type, text, hash = '#comments') => {
      res.flash(type, text);
      res.redirect(303, `/watch/${video.id}${hash}`);
    };
    const { data, errors } = parseInput(commentSchema, req.body);
    if (errors) return bounce('error', errors.body ?? 'Write a comment first.');
    let id;
    try {
      id = await ctx.comments.add({ user: req.user, video, body: data.body, parentId: data.parent_id ?? null });
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return bounce('error', e.message);
      throw e;
    }
    res.flash('success', 'Comment posted.');
    if (data.parent_id) return res.redirect(303, `/watch/${video.id}?replies=${data.parent_id}#c-${id}`);
    return res.redirect(303, `/watch/${video.id}#c-${id}`);
  });

  r.post('/comments/:id/delete', requireUser, async (req, res) => {
    if (!COMMENT_ID.test(req.params.id)) throw notFound('We could not find that comment.');
    const videoId = await ctx.comments.remove(req.params.id, req.user);
    res.flash('success', 'Comment removed.');
    res.redirect(303, `/watch/${videoId}#comments`);
  });

  // ------------------------------------------------------------------ reports

  async function reportTarget(type, id, viewer) {
    if (type === 'video') {
      if (!isVideoId(id)) return null;
      const v = await ctx.videos.getVisible(id, viewer);
      return { label: v.title, back: `/watch/${v.id}` };
    }
    if (type === 'comment') {
      if (!COMMENT_ID.test(id)) return null;
      const c = await ctx.db.one(`SELECT id, video_id, left(body, 120) AS snippet FROM comments WHERE id = $1 AND status = 'visible'`, [id]);
      if (!c) return null;
      await ctx.videos.getVisible(c.video_id, viewer);
      return { label: `a comment: "${c.snippet}"`, back: `/watch/${c.video_id}#c-${c.id}` };
    }
    if (type === 'user') {
      if (!UUID.test(id)) return null;
      const u = await ctx.db.one(`SELECT handle, display_name FROM users WHERE id = $1 AND status = 'active'`, [id]);
      return u ? { label: `${u.display_name} (@${u.handle})`, back: `/@${u.handle}` } : null;
    }
    return null;
  }

  r.get('/report', requireUser, async (req, res) => {
    const type = plainText(req.query.type, 10);
    const id = plainText(req.query.id, 40);
    const target = await reportTarget(type, id, req.user);
    if (!target) throw notFound('We could not find what you wanted to report.');
    await res.page(reportPage(req, { type, id, label: target.label }), { title: 'Report', noindex: true });
  });

  r.post('/report', requireUser, reportLimit, async (req, res) => {
    const type = plainText(req.body.type, 10);
    const id = plainText(req.body.id, 40);
    const target = await reportTarget(type, id, req.user);
    if (!target) throw notFound('We could not find what you wanted to report.');
    if (type === 'user' && id === req.user.id) throw new HttpError(400, 'You cannot report yourself.');
    await ctx.moderation.report({ reporterId: req.user.id, targetType: type, targetId: id, reason: plainText(req.body.reason, 30), details: plainText(req.body.details, 1000).trim() });
    res.flash('success', 'Thank you. A moderator will look at this. We do not tell the person you reported.');
    res.redirect(303, target.back);
  });

  return r;
}

export const watchMount = { attach: (app, ctx) => app.use(watchRoutes(ctx)) };
