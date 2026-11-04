const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** 125000 ms -> "2:05"; 3 725 000 ms -> "1:02:05". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function compactNumber(n) {
  return compact.format(Number(n) || 0);
}

export function formatCount(n, singular, plural = `${singular}s`) {
  const v = Number(n) || 0;
  return `${compactNumber(v)} ${v === 1 ? singular : plural}`;
}

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(date, now = new Date()) {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 1000));
  for (const [name, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const formatDate = (d) => dateFmt.format(new Date(d));

/** Integer minor units (paise) -> "₹1,234.50". Only INR-style two-decimal currencies are supported. */
export function formatMoney(minor, currency = 'INR') {
  const v = Number(minor) / 100;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency }).format(v);
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** UTC calendar day as YYYY-MM-DD. */
export const dayString = (d = new Date()) => d.toISOString().slice(0, 10);

/** 125000 ms -> "PT2M5S" (ISO 8601 duration, for search engines). */
export function isoDuration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
/** "4 Nov 2026, 13:05 UTC". For staff pages, where the exact time matters. */
export const formatDateTime = (d) => `${dateTimeFmt.format(new Date(d))} UTC`;
