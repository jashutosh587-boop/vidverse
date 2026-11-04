/**
 * The website as the browser tests see it: the real routes, real SQL (the embedded Postgres, in memory),
 * the real ffmpeg worker, practice payments, and two extra routes under /__e2e/ so a test can read the
 * "sent" emails and make someone a moderator. It refuses to start in production and listens on loopback only.
 *
 *     E2E_PORT=4173 node e2e/server.mjs        # E2E_ADS=1 also switches the AdSense slots on
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { registerAll } from '../src/register.js';

if (process.env.NODE_ENV === 'production') throw new Error('The browser-test server must never run in production.');

const port = Number(process.env.E2E_PORT ?? 4173);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-e2e-'));

const env = {
  NODE_ENV: 'test',
  PORT: String(port),
  BASE_URL: baseUrl,
  DATA_DIR: dataDir,
  PGLITE_DIR: 'memory://',
  PAYMENTS_PROVIDER: 'test',
  TRANSCODE_PROFILE: 'standard', // the real ladder (720p, 480p, 360p), so quality switching can be tried
  LOG_LEVEL: process.env.E2E_LOG ?? 'warn',
  // Rate limits stay ON: the journeys should work without ever tripping them.
};
if (process.env.E2E_ADS === '1') {
  Object.assign(env, { ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT_WATCH_TOP: '1111111111', ADSENSE_SLOT_WATCH_SIDE: '2222222222' });
}

const config = loadConfig(env);
const ctx = await createContext(config, { register: [registerAll] });

ctx.extraRoutes.push({
  beforeSession: true,
  attach(app) {
    app.get('/__e2e/outbox', (req, res) => {
      const to = String(req.query.to ?? '').toLowerCase();
      res.set('Cache-Control', 'no-store').json(ctx.mailer.sent.filter((m) => !to || String(m.to).toLowerCase() === to));
    });
    // A stand-in for "another website" that tries to put the site in a frame. It must be a real local server (not an intercepted
    // page) or Chrome's protection for local networks blocks the frame before the site's own headers are even looked at.
    app.get('/__e2e/attacker/frame', (req, res) => {
      const target = String(req.query.target ?? '').replace(/[^\w:/.%?=&-]/g, '');
      res.set({ 'Content-Security-Policy': "default-src 'none'; frame-src *", 'Cache-Control': 'no-store' }).type('html').send(`<!doctype html><iframe id="victim" src="${target}" width="600" height="400"></iframe>`);
    });
    app.post('/__e2e/promote', async (req, res) => {
      const email = String(req.query.email ?? '').toLowerCase();
      const role = req.query.role === 'admin' ? 'admin' : 'moderator';
      const r = await ctx.db.query(`UPDATE users SET role = $2 WHERE lower(email) = $1`, [email, role]);
      res.json({ updated: r.rowCount ?? r.affectedRows ?? 0 });
    });
  },
});

const app = createApp(ctx, { extraRoutes: ctx.extraRoutes });
ctx.startWorker();
const server = app.listen(port, '127.0.0.1', () => console.log(`e2e server ready at ${baseUrl}`));

async function stop() {
  server.close();
  server.closeAllConnections?.();
  await ctx.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
