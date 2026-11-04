import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A tiny database layer with one API over two engines:
 *   - Postgres through `pg` (production),
 *   - PGlite, Postgres compiled to WebAssembly (development and tests; no install needed).
 *
 * db.query(sql, params)  -> { rows, rowCount }
 * db.one(sql, params)    -> first row or null
 * db.tx(fn)              -> runs fn in a transaction. Any db.query made while fn runs (even in
 *                           helper functions that know nothing about the transaction) joins it.
 * db.exec(sql)           -> several statements at once (migrations)
 */
const ambient = new AsyncLocalStorage();

// int8 as a JS number (money in minor units and counters stay far below 2^53), date as 'YYYY-MM-DD'.
const INT8 = 20;
const DATE = 1082;
const parseInt8 = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint outside the safe integer range');
  return n;
};

function wrap(engine, raw) {
  const current = () => ambient.getStore()?.client ?? null;
  const api = {
    kind: engine,
    async query(sql, params = []) {
      const client = current();
      const res = await (client ?? raw).query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.affectedRows ?? res.rows.length };
    },
    async one(sql, params = []) {
      const { rows } = await api.query(sql, params);
      return rows[0] ?? null;
    },
    async exec(sql) {
      const client = current();
      if (engine === 'pglite') await (client ?? raw).exec(sql);
      else await (client ?? raw).query(sql);
    },
    async tx(fn) {
      if (current()) return fn(); // already inside a transaction: join it
      return raw.transaction((client) => ambient.run({ client }, fn));
    },
    close: () => raw.close(),
  };
  return api;
}

async function createPglite(config) {
  const { PGlite, types } = await import('@electric-sql/pglite').catch(() => {
    throw new Error('The embedded development database needs the dev dependencies (npm install). In production set DATABASE_URL.');
  });
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const pg = new PGlite(config.pgliteDir, {
    extensions: { pg_trgm },
    parsers: { [types?.INT8 ?? INT8]: parseInt8, [types?.DATE ?? DATE]: (v) => v },
  });
  await pg.waitReady;
  await pg.exec("SET TIME ZONE 'UTC'");
  const raw = {
    query: (sql, params) => pg.query(sql, params),
    exec: (sql) => pg.exec(sql),
    close: () => pg.close(),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p), exec: (s) => tx.exec(s) })),
  };
  return wrap('pglite', raw);
}

async function createPg(config) {
  const pgModule = await import('pg');
  const pg = pgModule.default ?? pgModule;
  pg.types.setTypeParser(INT8, parseInt8);
  pg.types.setTypeParser(DATE, (v) => v);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== '1' } : undefined,
    options: '-c timezone=UTC -c statement_timeout=30000',
  });
  pool.on('error', () => {}); // an idle client dying must not crash the process; the next query reconnects
  const raw = {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (s, p) => client.query(s, p), exec: (s) => client.query(s) });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
  return wrap('pg', raw);
}

export async function createDb(config) {
  return config.databaseUrl ? createPg(config) : createPglite(config);
}
