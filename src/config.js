import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKeyring, PROD_SCRYPT } from './lib/crypto.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bump when the Terms or Privacy Policy change in a way people must agree to again. */
export const LEGAL_VERSION = '2026-11-04';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const DEV_SESSION_SECRET = 'dev-only-session-secret-do-not-use-in-production-0123456789';
export const DEV_ENCRYPTION_KEYS = 'dev1:ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZCE=';

/**
 * Reads the project's .env file (or the file named by ENV_FILE) into process.env. Values already set in the
 * environment win. Called by the programs that start the site, never by loadConfig, so tests stay hermetic.
 */
export function loadDotEnv(file = process.env.ENV_FILE ?? path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function reader(env, problems) {
  const get = (k) => {
    const v = env[k];
    return v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim();
  };
  return {
    str: (k, d) => get(k) ?? d,
    int: (k, d, { min = -Infinity, max = Infinity } = {}) => {
      const v = get(k);
      if (v === undefined) return d;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${k} must be a whole number between ${min} and ${max}`);
        return d;
      }
      return n;
    },
    bool: (k, d = false) => {
      const v = get(k);
      if (v === undefined) return d;
      const l = v.toLowerCase();
      if (TRUE.has(l)) return true;
      if (FALSE.has(l)) return false;
      problems.push(`${k} must be true or false`);
      return d;
    },
    oneOf: (k, allowed, d) => {
      const v = get(k);
      if (v === undefined) return d;
      if (!allowed.includes(v)) {
        problems.push(`${k} must be one of: ${allowed.join(', ')}`);
        return d;
      }
      return v;
    },
  };
}

/**
 * Reads the environment into one validated object. Nothing else in the app reads process.env.
 * @param {Record<string,string|undefined>} env
 * @param {object} [overrides] shallow-merged per top-level key (used by tests)
 */
export function loadConfig(env = process.env, overrides = {}) {
  const problems = [];
  const r = reader(env, problems);
  const nodeEnv = r.oneOf('NODE_ENV', ['development', 'test', 'production'], 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const port = r.int('PORT', 3000, { min: 0, max: 65535 });
  const host = r.str('HOST', isProduction ? '0.0.0.0' : '127.0.0.1');
  const baseUrl = r.str('BASE_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  try {
    const u = new URL(baseUrl);
    if (u.pathname !== '/' && u.pathname !== '') problems.push('BASE_URL must not contain a path');
  } catch {
    problems.push('BASE_URL must be a full URL such as https://example.com');
  }

  const dataDir = path.resolve(r.str('DATA_DIR', path.join(ROOT, 'data')));
  const sessionSecret = r.str('SESSION_SECRET', isProduction ? undefined : DEV_SESSION_SECRET);
  const encryptionSpec = r.str('ENCRYPTION_KEYS', isProduction ? undefined : DEV_ENCRYPTION_KEYS);
  let encryptionKeys = null;
  try {
    if (encryptionSpec) encryptionKeys = createKeyring(encryptionSpec);
  } catch (e) {
    problems.push(e.message);
  }

  const smtpUrl = r.str('SMTP_URL');
  const mailTransport = r.oneOf('MAIL_TRANSPORT', ['smtp', 'file', 'memory'], smtpUrl ? 'smtp' : isTest ? 'memory' : 'file');

  const adsenseClient = r.str('ADSENSE_CLIENT');
  const wantsPersonalised = !r.bool('ADS_NON_PERSONALIZED', true);
  const consentConfirmed = r.bool('ADS_CONSENT_CONFIRMED', false);
  const paymentsDefault = r.str('RAZORPAY_KEY_ID') ? 'razorpay' : 'off';

  const config = {
    version: pkg.version,
    env: nodeEnv,
    isProduction,
    isTest,
    port,
    host,
    baseUrl,
    siteName: r.str('SITE_NAME', 'Vidverse'),
    trustProxy: r.int('TRUST_PROXY', 0, { min: 0, max: 10 }),
    logLevel: r.oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'], isTest ? 'silent' : 'info'),
    dataDir,
    databaseUrl: r.str('DATABASE_URL'),
    databaseSsl: r.bool('DATABASE_SSL', isProduction),
    pgliteDir: r.str('PGLITE_DIR', isTest ? 'memory://' : path.join(dataDir, 'pgdata')),
    sessionSecret,
    encryptionKeys,
    passwordCost: isTest ? { N: 2 ** 10, r: 8, p: 1 } : PROD_SCRYPT,
    mail: {
      transport: mailTransport,
      smtpUrl,
      from: r.str('MAIL_FROM', `${r.str('SITE_NAME', 'Vidverse')} <no-reply@localhost>`),
      outboxDir: path.join(dataDir, 'outbox'),
    },
    ads: {
      client: adsenseClient,
      slotWatchTop: r.str('ADSENSE_SLOT_WATCH_TOP'),
      slotWatchSide: r.str('ADSENSE_SLOT_WATCH_SIDE'),
      adsTxt: r.str('ADS_TXT'),
      // Fail-safe: ads are non-personalised unless the owner both asks for personalised ads AND says a Google-certified
      // consent message is switched on for visitors in the EEA, UK and Switzerland. This site has no consent banner of
      // its own, so it must not promise visitors a consent step that nobody has set up.
      wantsPersonalised,
      consentConfirmed,
      nonPersonalized: !(wantsPersonalised && consentConfirmed),
      defaultEligible: r.bool('ADS_DEFAULT_ELIGIBLE', true),
    },
    payments: {
      provider: r.oneOf('PAYMENTS_PROVIDER', ['razorpay', 'test', 'off'], paymentsDefault),
      razorpay: {
        keyId: r.str('RAZORPAY_KEY_ID'),
        keySecret: r.str('RAZORPAY_KEY_SECRET'),
        webhookSecret: r.str('RAZORPAY_WEBHOOK_SECRET'),
        apiBase: r.str('RAZORPAY_API_BASE', 'https://api.razorpay.com'),
      },
      currency: 'INR',
      feeBps: r.int('PLATFORM_FEE_BPS', 1000, { min: 0, max: 5000 }),
      tipMinMinor: r.int('TIP_MIN_MINOR', 2000, { min: 100 }),
      tipMaxMinor: r.int('TIP_MAX_MINOR', 5000000, { min: 100 }),
      payoutMinMinor: r.int('PAYOUT_MIN_MINOR', 50000, { min: 100 }),
      holdDays: r.int('HOLD_DAYS', 7, { min: 0, max: 90 }),
    },
    assistant: {
      // Optional. Without a key the assistant still answers, by quoting the best-matching help article.
      apiKey: r.str('ANTHROPIC_API_KEY'),
      model: r.str('ASSISTANT_MODEL', 'claude-haiku-5-5'),
      apiBase: r.str('ANTHROPIC_API_BASE', 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiVersion: r.str('ASSISTANT_API_VERSION', '2026-10-21'),
      // Hard stop on model calls per UTC day (counted per process), so a flood of questions cannot become a surprise bill.
      dailyLimit: r.int('ASSISTANT_DAILY_LIMIT', 2000, { min: 0, max: 1_000_000 }),
    },
    uploads: {
      maxBytes: r.int('MAX_UPLOAD_BYTES', 2 * 1024 ** 3, { min: 1024 }),
      maxSeconds: r.int('MAX_VIDEO_SECONDS', 3 * 3600, { min: 1 }),
      dailyLimit: r.int('DAILY_UPLOAD_LIMIT', 20, { min: 1 }),
      storageQuotaBytes: r.int('CREATOR_STORAGE_QUOTA_BYTES', 20 * 1024 ** 3, { min: 1024 }),
      profile: r.oneOf('TRANSCODE_PROFILE', ['fast', 'standard'], isTest ? 'fast' : 'standard'),
    },
    worker: r.oneOf('WORKER', ['inprocess', 'separate', 'off'], 'inprocess'),
    legal: {
      operatorName: r.str('OPERATOR_NAME'),
      operatorAddress: r.str('OPERATOR_ADDRESS'),
      contactEmail: r.str('CONTACT_EMAIL'),
      grievanceName: r.str('GRIEVANCE_OFFICER_NAME'),
      grievanceEmail: r.str('GRIEVANCE_OFFICER_EMAIL'),
      jurisdiction: r.str('LEGAL_JURISDICTION'),
      reviewed: r.bool('LEGAL_REVIEWED', false),
      allowUnreviewed: r.bool('ALLOW_UNREVIEWED_LEGAL', false),
    },
    limits: { enabled: r.bool('RATE_LIMITS', true) },
  };

  if (!sessionSecret || sessionSecret.length < 32) problems.push('SESSION_SECRET must be set to at least 32 random characters (try: openssl rand -base64 48)');
  if (!encryptionKeys && !problems.some((p) => p.includes('ENCRYPTION_KEYS'))) problems.push('ENCRYPTION_KEYS must be set (try: node -e "console.log(\'k1:\'+require(\'crypto\').randomBytes(32).toString(\'base64\'))")');
  if (adsenseClient && !/^ca-pub-\d{10,20}$/.test(adsenseClient)) problems.push('ADSENSE_CLIENT must look like ca-pub-1234567890123456');
  if (problems.length) throw new ConfigError(problems);

  for (const [key, value] of Object.entries(overrides)) {
    config[key] = value && typeof value === 'object' && !Array.isArray(value) && config[key] && typeof config[key] === 'object' ? { ...config[key], ...value } : value;
  }
  return config;
}

/**
 * Extra checks that must pass before the site starts in production. Returns
 * { errors, warnings }: errors stop the server, warnings are printed.
 */
export function preflight(config) {
  const errors = [];
  const warnings = [];
  if (!config.isProduction) return { errors, warnings };

  let url;
  try {
    url = new URL(config.baseUrl);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') errors.push('BASE_URL must be an https:// address in production.');
  else if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname)) errors.push('BASE_URL must be the public address, not localhost.');

  if (config.sessionSecret === DEV_SESSION_SECRET) errors.push('SESSION_SECRET is the development value.');
  if (config.encryptionKeys && config.encryptionKeys.keys.has('dev1')) errors.push('ENCRYPTION_KEYS contains the development key.');
  if (!config.databaseUrl) errors.push('DATABASE_URL is required in production (the embedded development database is not for production).');
  if (config.mail.transport !== 'smtp') errors.push('Set SMTP_URL: production must send real email (sign-up confirmation and password reset depend on it).');
  if (config.payments.provider === 'test') errors.push('PAYMENTS_PROVIDER=test is a stand-in that never moves money; it cannot run in production.');
  if (config.payments.provider === 'razorpay') {
    const rz = config.payments.razorpay;
    if (!rz.keyId || !rz.keySecret || !rz.webhookSecret) errors.push('Razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.');
  }
  const l = config.legal;
  for (const [name, value] of [
    ['OPERATOR_NAME', l.operatorName],
    ['OPERATOR_ADDRESS', l.operatorAddress],
    ['CONTACT_EMAIL', l.contactEmail],
    ['GRIEVANCE_OFFICER_NAME', l.grievanceName],
    ['GRIEVANCE_OFFICER_EMAIL', l.grievanceEmail],
    ['LEGAL_JURISDICTION', l.jurisdiction],
  ]) {
    if (!value) errors.push(`${name} must be set: the legal pages and the grievance contact name you.`);
  }
  if (!l.reviewed && !l.allowUnreviewed) errors.push('The legal pages are templates. Have a lawyer review them and set LEGAL_REVIEWED=true (or set ALLOW_UNREVIEWED_LEGAL=true to launch with a visible "draft" notice).');
  if (!l.reviewed && l.allowUnreviewed) warnings.push('Legal pages are marked as drafts until LEGAL_REVIEWED=true.');
  if (config.trustProxy === 0) warnings.push('TRUST_PROXY is 0. Behind a load balancer or reverse proxy set it to the number of proxies, or every visitor will appear to have the proxy’s address.');
  if (config.ads.client && config.ads.wantsPersonalised && !config.ads.consentConfirmed) warnings.push('ADS_NON_PERSONALIZED=false is ignored: ads stay non-personalised until a Google-certified consent message is switched on for visitors in the EEA, UK and Switzerland and you set ADS_CONSENT_CONFIRMED=true. This site has no consent banner of its own.');
  if (config.worker === 'off') warnings.push('WORKER=off: uploaded videos will not be processed unless a separate worker is running.');
  return { errors, warnings };
}
