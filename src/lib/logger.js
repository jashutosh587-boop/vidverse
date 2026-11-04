const SECRET_KEYS = /pass(word)?|secret|token|cookie|authorization|api[_-]?key|signature|csrf|recovery|otp|details/i;

function clean(value, depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (depth > 3) return '[deep]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : clean(v, depth + 1);
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** One JSON object per line on stdout/stderr. Secrets in field names are redacted; email addresses are never logged by the app. */
export function createLogger({ level = 'info', sink } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write =
    sink ??
    ((line, lvl) => {
      (lvl >= LEVELS.error ? process.stderr : process.stdout).write(`${line}\n`);
    });
  const log = (name) => (msg, fields) => {
    if (LEVELS[name] < min) return;
    write(JSON.stringify({ t: new Date().toISOString(), level: name, msg, ...(fields ? clean(fields) : {}) }), LEVELS[name]);
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
