import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { model, report, DEFAULTS } from '../scripts/economics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('economics calculator', () => {
  test('the default scenario matches the arithmetic done by hand', () => {
    // 100,000 views x 4 min = 6,666.67 h; at 1.5 Mbps = 0.675 GB/h -> 4,500 GB; x Rs 1 = 4,500; + 200 storage + 2,500 server
    const m = model();
    assert.equal(m.gbDelivered, 4500);
    assert.deepEqual(m.cost, { egress: 4500, storage: 200, server: 2500, total: 7200 });
    assert.equal(m.costPer1000Views, 72);
    assert.equal(m.breakEvenRpm, 72);
    assert.equal(m.result, null, 'no income is invented when none is given');
  });

  test('tips reduce what advertising has to cover, by the platform fee minus the provider’s cut', () => {
    const m = model({ tips: 10_000 }); // 7.5% of 10,000 = 750 kept
    assert.equal(m.tipsKept, 750);
    assert.equal(m.breakEvenRpm, 64.5);
    assert.equal(model({ tips: 10_000, feeBps: 100, gatewayBps: 250 }).tipsKept, -150, 'a fee below the provider’s cut loses money');
    assert.equal(model({ tips: 10_000, feeBps: 100, gatewayBps: 250 }).breakEvenRpm, 73.5);
  });

  test('income given by the person is compared with cost, and a loss is reported as a loss', () => {
    assert.deepEqual(model({ adsenseRpm: 100 }).result, { adRevenue: 10_000, profit: 2800 });
    const loss = model({ adsenseRpm: 20 });
    assert.equal(loss.result.profit, -5200);
    assert.match(report(loss), /short by ₹5,200/);
  });

  test('bad input is refused', () => {
    for (const bad of [{ views: 0 }, { views: -5 }, { egress: -1 }, { minutes: Number.NaN }, { bitrate: 'fast' }, { feeBps: 20_000 }]) {
      assert.throws(() => model(bad), /must be|cannot be/, JSON.stringify(bad));
    }
    assert.equal(DEFAULTS.adsenseRpm, null);
  });

  test('the command line prints a report, JSON on request, and exits with an error on a typo', () => {
    const run = (...args) => spawnSync(process.execPath, ['scripts/economics.js', ...args], { cwd: ROOT, encoding: 'utf8' });
    const plain = run('--views', '50000');
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /Not a forecast/);
    assert.match(plain.stdout, /Advertising must pay at least/);
    assert.equal(JSON.parse(run('--json', '--views', '50000').stdout).inputs.views, 50_000);
    const bad = run('--views', 'lots');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--views must be a number/);
  });
});

