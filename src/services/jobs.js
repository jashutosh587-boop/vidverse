import { randomToken } from '../lib/crypto.js';

/**
 * A small durable job queue in the database. Jobs survive restarts, failed jobs retry with growing delays,
 * and several workers can run at once (FOR UPDATE SKIP LOCKED hands each job to exactly one of them).
 */
export function createJobService(ctx) {
  const { db, clock, log } = ctx;
  const handlers = new Map();
  const workerId = `${process.pid}-${randomToken(3)}`;
  let timer = null;
  let running = false;
  let stopping = false;

  const api = {
    register(kind, fn) {
      handlers.set(kind, fn);
    },

    /** Returns the job id, or null when a job with the same dedupe key already exists. */
    async enqueue(kind, payload = {}, { runAfter = null, dedupeKey = null, maxAttempts = 3 } = {}) {
      const row = await db.one(
        `INSERT INTO jobs (kind, payload, run_after, dedupe_key, max_attempts) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [kind, JSON.stringify(payload), runAfter ?? clock(), dedupeKey, maxAttempts],
      );
      return row?.id ?? null;
    },

    async claim() {
      const now = clock();
      return db.one(
        `UPDATE jobs SET status = 'running', locked_at = $1, locked_by = $2, attempts = attempts + 1
          WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= $1 ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING id, kind, payload, attempts, max_attempts`,
        [now, workerId],
      );
    },

    /** Runs one job if there is one. Returns true when it ran something (successfully or not). */
    async runOne() {
      const job = await api.claim();
      if (!job) return false;
      const handler = handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
        await handler(job.payload, job);
        await db.query(`UPDATE jobs SET status = 'done', finished_at = $2, last_error = NULL WHERE id = $1`, [job.id, clock()]);
      } catch (e) {
        const message = String(e?.message ?? e).slice(0, 500);
        log.error('job failed', { kind: job.kind, id: job.id, attempt: job.attempts, err: e });
        if (job.attempts >= job.max_attempts) {
          await db.query(`UPDATE jobs SET status = 'failed', finished_at = $2, last_error = $3 WHERE id = $1`, [job.id, clock(), message]);
          const onFail = handlers.get(`${job.kind}:failed`);
          if (onFail) await onFail(job.payload, job, e).catch((err) => log.error('failure handler failed', { err }));
        } else {
          const delayMs = 30_000 * job.attempts ** 2;
          await db.query(`UPDATE jobs SET status = 'queued', locked_at = NULL, run_after = $2, last_error = $3 WHERE id = $1`, [job.id, new Date(clock().getTime() + delayMs), message]);
        }
      }
      return true;
    },

    /** Runs jobs until the queue is empty (tests and one-off scripts). */
    async drain(max = 200) {
      let n = 0;
      while (n < max && (await api.runOne())) n++;
      return n;
    },

    /** Puts jobs whose worker died back in the queue. */
    async recoverStuck(olderThanMs = 30 * 60_000) {
      const cutoff = new Date(clock().getTime() - olderThanMs);
      const r = await db.query(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < $1`, [cutoff]);
      return r.rowCount;
    },

    async stats() {
      const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    async recentFailures(limit = 20) {
      const { rows } = await db.query(`SELECT id, kind, payload, attempts, last_error, finished_at FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT $1`, [limit]);
      return rows;
    },

    async retry(id) {
      const r = await db.query(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = $2, last_error = NULL WHERE id = $1 AND status = 'failed'`, [id, clock()]);
      return r.rowCount === 1;
    },

    /** Polls for work. Safe to call once per process. */
    start({ intervalMs = 1000 } = {}) {
      if (timer || stopping) return;
      const tick = async () => {
        if (stopping) return;
        if (running) return schedule();
        running = true;
        try {
          while (!stopping && (await api.runOne())) { /* keep going while there is work */ }
        } catch (e) {
          log.error('worker loop error', { err: e });
        } finally {
          running = false;
        }
        schedule();
      };
      const schedule = () => {
        if (stopping) return;
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      };
      api.recoverStuck().catch(() => {});
      schedule();
    },

    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const until = Date.now() + 20_000;
      while (running && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    },
  };
  return api;
}
