import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Sends email. Transports:
 *   smtp   - real delivery through nodemailer (production)
 *   file   - writes each message to DATA_DIR/outbox/*.json (development; the browser tests read it)
 *   memory - keeps messages in an array (unit tests)
 */
export function createMailer(config, log) {
  const sent = [];
  let transporter = null;

  async function smtp() {
    if (!transporter) {
      const nodemailer = (await import('nodemailer')).default;
      transporter = nodemailer.createTransport(config.mail.smtpUrl);
    }
    return transporter;
  }

  return {
    sent,
    async send({ to, subject, text, replyTo }) {
      const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
      if (!EMAIL.test(to)) throw new Error('Invalid recipient');
      if (replyTo !== undefined && !EMAIL.test(replyTo)) throw new Error('Invalid reply-to address');
      if (/[\r\n]/.test(subject)) throw new Error('Invalid subject');
      const message = { to, subject, text, from: config.mail.from, at: new Date().toISOString(), ...(replyTo ? { replyTo } : {}) };
      if (config.mail.transport === 'memory') {
        sent.push(message);
      } else if (config.mail.transport === 'file') {
        fs.mkdirSync(config.mail.outboxDir, { recursive: true });
        const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
        fs.writeFileSync(path.join(config.mail.outboxDir, name), JSON.stringify(message, null, 2));
        sent.push(message);
        if (sent.length > 200) sent.shift();
      } else {
        const t = await smtp();
        await t.sendMail({ from: config.mail.from, to, subject, text, ...(replyTo ? { replyTo } : {}) });
      }
      log?.info('email sent', { transport: config.mail.transport, subject });
    },
  };
}
