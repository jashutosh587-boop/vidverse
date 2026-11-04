import express from 'express';
import { notFound } from '../../lib/errors.js';
import { pageOf } from '../util.js';
import { channelVideosPage, channelAboutPage, supportLinks } from '../views/pages/channel.js';

/** Public channel pages: /@handle and /@handle/about. */
export function channelRoutes(ctx) {
  const r = express.Router();

  async function load(req) {
    const handle = String(req.params.handle ?? '').toLowerCase();
    const channel = await ctx.db.one(
      `SELECT id, handle, display_name, bio, avatar_hue, support_links, created_at
         FROM users WHERE handle = $1 AND status = 'active'`,
      [handle],
    );
    if (!channel) throw notFound('We could not find that channel.');
    const isOwner = req.user?.id === channel.id;
    const [subscribers, counts, subscription, tipsEnabled] = await Promise.all([
      ctx.engagement.subscriberCount(channel.id),
      ctx.db.one(`SELECT count(*)::int AS videos, COALESCE(sum(views), 0)::bigint AS views FROM videos v WHERE v.owner_id = $1 AND v.status = 'ready' AND v.visibility = 'public'`, [channel.id]),
      req.user && !isOwner ? ctx.engagement.subscription(req.user.id, channel.id) : null,
      ctx.monetization ? ctx.monetization.tipsAvailable(channel.id) : false,
    ]);
    return {
      channel,
      isOwner,
      subscribers,
      videoCount: counts.videos,
      totalViews: counts.views,
      subscribed: !!subscription,
      notify: !!subscription?.notify,
      tipsEnabled,
      now: ctx.clock(),
    };
  }

  const pageMeta = (p, suffix = '') => ({
    title: `${p.channel.display_name}${suffix}`,
    description: p.channel.bio ? p.channel.bio.replace(/\s+/g, ' ').slice(0, 160) : `Videos by ${p.channel.display_name} on ${ctx.config.siteName}.`,
    canonical: `/@${p.channel.handle}${suffix ? '/about' : ''}`,
    noindex: p.videoCount === 0,
  });

  r.get('/@:handle', async (req, res) => {
    const p = await load(req);
    const { page, limit: size, offset } = pageOf(req, 24);
    const sort = req.query.sort === 'popular' ? 'popular' : 'new';
    const videos = await ctx.videos.listChannel(p.channel.id, { sort, limit: size, offset });
    await res.page(channelVideosPage(req, { ...p, videos, page, sort }), { ...pageMeta(p), canonical: page > 1 || sort !== 'new' ? undefined : `/@${p.channel.handle}` });
  });

  r.get('/@:handle/about', async (req, res) => {
    const p = await load(req);
    await res.page(channelAboutPage(req, { ...p, joined: p.channel.created_at, links: supportLinks(p.channel.support_links) }), pageMeta(p, ' - About'));
  });

  return r;
}

export const channelMount = { attach: (app, ctx) => app.use(channelRoutes(ctx)) };
