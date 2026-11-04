import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies every .sql file in name order, once each. Safe to run on every start. Returns the names applied now. */
export async function migrate(db, { log } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    const done = await db.one('SELECT 1 AS x FROM schema_migrations WHERE name = $1', [file]);
    if (done) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    await db.tx(async () => {
      // Two instances starting together: the second waits here, then finds the migration already applied.
      if (db.kind === 'pg') await db.query('SELECT pg_advisory_xact_lock(727274)');
      const again = await db.one('SELECT 1 AS x FROM schema_migrations WHERE name = $1', [file]);
      if (again) return;
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
    log?.info('migration applied', { file });
  }
  return applied;
}
