/** Hourly housekeeping, run as a job so it happens once even with several workers. */
export function createMaintenance(ctx) {
  const { db, clock, log } = ctx;
  return {
    register(jobs) {
      jobs.register('maintenance', async () => {
        const now = clock();
        const sessions = await ctx.sessions.purgeExpired();
        const tokens = (await db.query(`DELETE FROM email_tokens WHERE expires_at < $1`, [new Date(now.getTime() - 7 * 86400_000)])).rowCount;
        const views = (await db.query(`DELETE FROM video_view_days WHERE day < $1::date`, [new Date(now.getTime() - 400 * 86400_000).toISOString().slice(0, 10)])).rowCount;
        const watchDays = (await db.query(`DELETE FROM user_watch_days WHERE day < $1::date`, [new Date(now.getTime() - 400 * 86400_000).toISOString().slice(0, 10)])).rowCount;
        const notes = await ctx.notifications.purgeOld(90);
        const videos = await ctx.videos.cleanup();
        const expiredTips = ctx.monetization ? await ctx.monetization.expireStale() : 0;
        const doneJobs = (await db.query(`DELETE FROM jobs WHERE status = 'done' AND finished_at < $1`, [new Date(now.getTime() - 14 * 86400_000)])).rowCount;
        await jobs_recover(ctx);
        log.info('maintenance', { sessions, tokens, views, watchDays, notes, videos, expiredTips, doneJobs });
      });
    },
    /** Enqueue this hour's run (deduplicated, so any number of workers calling it is fine). */
    async schedule() {
      const now = clock();
      await ctx.jobs.enqueue('maintenance', {}, { dedupeKey: `maintenance:${now.toISOString().slice(0, 13)}` });
    },
  };
}

async function jobs_recover(ctx) {
  await ctx.jobs.recoverStuck();
}
