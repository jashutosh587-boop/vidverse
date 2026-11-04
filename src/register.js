import { createJobService } from './services/jobs.js';
import { createVideoService } from './services/videos.js';
import { createPipeline } from './services/pipeline.js';
import { createMaintenance } from './services/maintenance.js';
import { createAnalyticsService } from './services/analytics.js';
import { createEngagementService } from './services/engagement.js';
import { createFeedService } from './services/feed.js';
import { createCommentService } from './services/comments.js';
import { createSearchService } from './services/search.js';
import { createModerationService } from './services/moderation.js';
import { createContentService } from './services/content.js';
import { createAccountService } from './services/accounts.js';
import { createPaymentProvider } from './services/payments/index.js';
import { createMonetizationService } from './services/monetization.js';
import { createRevenueService } from './services/revenue.js';
import { mediaMount } from './web/routes/media.js';
import { studioMount } from './web/routes/studio.js';
import { browseMount } from './web/routes/browse.js';
import { watchMount } from './web/routes/watch.js';
import { channelMount } from './web/routes/channel.js';
import { helpMount } from './web/routes/help.js';
import { settingsMount } from './web/routes/settings.js';
import { moneyMount, webhookMount } from './web/routes/money.js';
import { adminMount } from './web/routes/admin.js';

/**
 * Adds the remaining services and route groups to a context. Kept in one place so tests and the server
 * build exactly the same app.
 */
export function registerAll(ctx) {
  ctx.jobs = createJobService(ctx);
  ctx.videos = createVideoService(ctx);
  ctx.pipeline = createPipeline(ctx);
  ctx.pipeline.register(ctx.jobs);
  ctx.maintenance = createMaintenance(ctx);
  ctx.maintenance.register(ctx.jobs);

  ctx.analytics = createAnalyticsService(ctx);
  ctx.engagement = createEngagementService(ctx);
  ctx.feed = createFeedService(ctx);
  ctx.comments = createCommentService(ctx);
  ctx.search = createSearchService(ctx);
  ctx.moderation = createModerationService(ctx);
  ctx.content = createContentService(ctx);
  ctx.accounts = createAccountService(ctx);

  // Money: switched off (provider "off") means no tips, earnings or payouts, and the pages for them do not exist.
  ctx.paymentProvider = createPaymentProvider(ctx);
  ctx.monetization = ctx.paymentProvider ? createMonetizationService(ctx) : null;
  ctx.revenue = createRevenueService(ctx);

  ctx.extraRoutes = ctx.extraRoutes ?? [];
  ctx.extraRoutes.push(mediaMount, studioMount, watchMount, browseMount, channelMount, helpMount, settingsMount, moneyMount, webhookMount, adminMount);
  ctx.onClose = ctx.onClose ?? [];
  ctx.onClose.push(() => ctx.jobs.stop());

  // Start the background worker in this process unless it runs separately or is switched off.
  ctx.startWorker = () => {
    ctx.jobs.start();
    ctx.maintenance.schedule().catch(() => {});
    const t = setInterval(() => ctx.maintenance.schedule().catch(() => {}), 30 * 60_000);
    t.unref();
    ctx.onClose.push(() => clearInterval(t));
  };
}
