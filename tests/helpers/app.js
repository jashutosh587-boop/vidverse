import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/context.js';
import { createApp } from '../../src/app.js';
import { registerAll } from '../../src/register.js';
import { createClient } from './client.js';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export function makeClock(start = new Date('2026-11-04T10:00:00.000Z')) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms) => (t += ms), set: (d) => (t = new Date(d).getTime()) };
}

/**
 * With TEST_DATABASE_URL set (for example postgres://postgres@127.0.0.1:55432/postgres) every test app gets its own
 * freshly created database on that real Postgres server, through the same `pg` driver production uses, and the database
 * is dropped again when the app closes. Without it, the embedded in-memory database is used.
 */
export const REAL_POSTGRES = process.env.TEST_DATABASE_URL || '';

async function adminClient() {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: REAL_POSTGRES });
  await client.connect();
  return client;
}

async function createRealDatabase() {
  const name = `vv_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(REAL_POSTGRES);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropRealDatabase(name) {
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Boots the real app (real routes, real SQL on an in-memory database, or on real Postgres: see REAL_POSTGRES) on a free
 * local port. `env` overrides environment variables, `config` overrides parsed config, `ctx` overrides services.
 */
export async function startTestApp({ env = {}, config: configOverrides = {}, ctx: ctxOverrides = {}, clock = makeClock() } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-test-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const real = REAL_POSTGRES && !env.DATABASE_URL ? await createRealDatabase() : null;
  const config = loadConfig(
    { NODE_ENV: 'test', PORT: String(port), BASE_URL: baseUrl, DATA_DIR: dataDir, RATE_LIMITS: 'false', ...(real ? { DATABASE_URL: real.url, DATABASE_SSL: 'false' } : {}), ...env },
    configOverrides,
  );
  const ctx = await createContext(config, { clock: clock.now, register: [registerAll], ...ctxOverrides });
  const app = createApp(ctx, { extraRoutes: ctx.extraRoutes });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  return {
    ctx,
    config,
    clock,
    baseUrl,
    dataDir,
    engine: real ? 'postgres' : 'pglite',
    databaseUrl: real?.url ?? null,
    client: () => createClient(baseUrl),
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await ctx.close();
      if (real) await dropRealDatabase(real.name);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
