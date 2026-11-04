/**
 * Where a creator wants to be paid: a UPI address or an Indian bank account. Checked here, encrypted before it is
 * stored, and shown back only as a short hint such as "ri••••@okbank" or "••••6789 · HDFC0001234".
 */

const UPI = /^([a-zA-Z0-9._-]{2,64})@([a-zA-Z][a-zA-Z0-9]{1,30})$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;
const HOLDER = /^[\p{L}][\p{L} .'-]{0,78}[\p{L}.]$/u;

const clean = (v, max) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** @returns {{ ok: true, method: string, details: object, hint: string } | { ok: false, errors: Record<string,string> }} */
export function parsePayoutDetails(input) {
  const method = input?.method === 'bank' ? 'bank' : input?.method === 'upi' ? 'upi' : null;
  if (!method) return { ok: false, errors: { method: 'Choose UPI or bank account.' } };

  if (method === 'upi') {
    const upi = clean(input.upi, 100).toLowerCase();
    const m = UPI.exec(upi);
    if (!m) return { ok: false, errors: { upi: 'Enter a UPI address such as name@bank.' } };
    return { ok: true, method, details: { upi }, hint: `${m[1].slice(0, 2)}••••@${m[2]}` };
  }

  const errors = {};
  const holder = clean(input.holder, 80);
  const account = clean(input.account, 30).replace(/[\s-]/g, '');
  const ifsc = clean(input.ifsc, 20).toUpperCase().replace(/\s/g, '');
  if (!HOLDER.test(holder)) errors.holder = 'Enter the account holder’s name, as it appears at the bank.';
  if (!ACCOUNT.test(account)) errors.account = 'Account numbers have 9 to 18 digits.';
  if (!IFSC.test(ifsc)) errors.ifsc = 'An IFSC code looks like HDFC0001234.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, method, details: { holder, account, ifsc }, hint: `••••${account.slice(-4)} · ${ifsc}` };
}
