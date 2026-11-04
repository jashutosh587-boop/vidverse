/**
 * Money helpers. Every amount is an integer number of minor units (paise); floating point is never used for money.
 */

const isMoney = (n) => Number.isSafeInteger(n) && n >= 0;

/** The platform fee on an amount, in basis points (1000 = 10%), rounded to the nearest paisa (halves round up). */
export function feeOf(amountMinor, feeBps) {
  if (!isMoney(amountMinor) || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError('Invalid amount or fee');
  return Number((BigInt(amountMinor) * BigInt(feeBps) + 5000n) / 10_000n);
}

/** Splits a payment into the platform fee and what the creator receives. fee + net always equals amount. */
export function splitTip(amountMinor, feeBps) {
  const fee = feeOf(amountMinor, feeBps);
  return { fee, net: amountMinor - fee };
}

/**
 * Divides `pool` among entries in proportion to their weights using the largest-remainder method, so that the parts
 * add up to exactly `pool`. Entries with zero weight get nothing. Ties are broken by key so the result never depends
 * on input order.
 * @param {number} pool minor units
 * @param {{key: string, weight: number}[]} entries
 * @returns {Map<string, number>}
 */
export function allocate(pool, entries) {
  if (!isMoney(pool)) throw new RangeError('Invalid pool');
  const live = entries.filter((e) => Number.isSafeInteger(e.weight) && e.weight > 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = new Map();
  if (!live.length || pool === 0) return out;
  const total = live.reduce((s, e) => s + BigInt(e.weight), 0n);
  const P = BigInt(pool);
  const shares = live.map((e) => {
    const exact = P * BigInt(e.weight);
    return { key: e.key, floor: exact / total, rem: exact % total };
  });
  let left = P - shares.reduce((s, x) => s + x.floor, 0n);
  const byRemainder = [...shares].sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : 1) : a.rem > b.rem ? -1 : 1));
  for (const s of byRemainder) {
    if (left <= 0n) break;
    s.floor += 1n;
    left -= 1n;
  }
  for (const s of shares) if (s.floor > 0n) out.set(s.key, Number(s.floor));
  return out;
}

/** Whole rupees typed by a person ("250", "250.50") -> minor units, or null when it is not a valid amount. */
export function parseAmount(input) {
  const s = String(input ?? '').trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

/** Minor units -> a plain decimal string with two places ("1234.50", "-0.90"). No floating point arithmetic is involved. */
export function toDecimal(minor) {
  const n = Number(minor);
  if (!Number.isSafeInteger(n)) throw new RangeError('Invalid amount');
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
