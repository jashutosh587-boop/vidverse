// A short blocklist of the passwords attackers try first. It is a floor, not a substitute for length.
const COMMON = new Set(
  `password passw0rd p@ssw0rd p@ssword letmein welcome admin administrator login qwerty qwertyuiop asdfgh asdfghjkl zxcvbnm iloveyou monkey dragon football baseball
  master shadow superman batman sunshine princess starwars whatever trustno1 abc123 changeme secret computer internet freedom hello123 hello1234 india123 india1234
  samsung123 google123 youtube video videos vidverse 11111111 12345678 123456789 1234567890 0123456789 987654321 0987654321 1q2w3e4r 1q2w3e4r5t qazwsx zaq12wsx`
    .split(/\s+/)
    .filter(Boolean),
);

/** Returns a list of reasons the password is not acceptable (empty when it is fine). */
export function passwordProblems(password, { email = '', handle = '' } = {}) {
  const problems = [];
  const p = String(password ?? '');
  const length = [...p].length;
  if (length < 10) problems.push('Use at least 10 characters.');
  if (length > 128) problems.push('Use at most 128 characters.');
  const lower = p.toLowerCase();
  const stripped = lower.replace(/[\d\W_]+$/u, '');
  if (COMMON.has(lower) || COMMON.has(stripped)) problems.push('That password is too common.');
  if (length > 0 && new Set([...p]).size < 4) problems.push('Use a mix of different characters.');
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name in the password.');
  const h = String(handle).toLowerCase();
  if (h.length >= 4 && lower.includes(h)) problems.push('Do not include your handle in the password.');
  return problems;
}
