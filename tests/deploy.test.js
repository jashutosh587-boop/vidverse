import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, preflight } from '../src/config.js';

/**
 * The server installer (deploy/install.sh) and its helpers are bash for Ubuntu. These tests do not install anything;
 * they check the parts that can be checked anywhere bash is available, and above all that the pieces agree with each
 * other and with the site: the settings file the installer writes must pass the site's own production checks, and every
 * path and name in the systemd units must be the one the installer creates. What cannot be checked here (a real install
 * on a real server) is listed in docs/TESTING.md.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const skip = hasBash ? false : 'bash is not available on this machine';

/** Run a snippet of bash with the installer's functions loaded (sourcing it never starts an install). */
function installer(code, args = [], env = {}) {
  return spawnSync('bash', ['-c', `source deploy/install.sh\n${code}`, '_', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('server installer: scripts', { skip }, () => {
  test('every deploy script is valid bash', () => {
    for (const f of ['install.sh', 'vidverse', 'vidverse-backup']) {
      const r = spawnSync('bash', ['-n', path.join('deploy', f)], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  });

  test('values written to the settings file are read back by the site’s own loader exactly as typed', () => {
    const cases = [
      '', 'plain', 'https://videos.mysite.in', 'a b c', 'Vidverse <no-reply@videos.mysite.in>', 'Flat #4, Baner, Pune 411045',
      'smtp://user:p%40ss@smtp.mail.com:587', 'has "double" quotes', "it's here", `both ' and "`, 'back\\slash', 'dollar $HOME and ${X}',
      'k1:abc+/def==', 'trailing space ', ' leading space', 'tab\there', 'hash#inside', 'equals=sign', 'back`tick', 'literal\\nbackslash-n',
      'ünïcödé नमस्ते', "mix ' and ` only", 'semi;colon & amp | pipe', '100% sure',
    ];
    for (const value of cases) {
      const r = installer('env_quote "$1"', [value]);
      assert.equal(r.status, 0, `could not quote ${JSON.stringify(value)}`);
      const parsed = parseEnv(`A=${r.stdout}\nB=after\n`);
      assert.equal(parsed.A, value, `${JSON.stringify(value)} was written as ${r.stdout}`);
      assert.equal(parsed.B, 'after', `a value ate the line after it: ${r.stdout}`);
    }
  });

  test('a value that cannot be stored safely is refused, not mangled', () => {
    const r = installer('env_quote "$1"', [`all ' three " kinds \` of quote`]);
    assert.notEqual(r.status, 0);
  });

  test('the settings file reader keeps what is typed, ignores notes, and refuses misspelled settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-deploy-'));
    try {
      const good = path.join(dir, 'good.conf');
      fs.writeFileSync(good, '# a note\r\n\r\nDOMAIN=videos.mysite.in\r\nOPERATOR_NAME=Asha # Co. Pvt. Ltd.  \r\nOPERATOR_ADDRESS="12, MG Road, Pune"\r\n  CONTACT_EMAIL=x@y.in\r\n');
      const r = installer('read_settings "$1"; for k in "${!S[@]}"; do printf "%s=[%s]\\n" "$k" "${S[$k]}"; done | sort', [good]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^DOMAIN=\[videos\.mysite\.in\]$/m);
      assert.match(r.stdout, /^OPERATOR_NAME=\[Asha # Co\. Pvt\. Ltd\.\]$/m, 'a # inside a value is part of the value; trailing spaces are dropped');
      assert.match(r.stdout, /^OPERATOR_ADDRESS=\[12, MG Road, Pune\]$/m, 'one pair of quotes is removed');
      assert.match(r.stdout, /^CONTACT_EMAIL=\[x@y\.in\]$/m, 'a line may be indented');

      const typo = path.join(dir, 'typo.conf');
      fs.writeFileSync(typo, 'DOMIAN=videos.mysite.in\n');
      const bad = installer('read_settings "$1"', [typo]);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /unknown setting DOMIAN/);

      // Spaces around "=" are refused, with the line number and the text, so the person can see what to fix.
      const spaced = path.join(dir, 'spaced.conf');
      fs.writeFileSync(spaced, '# note\nDOMAIN = videos.mysite.in\n');
      const refused = installer('read_settings "$1"', [spaced]);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /line 2: expected KEY=value but found: DOMAIN = videos\.mysite\.in/);

      const shellCode = path.join(dir, 'code.conf');
      fs.writeFileSync(shellCode, `DOMAIN=videos.mysite.in\nOPERATOR_NAME=$(touch ${path.join(dir, 'pwned')})\n`);
      installer('read_settings "$1"', [shellCode]);
      assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'the settings file must never be executed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the example settings file only uses settings the installer knows, and has every required one switched on', () => {
    const known = installer('printf "%s\\n" "${SETTING_KEYS[@]}"').stdout.trim().split('\n');
    const required = installer('printf "%s\\n" "${REQUIRED_KEYS[@]}"').stdout.trim().split('\n');
    const example = read('deploy', 'setup.conf.example');
    const mentioned = [...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    for (const key of mentioned) assert.ok(known.includes(key), `${key} in setup.conf.example is not a setting the installer reads`);
    const active = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    for (const key of required) assert.ok(active.includes(key), `${key} is required but not switched on in the example`);
    for (const key of known) assert.ok(mentioned.includes(key), `${key} is read by the installer but not shown in the example`);
  });
});

describe('server installer: the pieces agree with each other and with the site', { skip }, () => {
  test('the settings file the installer writes passes the site’s own production checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-deploy-'));
    try {
      const out = path.join(dir, 'vidverse.env');
      // `install` is replaced by a copy, because the real one would need root and the vidverse user.
      const r = installer(`
        install() { cp "\${@: -2:1}" "$OUT"; }
        S[DOMAIN]=videos.mysite.in; S[SITE_NAME]=Vidverse; S[SMTP_URL]='smtps://mailer:p%40ss@smtp.mail.in:465'
        S[MAIL_FROM]='Vidverse <no-reply@videos.mysite.in>'; S[OPERATOR_NAME]='Asha # Co. Pvt. Ltd.'
        S[OPERATOR_ADDRESS]='Flat #4, MG Road, Pune 411001, India'; S[CONTACT_EMAIL]=asha@mysite.in
        S[GRIEVANCE_OFFICER_NAME]='Asha Patil'; S[GRIEVANCE_OFFICER_EMAIL]=grievance@mysite.in
        S[LEGAL_JURISDICTION]=India; S[ANTHROPIC_API_KEY]=''; S[TRANSCODE_PROFILE]=standard
        S[MAX_UPLOAD_BYTES]=1073741824; S[MAX_VIDEO_SECONDS]=1800; S[DAILY_UPLOAD_LIMIT]=5; S[CREATOR_STORAGE_QUOTA_BYTES]=5368709120
        DB_PASSWORD=0123456789abcdef0123456789abcdef; ENV_FILE=/nowhere/vidverse.env
        write_env`, [], { OUT: out });
      assert.equal(r.status, 0, r.stderr);
      const env = parseEnv(fs.readFileSync(out, 'utf8'));
      assert.equal(env.OPERATOR_NAME, 'Asha # Co. Pvt. Ltd.');
      assert.equal(env.OPERATOR_ADDRESS, 'Flat #4, MG Road, Pune 411001, India');
      assert.equal(env.SMTP_URL, 'smtps://mailer:p%40ss@smtp.mail.in:465');

      const config = loadConfig(env);
      const { errors } = preflight(config);
      assert.deepEqual(errors, [], 'the site would refuse to start with the settings the installer wrote');
      assert.equal(config.baseUrl, 'https://videos.mysite.in');
      assert.equal(config.worker, 'separate', 'the installer runs the worker as its own service');
      assert.equal(config.host, '127.0.0.1', 'only Caddy may reach the site directly');
      assert.equal(config.trustProxy, 1);
      assert.equal(config.dataDir, '/var/lib/vidverse');
      assert.equal(config.legal.reviewed, false, 'the installer never claims a lawyer has reviewed the legal pages');
      assert.equal(config.payments.provider, 'off');
      assert.notEqual(env.SESSION_SECRET, parseEnv(fs.readFileSync(out, 'utf8')).ENCRYPTION_KEYS);
      assert.ok(env.SESSION_SECRET.length >= 48 && /^k1:[A-Za-z0-9+/]{43}=$/.test(env.ENCRYPTION_KEYS), 'secrets are long random values in the documented format');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every setting the installer writes is one the project documents in .env.example', () => {
    const body = read('deploy', 'install.sh').split('cat > "$tmp" << EOF')[1].split('\nEOF\n')[0];
    const written = [...body.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const documented = new Set([...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    assert.ok(written.length > 25);
    for (const key of written) assert.ok(documented.has(key), `${key} is written by the installer but missing from .env.example`);
  });

  test('the systemd units use the user, folders and commands the installer sets up', () => {
    const names = installer('printf "%s\\n" "$APP_USER" "$APP_DIR" "$DATA_DIR" "$ENV_FILE" "$GATE_FILE"').stdout.trim().split('\n');
    const [appUser, appDir, dataDir, envFile, gateFile] = names;
    for (const [unit, script] of [['vidverse-web.service', 'server.js'], ['vidverse-worker.service', 'worker.js']]) {
      const text = read('deploy', unit);
      assert.match(text, new RegExp(`^ExecStart=@NODE@ src/${script.replace('.', '\\.')}$`, 'm'));
      assert.match(text, new RegExp(`^User=${appUser}$`, 'm'));
      assert.match(text, new RegExp(`^WorkingDirectory=${appDir}/current$`, 'm'));
      assert.match(text, new RegExp(`^Environment=ENV_FILE=${envFile}$`, 'm'));
      assert.match(text, new RegExp(`^ReadWritePaths=${dataDir}$`, 'm'));
      assert.match(text, /^Restart=on-failure$/m);
      assert.match(text, /^NoNewPrivileges=yes$/m);
      const uses = text.split('\n').filter((l) => l.includes('@NODE@') && !l.startsWith('#'));
      assert.equal(uses.length, 1, '@NODE@ belongs only in ExecStart');
      assert.doesNotMatch(text, /MemoryDenyWriteExecute=yes/, 'Node.js cannot run with write-xor-execute memory');
    }
    assert.match(read('deploy', 'vidverse-worker.service'), /^Nice=10$/m, 'video processing must not starve page loads');
    assert.match(read('deploy', 'vidverse-backup.service'), /^ExecStart=\/usr\/local\/sbin\/vidverse-backup$/m);
    assert.match(read('deploy', 'vidverse-backup.timer'), /^Persistent=true$/m);
    assert.match(read('deploy', 'install.sh'), /install -m 755 -o root -g root "\$HERE\/vidverse-backup" \/usr\/local\/sbin\/vidverse-backup/);
    assert.match(read('deploy', 'vidverse'), new RegExp(`^ENV_FILE=\\$\\{ENV_FILE:-${envFile}\\}$`, 'm'));
    assert.match(read('deploy', 'vidverse'), new RegExp(`^GATE_FILE=\\$\\{GATE_FILE:-${gateFile}\\}$`, 'm'));
    assert.match(read('deploy', 'vidverse-backup'), new RegExp(`ENV_FILE=\\$\\{ENV_FILE:-${envFile}\\}`));
    assert.match(read('deploy', 'vidverse-backup'), /DATA_DIR=\$\{DATA_DIR:-\$\(sed -n 's\/\^DATA_DIR=\/\/p'/, 'the backup finds the videos folder from the settings file');
  });

  test('the Caddy template proxies to the site, imports the password gate the helper writes, and carries the marker the installer looks for', () => {
    const gateFile = installer('printf "%s" "$GATE_FILE"').stdout;
    const text = read('deploy', 'Caddyfile.template');
    assert.match(text.split('\n')[0], /Vidverse installer/);
    assert.ok(read('deploy', 'install.sh').includes("grep -q 'Vidverse installer'"), 'the installer detects its own file by this marker');
    for (const token of ['@DOMAIN@', '@ACME_EMAIL@', '@DATE@']) assert.ok(text.includes(token), token);
    assert.match(text, new RegExp(`^\\s+import ${gateFile.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(text, /^\s+reverse_proxy 127\.0\.0\.1:3000$/m);
  });
});

describe('server helper: putting a backup back (vidverse restore)', { skip }, () => {
  /** Runs the helper's copy_env_line on two small files. `chown` is a no-op here because the test does not run as root. */
  function copyEnvLine(key, fromText, toText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-restore-'));
    try {
      const from = path.join(dir, 'from.env');
      const to = path.join(dir, 'to.env');
      fs.writeFileSync(from, fromText);
      fs.writeFileSync(to, toText);
      const code = `chown() { :; }\nsource <(sed -n '/^copy_env_line()/,/^}/p' deploy/vidverse)\ncopy_env_line "$1" "$2" "$3"`;
      const r = spawnSync('bash', ['-c', code, '_', key, from, to], { cwd: ROOT, encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr, after: fs.readFileSync(to, 'utf8'), mode: fs.statSync(to).mode & 0o777, files: fs.readdirSync(dir).sort() };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a secret key is copied into the settings file exactly, without touching any other line', () => {
    const secret = `SESSION_SECRET='odd \\ back\\slash $HOME & amp | pipe "q" #hash'`;
    // A line whose name merely starts with the key (SESSION_SECRET_OLD) comes first, to prove only the exact key is replaced.
    const r = copyEnvLine('SESSION_SECRET', `A=1\n${secret}\n`, 'A=2\nSESSION_SECRET_OLD=keep\nSESSION_SECRET=old\nZ=9\n');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.after, `A=2\nSESSION_SECRET_OLD=keep\n${secret}\nZ=9\n`);
    assert.equal(parseEnv(r.after).SESSION_SECRET, parseEnv(`${secret}\n`).SESSION_SECRET, 'the site reads the same secret as before');
    assert.equal(r.mode, 0o640);
    assert.deepEqual(r.files, ['from.env', 'to.env'], 'no temporary file is left behind');
  });

  test('a key the settings file does not have yet is added; a key the backup lacks is refused and nothing changes', () => {
    const added = copyEnvLine('ENCRYPTION_KEYS', "ENCRYPTION_KEYS='k1:abc='\n", 'A=1\n');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(added.after, "A=1\nENCRYPTION_KEYS='k1:abc='\n");
    for (const from of ['A=1\n', 'ENCRYPTION_KEYS=\n']) {
      const refused = copyEnvLine('ENCRYPTION_KEYS', from, 'A=1\nENCRYPTION_KEYS=keep\n');
      assert.notEqual(refused.status, 0, `${JSON.stringify(from)} must be refused`);
      assert.equal(refused.after, 'A=1\nENCRYPTION_KEYS=keep\n');
    }
  });

  test('every check comes before the first change, and the two mistakes found in the restore drill stay fixed', () => {
    const helper = read('deploy', 'vidverse');
    const body = helper.slice(helper.indexOf('cmd_restore() {'), helper.indexOf('\ncase "${1:-}" in\n  status)'));
    assert.ok(body.length > 500, 'cmd_restore was not found');
    const firstChange = body.indexOf('systemctl stop');
    for (const refusal of ['is not a finished backup', 'has no database.dump', 'has no vidverse.env', 'has no media folder', 'cannot be read as a database backup', 'has no $key', 'will not be emptied', 'Add --yes to go ahead', 'Type RESTORE']) {
      const at = body.indexOf(refusal);
      assert.ok(at > 0 && at < firstChange, `"${refusal}" must be checked before the site is stopped`);
    }
    // Drill finding 1: the usual "keep the newest 7" clean-up of the safety backup deleted the backup being restored when
    // that was the oldest one, after the database had already been dropped.
    assert.match(body, /KEEP=1000 LOCK_FILE=\S+ \/usr\/local\/sbin\/vidverse-backup/);
    assert.ok(body.indexOf('flock -n 9') < body.indexOf('/usr/local/sbin/vidverse-backup'), 'the lock is taken before the safety backup is made');
    // Drill finding 2: services started while the backup lock was open inherited it, and no later backup could run.
    const release = body.indexOf('exec 9>&-');
    assert.ok(release > body.indexOf('rsync -a --delete') && release < body.indexOf('systemctl restart vidverse-web'), 'the lock is let go before the services start');
    assert.match(helper, /^ {2}restore BACKUPFOLDER /m, 'the help text lists the command');
  });
});
