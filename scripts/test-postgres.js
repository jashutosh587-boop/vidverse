// Runs the whole test suite against a real PostgreSQL server instead of the embedded in-memory database.
//
//   TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:postgres
//
// Use a throwaway server, never the one that holds real data. Each test app creates its own database named
// vv_test_<number>_<random> on that server, and drops it again when it closes. The user in the URL must be allowed to
// CREATE DATABASE. Without this run, the tests in tests/concurrency.test.js are skipped, because the embedded
// database has a single connection and can never show a race.
import { spawn } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('Set TEST_DATABASE_URL to a throwaway PostgreSQL server, for example:');
  console.error('  TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:postgres');
  process.exit(2);
}
try {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('not a postgres:// URL');
  console.error(`Running the tests against ${u.hostname}:${u.port || 5432} as ${decodeURIComponent(u.username) || '(default user)'}. Each test creates and drops its own database.`);
} catch (e) {
  console.error(`TEST_DATABASE_URL is not usable: ${e.message}`);
  process.exit(2);
}

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', 'tests/**/*.test.js'], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
