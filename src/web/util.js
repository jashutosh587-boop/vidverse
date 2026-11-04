/** ?page=3 -> { page: 3, limit, offset }. Bad values fall back to page 1; absurdly deep pages are refused. */
export function pageOf(req, size = 24) {
  const n = Number.parseInt(String(req.query.page ?? '1'), 10);
  const page = Number.isInteger(n) && n >= 1 && n <= 500 ? n : 1;
  return { page, limit: size, offset: (page - 1) * size };
}

export const plainText = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
