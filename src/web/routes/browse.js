import express from 'express';
import { HttpError } from '../../lib/errors.js';
import { isVideoId } from '../../lib/ids.js';
import { safeLocalPath } from '../../lib/html.js';
import { CATEGORY_IDS, categoryLabel } from '../../lib/video-meta.js';
import { limit } from '../middleware/limit.js';
import { requireUser } from '../guards.js';
import { pageOf, plainText } from '../util.js';
import * as v from '../views/pages/browse.js';

const PAGE = 24;
const SORTS = new Set(['relevance', 'new', 'views']);
const categoryOf = (req) => (typeof req.query.category === 'string' && CATEGORY_IDS.includes(req.query.category) ? req.query.category : null);

/** Home, trending, search, and the signed-in member's own lists. */
export function browseRoutes(ctx) {
  const r = express.Router();
  const searchLimit = limit(ctx, { name: 'search', limit: 120, windowMs: 60_000 });
  const suggestLimit = limit(ctx, { name: 'suggest', limit: 300, windowMs: 60_000 });

  r.get('/', async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const category = categoryOf(req);
    const [feed, continueWatching] = await Promise.all([
      ctx.feed.home(req.user?.id ?? null, { category, limit: size, offset }),
      req.user && page === 1 && !category ? ctx.engagement.continueWatching(req.user.id) : [],
    ]);
    // A video already shown under "Continue watching" is not repeated in the main list.
    const shown = new Set(continueWatching.map((c) => c.id));
    feed.items = feed.items.filter((item) => !shown.has(item.id));
    await res.page(v.homePage(req, { feed, page, category, continueWatching, now: ctx.clock() }), {
      title: category ? categoryLabel(category) : undefined,
      canonical: category || page > 1 ? undefined : '/',
    });
  });

  r.get('/trending', async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const category = categoryOf(req);
    const feed = await ctx.feed.trending({ category, limit: size, offset });
    await res.page(v.trendingPage(req, { feed, page, category, now: ctx.clock() }), { title: 'Trending', description: 'Videos people are watching right now.' });
  });

  r.get('/results', searchLimit, async (req, res) => {
    const q = plainText(req.query.q, 100).trim();
    const sort = typeof req.query.sort === 'string' && SORTS.has(req.query.sort) ? req.query.sort : 'relevance';
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const [channels, videos] = q
      ? await Promise.all([page === 1 ? ctx.search.channels(q) : [], ctx.search.videos(q, { sort, limit: size, offset })])
      : [[], { items: [], hasMore: false }];
    await res.page(v.resultsPage(req, { q, sort, channels, videos, page, now: ctx.clock() }), { title: q ? `Results for ${q}` : 'Search', noindex: true, query: q });
  });

  r.get('/api/suggest', suggestLimit, async (req, res) => {
    const items = await ctx.search.suggest(plainText(req.query.q, 100));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({ items });
  });

  // ---- signed-in lists ----

  r.get('/subscriptions', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const [channels, feed] = await Promise.all([ctx.engagement.subscribedChannels(req.user.id), ctx.engagement.subscriptionFeed(req.user.id, { limit: size, offset })]);
    await res.page(v.subscriptionsPage(req, { channels, feed, page, now: ctx.clock() }), { title: 'Subscriptions', noindex: true });
  });

  r.get('/history', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const [feed, week, today] = await Promise.all([
      ctx.engagement.listHistory(req.user.id, { limit: size, offset }),
      ctx.analytics.watchTimeByDay(req.user.id, 7),
      ctx.analytics.todayWatchMs(req.user.id),
    ]);
    await res.page(v.historyPage(req, { feed, page, week, today, now: ctx.clock() }), { title: 'Watch history', noindex: true });
  });

  const back = (req, fallback) => safeLocalPath(req.body?.next, fallback);

  r.post('/history/clear', requireUser, async (req, res) => {
    await ctx.engagement.clearHistory(req.user.id);
    res.flash('success', 'Your watch history is cleared.');
    res.redirect(303, '/history');
  });

  r.post('/history/remove', requireUser, async (req, res) => {
    if (!isVideoId(req.body.video)) throw new HttpError(400, 'We could not tell which video to remove.');
    await ctx.engagement.removeFromHistory(req.user.id, req.body.video);
    res.redirect(303, back(req, '/history'));
  });

  r.get('/watch-later', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const feed = await ctx.engagement.listSaved(req.user.id, { limit: size, offset });
    await res.page(v.watchLaterPage(req, { feed, page, now: ctx.clock() }), { title: 'Watch later', noindex: true });
  });

  r.get('/liked', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, PAGE);
    const feed = await ctx.engagement.listLiked(req.user.id, { limit: size, offset });
    await res.page(v.likedPage(req, { feed, page, now: ctx.clock() }), { title: 'Liked videos', noindex: true });
  });

  r.get('/notifications', requireUser, async (req, res) => {
    const { page, limit: size, offset } = pageOf(req, 30);
    const { items, hasMore } = await ctx.notifications.list(req.user.id, { limit: size, offset });
    await res.page(v.notificationsPage(req, { items, hasMore, page, config: ctx.config, now: ctx.clock() }), { title: 'Notifications', noindex: true });
  });

  r.post('/notifications/read', requireUser, async (req, res) => {
    await ctx.notifications.markAllRead(req.user.id);
    res.redirect(303, '/notifications');
  });

  return r;
}

export const browseMount = { attach: (app, ctx) => app.use(browseRoutes(ctx)) };
