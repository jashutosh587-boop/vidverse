/**
 * Runs the background work (video processing, clean-up, scheduled jobs) without serving web pages.
 * Use it when the website runs with WORKER=separate, so a slow transcode never competes with page requests:
 *
 *     WORKER=separate npm start      # the website
 *     npm run worker                 # one or more of these, on the same DATABASE_URL and DATA_DIR
 *
 * It needs the real database (DATABASE_URL). The embedded development database belongs to one process.
 */
import { loadConfig, loadDotEnv, preflight, ConfigError } from './config.js';
import { createContext } from './context.js';
import { registerAll } from './register.js';

loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
if (!config.databaseUrl) {
  console.error('The worker needs DATABASE_URL: the embedded development database cannot be shared between two processes.\nFor local use, leave WORKER at its default (inprocess) and run only `npm start`.');
  process.exit(1);
}
const { errors, warnings } = preflight(config);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error(`Refusing to start in production:\n - ${errors.join('\n - ')}`);
  process.exit(1);
}

const ctx = await createContext(config, { register: [registerAll] });
ctx.startWorker();
ctx.log.info('worker started', { env: config.env });

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  ctx.log.info('worker shutting down', { signal });
  setTimeout(() => process.exit(1), 30_000).unref();
  await ctx.close(); // waits for the job in progress to finish
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => ctx.log.error('unhandled rejection', { err: e }));
