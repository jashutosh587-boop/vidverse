#!/usr/bin/env node
/**
 * Gives an existing account the administrator role, or takes it away. This is the only way to create an
 * administrator: the website can make moderators but never administrators.
 *
 *     npm run make-admin -- someone@example.com            # grant
 *     npm run make-admin -- someone@example.com --revoke   # back to a normal account
 *
 * The person signs up on the site first and confirms their email. Then switch on two-step verification in
 * Settings > Security: the pages that move money stay closed to administrators until it is on.
 */
import { loadConfig, loadDotEnv, ConfigError } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run make-admin -- someone@example.com [--revoke]');
  process.exit(1);
}

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
let code = 0;
try {
  await migrate(db);
  const user = await db.one('SELECT id, handle, role, status, email_verified_at, totp_enabled_at FROM users WHERE lower(email) = $1', [email]);
  if (!user) {
    console.error('No account has that email address. They need to sign up on the site first.');
    code = 1;
  } else if (user.status !== 'active') {
    console.error(`That account is ${user.status}. Only active accounts can be changed.`);
    code = 1;
  } else if (!revoke && !user.email_verified_at) {
    console.error('That email address is not confirmed yet. They need to open the link in the confirmation email first.');
    code = 1;
  } else {
    const role = revoke ? 'user' : 'admin';
    if (user.role === role) {
      console.log(`@${user.handle} is already ${revoke ? 'a normal account' : 'an administrator'}. Nothing changed.`);
    } else {
      await db.tx(async () => {
        await db.query('UPDATE users SET role = $2 WHERE id = $1', [user.id, role]);
        await db.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, meta) VALUES (NULL, $1, 'user', $2, $3)`, [revoke ? 'user.admin_revoke' : 'user.admin_grant', user.id, JSON.stringify({ via: 'command line', previousRole: user.role })]);
        if (revoke) await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      });
      console.log(revoke ? `@${user.handle} is a normal account again and has been signed out everywhere.` : `@${user.handle} is now an administrator.`);
      if (!revoke && !user.totp_enabled_at) console.log('Next: they should switch on two-step verification (Settings > Security). Until then the money pages stay closed to them.');
    }
  }
} finally {
  await db.close();
}
process.exit(code);
