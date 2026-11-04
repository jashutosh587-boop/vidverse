#!/usr/bin/env node
/**
 * "Break it on purpose." A test suite is only worth trusting if it fails when a defence is removed. This script
 * removes one defence at a time (the list is in scripts/break-it.json), runs the tests that ought to notice, reports
 * whether they did, and then puts every file back exactly as it was and checks the bytes.
 *
 *     node scripts/break-it.js --list              # what can be broken
 *     node scripts/break-it.js csrf-token          # break one thing
 *     node scripts/break-it.js --all               # break each in turn (the Postgres ones need TEST_DATABASE_URL)
 *
 * Do not run it while anything else is using the source files (another test run, `npm run dev`): for a few seconds the
 * code on disk is deliberately wrong. It restores each file in a `finally` block and when interrupted, then compares the
 * bytes with the original. If it is ever killed hard (kill -9, power loss), copies of the originals are kept in a folder
 * under the system temp directory named vidverse-break-it-<name>-<random>.
 *
 * Exit status: 0 when every result matched what is written in the catalog ("caught" or "survives" or "varies"),
 * 1 when one did not, 3 when a file could not be restored (stop and look at it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'break-it.json'), 'utf8'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

const args = process.argv.slice(2);
if (args.includes('--list') || args.length === 0) {
  for (const m of CATALOG) console.log(`${m.name.padEnd(24)} ${m.engine.padEnd(9)} ${m.what}`);
  process.exit(0);
}
const wanted = args.includes('--all') ? CATALOG : args.map((n) => CATALOG.find((m) => m.name === n) ?? (console.error(`No mutation called ${n}. Use --list.`), process.exit(2)));

function parseTap(out) {
  const num = (label) => Number((new RegExp(`^# ${label} (\\d+)`, 'm').exec(out) ?? [0, 0])[1]);
  const lines = out.split('\n');
  const failing = [];
  lines.forEach((line, i) => {
    const m = /^\s*not ok \d+ - (.+)$/.exec(line);
    if (!m) return;
    if (/error: '\d+ subtests? failed'/.test(lines.slice(i + 1, i + 8).join(' '))) return; // a suite that failed only because something inside it did
    if (!failing.includes(m[1])) failing.push(m[1]);
  });
  return { total: num('tests'), passed: num('pass'), failed: num('fail'), failing };
}

function breakOne(m) {
  if (m.engine === 'postgres' && !process.env.TEST_DATABASE_URL) {
    return { name: m.name, skipped: 'needs TEST_DATABASE_URL (a throwaway PostgreSQL server)' };
  }
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), `vidverse-break-it-${m.name}-`));
  const originals = new Map(); // file -> Buffer
  let restored = false;
  const restore = () => {
    if (restored) return true;
    let ok = true;
    for (const [file, buf] of originals) {
      fs.writeFileSync(path.join(ROOT, file), buf);
      ok = ok && Buffer.compare(fs.readFileSync(path.join(ROOT, file)), buf) === 0;
    }
    restored = ok;
    return ok;
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  try {
    for (const e of m.edits) {
      const full = path.join(ROOT, e.file);
      if (!originals.has(e.file)) {
        const buf = fs.readFileSync(full);
        originals.set(e.file, buf);
        fs.writeFileSync(path.join(keep, e.file.replaceAll('/', '__')), buf);
      }
      const text = fs.readFileSync(full, 'utf8');
      const count = text.split(e.from).length - 1;
      if (count !== 1) throw new Error(`${m.name}: expected exactly one match in ${e.file}, found ${count}. The code has changed; update scripts/break-it.json.`);
      fs.writeFileSync(full, text.replace(e.from, () => e.to));
    }
    const env = { ...process.env };
    if (m.engine === 'pglite') delete env.TEST_DATABASE_URL;
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', ...m.tests], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60_000 });
    const tap = parseTap(`${run.stdout}\n${run.stderr}`);
    return { name: m.name, what: m.what, engine: m.engine, ...tap, caught: tap.failed > 0, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    const ok = restore();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (ok) fs.rmSync(keep, { recursive: true, force: true });
    else {
      console.error(`!! Could not restore every file for ${m.name}. The originals are in ${keep}`);
      process.exitCode = 3;
    }
  }
}

let unexpected = 0;
for (const m of wanted) {
  const before = new Map(m.edits.map((e) => [e.file, sha(fs.readFileSync(path.join(ROOT, e.file)))]));
  const r = breakOne(m);
  if (r.skipped) {
    console.log(`SKIPPED   ${m.name}: ${r.skipped}`);
    continue;
  }
  const same = m.edits.every((e) => before.get(e.file) === sha(fs.readFileSync(path.join(ROOT, e.file))));
  const verdict = r.caught ? 'CAUGHT  ' : 'SURVIVED';
  const asWritten = m.expect === 'varies' || (m.expect === 'caught') === r.caught;
  if (!asWritten) unexpected += 1;
  console.log(`${verdict}  ${m.name}  (${r.passed}/${r.total} passed, ${r.seconds}s, files restored: ${same ? 'identical' : 'DIFFERENT'})${asWritten ? '' : '   <-- NOT WHAT THE CATALOG EXPECTS'}`);
  for (const f of r.failing.slice(0, 6)) console.log(`            failed: ${f}`);
  if (m.note) console.log(`            note: ${m.note}`);
  if (!same) process.exitCode = 3;
}
if (unexpected && !process.exitCode) process.exitCode = 1;