describe('command-line tools', () => {
  let dir;
  let env;
  const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
  const withDb = async (fn) => {
    const db = await createDb(loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, PGLITE_DIR: path.join(dir, 'pg') }));
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  };
  const addUser = (db, { email, handle, verified = true, status = 'active', role = 'user' }) =>
    db.one(
      `INSERT INTO users (email, email_verified_at, password_hash, handle, display_name, adult_confirmed_at, terms_version, terms_accepted_at, status, role)
       VALUES ($1, $2, 'x', $3, $3, now(), 'v', now(), $4, $5) RETURNING id`,
      [email, verified ? new Date() : null, handle, status, role],
    );

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-scripts-'));
    // ENV_FILE points nowhere so a .env in the project cannot leak into the test.
    env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', DATA_DIR: dir, PGLITE_DIR: path.join(dir, 'pg'), ENV_FILE: path.join(dir, 'none.env'), LOG_LEVEL: 'silent' };
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('migrate creates the schema once and says so when there is nothing left to do', () => {
    const first = run('migrate.js');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Applied: 001_init\.sql/);
    const second = run('migrate.js');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Nothing to apply/);
  });

  test('a broken setting stops the tools with a readable message, not a stack trace', () => {
    const r = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: ROOT, env: { ...env, PORT: 'eighty' }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PORT must be a whole number/);
    assert.ok(!r.stderr.includes('    at '));
  });

  describe('make-admin', () => {
    let boss;
    before(async () => {
      await withDb(async (db) => {
        boss = (await addUser(db, { email: 'Boss@Example.com', handle: 'boss' })).id;
        await addUser(db, { email: 'fresh@example.com', handle: 'fresh', verified: false });
        await addUser(db, { email: 'gone@example.com', handle: 'gone', status: 'suspended' });
      });
    });

    test('asks for an email address', () => {
      const r = run('make-admin.js');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Usage/);
    });

    test('refuses an unknown address, an unconfirmed one and a suspended account, and changes nothing', async () => {
      const unknown = run('make-admin.js', 'nobody@example.com');
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /sign up on the site first/);
      const unconfirmed = run('make-admin.js', 'fresh@example.com');
      assert.equal(unconfirmed.status, 1);
      assert.match(unconfirmed.stderr, /not confirmed/);
      const suspended = run('make-admin.js', 'gone@example.com');
      assert.equal(suspended.status, 1);
      assert.match(suspended.stderr, /suspended/);
      await withDb(async (db) => {
        assert.equal((await db.query(`SELECT 1 FROM users WHERE role = 'admin'`)).rows.length, 0);
        assert.equal((await db.query(`SELECT 1 FROM audit_log`)).rows.length, 0);
      });
    });

    test('grants the role whatever the capitalisation, records it, and is calm when repeated', async () => {
      const r = run('make-admin.js', '  BOSS@example.COM ');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /@boss is now an administrator/);
      assert.match(r.stdout, /two-step verification/);
      const again = run('make-admin.js', 'boss@example.com');
      assert.equal(again.status, 0);
      assert.match(again.stdout, /already an administrator/);
      await withDb(async (db) => {
        assert.equal((await db.one('SELECT role FROM users WHERE id = $1', [boss])).role, 'admin');
        const log = (await db.query(`SELECT actor_id, action, meta FROM audit_log`)).rows;
        assert.equal(log.length, 1, 'repeating it does not write a second entry');
        assert.equal(log[0].action, 'user.admin_grant');
        assert.equal(log[0].actor_id, null);
        assert.equal(log[0].meta.previousRole, 'user');
      });
    });

    test('revoking returns a normal account and signs the person out everywhere', async () => {
      await withDb((db) => db.query(`INSERT INTO sessions (id, user_id, created_at, last_seen_at, idle_expires_at, expires_at) VALUES ('s1', $1, now(), now(), now() + interval '1 day', now() + interval '1 day')`, [boss]));
      const r = run('make-admin.js', 'boss@example.com', '--revoke');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /normal account again/);
      await withDb(async (db) => {
        assert.equal((await db.one('SELECT role FROM users WHERE id = $1', [boss])).role, 'user');
        assert.equal((await db.query('SELECT 1 FROM sessions WHERE user_id = $1', [boss])).rows.length, 0);
        assert.deepEqual((await db.query(`SELECT action FROM audit_log ORDER BY id`)).rows.map((x) => x.action), ['user.admin_grant', 'user.admin_revoke']);
      });
    });
  });

  describe('mail-test', () => {
    /** A tiny stand-in mail server: plain SMTP, an optional login, and it keeps what it was sent. */
    function fakeSmtp({ login = null } = {}) {
      const received = [];
      const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buf = '';
        let mode = 'command';
        let body = '';
        const reply = (text) => socket.write(`${text}\r\n`);
        reply('220 fake ready');
        socket.on('data', (chunk) => {
          buf += chunk;
          for (let i = buf.indexOf('\r\n'); i !== -1; i = buf.indexOf('\r\n')) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (mode === 'data') {
              if (line === '.') {
                received.push(body);
                body = '';
                mode = 'command';
                reply('250 queued');
              } else body += `${line}\n`;
            } else if (mode === 'user') {
              mode = 'password';
              reply('334 UGFzc3dvcmQ6');
            } else if (mode === 'password') {
              mode = 'command';
              reply(Buffer.from(line, 'base64').toString() === login?.password ? '235 welcome' : '535 5.7.8 Username and Password not accepted');
            } else if (/^EHLO/i.test(line)) socket.write(`250-fake\r\n${login ? '250-AUTH LOGIN\r\n' : ''}250 8BITMIME\r\n`);
            else if (/^AUTH LOGIN/i.test(line)) {
              mode = 'user';
              reply('334 VXNlcm5hbWU6');
            } else if (/^DATA/i.test(line)) {
              mode = 'data';
              reply('354 go');
            } else if (/^QUIT/i.test(line)) {
              reply('221 bye');
              socket.end();
            } else reply('250 ok');
          }
        });
      });
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, received, close: () => new Promise((r) => server.close(r)) })));
    }
    // The server runs in this process, so the tool must run as a separate process without blocking us (not spawnSync).
    const runAsync = (args, extraEnv = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/mail-test.js', ...args], { cwd: ROOT, env: { ...env, ...extraEnv } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    test('needs an address to send to, and settings that send real email', async () => {
      const none = await runAsync([]);
      assert.equal(none.status, 1);
      assert.match(none.stderr, /Usage/);
      const unset = await runAsync(['someone@example.com']);
      assert.equal(unset.status, 1);
      assert.match(unset.stderr, /SMTP_URL/);
      const broken = await runAsync(['someone@example.com'], { SMTP_URL: 'not a url' });
      assert.equal(broken.status, 1);
      assert.match(broken.stderr, /not a valid address/);
    });

    test('sends through the real mail path, logs in, and reports success without the password', async () => {
      const smtp = await fakeSmtp({ login: { password: 'hunter2' } });
      try {
        const r = await runAsync(['someone@example.com'], { SMTP_URL: `smtp://mailer:hunter2@127.0.0.1:${smtp.port}`, MAIL_FROM: 'Vidverse <no-reply@example.com>' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`Sent to someone@example\\.com through 127\\.0\\.0\\.1:${smtp.port}`));
        assert.ok(!(r.stdout + r.stderr).includes('hunter2'), 'the password is never printed');
        assert.equal(smtp.received.length, 1);
        assert.match(smtp.received[0], /Subject: Test email from Vidverse/);
        assert.match(smtp.received[0], /To: someone@example\.com/);
        assert.match(smtp.received[0], /From: Vidverse <no-reply@example\.com>/);
      } finally {
        await smtp.close();
      }
    });

    test('says plainly when the mail server refuses the login, and sends nothing', async () => {
      const smtp = await fakeSmtp({ login: { password: 'right-password' } });
      try {
        const r = await runAsync(['someone@example.com'], { SMTP_URL: `smtp://mailer:wrong-password@127.0.0.1:${smtp.port}` });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /refused the username or password/);
        assert.ok(!(r.stdout + r.stderr).includes('wrong-password'), 'the password is never printed');
        assert.equal(smtp.received.length, 0);
      } finally {
        await smtp.close();
      }
    });

    test('says plainly when nothing answers at the address', async () => {
      const closed = await fakeSmtp();
      await closed.close(); // its port is now free and nothing listens there
      const r = await runAsync(['someone@example.com'], { SMTP_URL: `smtp://mailer:pw@127.0.0.1:${closed.port}` });
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`could not connect to 127\\.0\\.0\\.1:${closed.port}`));
    });
  });
});
