#!/usr/bin/env node
/**
 * Applies database migrations and exits. The site also does this on start-up; run this by itself when a
 * deploy pipeline should change the database before the new version starts:
 *
 *     npm run migrate
 */
import { loadConfig, loadDotEnv, ConfigError } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

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
const db = await createDb(config);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply: the database is up to date.');
} finally {
  await db.close();
}
