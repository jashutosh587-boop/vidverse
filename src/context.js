import { createLogger } from './lib/logger.js';
import { createLimiter } from './lib/rate-limit.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createMailer } from './services/mailer.js';
import { createStorage } from './services/storage.js';
import { createSessionService } from './services/sessions.js';
import { createAuditService } from './services/audit.js';
import { createAuthService } from './services/auth.js';
import { createNotificationService } from './services/notifications.js';

/**
 * Builds everything the app needs and wires the services together. Services reach each other through
 * `ctx` at call time, so the order below does not matter. Tests pass `overrides` (clock, mailer, fetch ...).
 */
export async function createContext(config, overrides = {}) {
  const log = overrides.log ?? createLogger({ level: config.logLevel });
  const db = overrides.db ?? (await createDb(config));
  await migrate(db, { log });

  const ctx = {
    config,
    log,
    db,
    clock: overrides.clock ?? (() => new Date()),
    limiter: overrides.limiter ?? createLimiter({ enabled: config.limits.enabled }),
    fetch: overrides.fetch ?? globalThis.fetch,
  };
  ctx.mailer = overrides.mailer ?? createMailer(config, log);
  ctx.storage = overrides.storage ?? createStorage(config);
  ctx.sessions = createSessionService(ctx);
  ctx.audit = createAuditService(ctx);
  ctx.auth = createAuthService(ctx);
  ctx.notifications = createNotificationService(ctx);

  for (const register of overrides.register ?? []) register(ctx);
  ctx.close = async () => {
    for (const fn of ctx.onClose ?? []) await fn();
    await db.close();
  };
  return ctx;
}
