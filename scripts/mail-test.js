#!/usr/bin/env node
/**
 * Sends one test email with the site's own mail settings and says plainly whether it worked. Sign-up confirmation
 * and password reset depend on email, and a wrong mail setting is the most common reason a new site "does nothing":
 * the site would only write "email failed" in its log. Run this before you open the site to anyone.
 *
 *     npm run mail-test -- you@example.com
 *
 * It uses SMTP_URL and MAIL_FROM exactly as the site does, and never prints the password.
 */
import { loadConfig, loadDotEnv, ConfigError } from '../src/config.js';
import { createMailer } from '../src/services/mailer.js';

const to = process.argv[2]?.trim();
if (!to || !to.includes('@')) {
  console.error('Usage: npm run mail-test -- you@example.com');
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
if (config.mail.transport !== 'smtp') {
  console.error(`Email is set to "${config.mail.transport}", which does not send real email. Set SMTP_URL (for example smtps://user:password@smtp.example.com:465) and try again.`);
  process.exit(1);
}

let where = 'the mail server';
try {
  const u = new URL(config.mail.smtpUrl);
  where = `${u.hostname}:${u.port || (u.protocol === 'smtps:' ? 465 : 587)}`;
} catch {
  console.error('SMTP_URL is not a valid address. It should look like smtps://user:password@smtp.example.com:465');
  process.exit(1);
}

/** What went wrong, in words a site owner can act on. Never includes the password. */
function explain(e) {
  const detail = String(e?.message ?? e).slice(0, 200);
  const server = e?.response ? ` The server said: ${String(e.response).slice(0, 200)}` : '';
  // nodemailer reports most network problems with the same code (ESOCKET), so the message decides which advice fits.
  if (e?.code === 'EAUTH') return `${where} refused the username or password in SMTP_URL.${server} Some providers need an app password, not your normal one.`;
  if (e?.code === 'EENVELOPE') return `the mail server did not accept the addresses.${server} Check MAIL_FROM: many providers only allow their own address or a verified one.`;
  if (e?.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) return `the name ${where.split(':')[0]} could not be found. Check the host in SMTP_URL.`;
  if (/certificate|self[- ]signed|SSL|TLS|handshake|wrong version/i.test(detail)) return `the secure connection to ${where} failed (${detail}). Check the port: 465 goes with smtps://, 587 with smtp://.`;
  if (['ECONNECTION', 'ESOCKET', 'ETIMEDOUT'].includes(e?.code) || /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timeout/i.test(detail)) {
    return `could not connect to ${where}. Check the host and port in SMTP_URL, and that your server is allowed to make outgoing mail connections (some hosts block ports 25 and 465).`;
  }
  return `${detail}${server}`;
}

const mailer = createMailer(config);
try {
  await mailer.send({
    to,
    subject: `Test email from ${config.siteName}`,
    text: `This is a test message from ${config.baseUrl}.\n\nIf you can read it, sign-up and password-reset emails can reach people.\nSent ${new Date().toISOString()}.\n`,
  });
  console.log(`Sent to ${to} through ${where}, from "${config.mail.from}". The mail server accepted it. Now check the inbox, and the spam folder: if it is there, set up SPF, DKIM and DMARC for your domain.`);
} catch (e) {
  console.error(`Sending failed: ${explain(e)}`);
  process.exit(1);
}
