import { loadConfig, loadDotEnv, preflight, ConfigError } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
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
const { errors, warnings } = preflight(config);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error(`Refusing to start in production:\n - ${errors.join('\n - ')}`);
  process.exit(1);
}

const ctx = await createContext(config, { register: [registerAll] });
const app = createApp(ctx, { extraRoutes: ctx.extraRoutes ?? [] });
if (config.worker === 'inprocess') ctx.startWorker();
const server = app.listen(config.port, config.host, () => {
  ctx.log.info('listening', { url: config.baseUrl, host: config.host, port: config.port, env: config.env });
});
server.requestTimeout = 60 * 60_000; // long enough for a large upload on a slow line; the reverse proxy should bound it further
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  ctx.log.info('shutting down', { signal });
  server.close();
  setTimeout(() => process.exit(1), 15_000).unref();
  await ctx.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => ctx.log.error('unhandled rejection', { err: e }));
