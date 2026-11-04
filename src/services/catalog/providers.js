/**
 * Adapters for the archives the catalog draws on. Each one turns an archive's search results and item details into
 * plain "candidates" with a licence the site can rely on, and rejects anything whose rights are unclear.
 *
 * Only two kinds of material are accepted:
 *   - NASA Image and Video Library: NASA-produced media is generally not subject to copyright in the United States.
 *     Items that mention a third party's rights ("courtesy of", "copyright", "©" and similar) are refused, because
 *     NASA's own guidelines say such material is not NASA's to give away.
 *   - Internet Archive items that carry an explicit public-domain licence (Public Domain Mark or CC0) AND are old
 *     enough to be public domain both in the United States and in India: films are public domain in India 60 years
 *     after the year of publication, in the United States after 95 years for works of that era. So Prelinger
 *     Archives films up to 1965, and feature films up to 1930.
 *
 * Nothing here talks to the network directly: `get(url)` is passed in, which keeps these functions testable.
 */

import { parseTags } from '../../lib/video-meta.js';

export const NASA_API = 'https://images-api.nasa.gov';
export const IA_BASE = 'https://archive.org';

/** Hosts a browser contacts to play media from each provider. Used to widen media-src on that watch page only. */
export const MEDIA_HOSTS = {
  nasa: ['https://images-assets.nasa.gov'],
  // /download/ links on archive.org redirect to a storage server such as ia800300.us.archive.org.
  archive: ['https://archive.org', 'https://*.archive.org'],
};

/** Words that suggest someone other than the archive holds rights in the material. */
const THIRD_PARTY = /©|\(c\)\s*\d{4}|copyright|courtesy\s+of|all rights reserved|used with permission|licensed (from|by)|not for (commercial|public) (use|distribution)|music (by|courtesy)|getty|associated press|\bap photo\b|reuters/i;

const PD_LICENSES = [
  [/^https?:\/\/creativecommons\.org\/publicdomain\/mark\/1\.0\/?$/i, 'Public domain'],
  [/^https?:\/\/creativecommons\.org\/licenses\/publicdomain\/?$/i, 'Public domain'],
  [/^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/i, 'CC0 (public domain dedication)'],
];

export function publicDomainLabel(licenseUrl) {
  const url = String(licenseUrl ?? '').trim();
  for (const [re, label] of PD_LICENSES) if (re.test(url)) return label;
  return null;
}

// ---------------------------------------------------------------- text helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Archive descriptions are often HTML. Keep the words, lose the markup, and stay within the database limits. */
export function plainDescription(input, max = 3000) {
  let s = Array.isArray(input) ? input.join('\n\n') : String(input ?? '');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n\n').replace(/<[^>]*>/g, ' ');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return safeChar(Number.parseInt(k.slice(2), 16));
    if (k.startsWith('#') && k !== '#39') return safeChar(Number(k.slice(1)));
    return ENTITIES[k] ?? m;
  });
  // Control characters out (tabs and newlines stay), runs of spaces collapsed, at most one blank line in a row.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return s;
}

function safeChar(code) {
  return Number.isInteger(code) && code > 31 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}

export function shortTitle(input, max = 100) {
  const s = plainDescription(input, 1000).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const httpsOnly = (u) => {
  const s = String(u ?? '').trim().replace(/^http:\/\//i, 'https://').replace(/ /g, '%20');
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && s.length <= 2000 ? url.toString() : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- NASA Image and Video Library

/**
 * One page of a NASA search. Returns { items, hasMore }. Each item still needs `nasaDetails` for its files.
 * Rejected items come back with a `skip` reason instead of being silently dropped, so they are remembered.
 */
export async function nasaSearch(get, { query, page = 1, pageSize = 25 }) {
  const url = `${NASA_API}/search?${new URLSearchParams({ q: query, media_type: 'video', page: String(page), page_size: String(pageSize) })}`;
  const body = await get(url, 'json');
  const items = body?.collection?.items ?? [];
  const out = [];
  for (const it of items) {
    const d = it?.data?.[0];
    if (!d?.nasa_id || d.media_type !== 'video') continue;
    const key = String(d.nasa_id).slice(0, 200);
    const title = shortTitle(d.title);
    const description = plainDescription(d.description ?? d.description_508 ?? '');
    const base = { provider: 'nasa', key };
    if (!title) {
      out.push({ ...base, skip: 'no title' });
      continue;
    }
    const rights = [d.title, d.description, d.description_508, d.photographer, d.secondary_creator, ...(d.keywords ?? [])].filter(Boolean).join(' \n ');
    if (THIRD_PARTY.test(rights)) {
      out.push({ ...base, skip: 'mentions rights held by someone else' });
      continue;
    }
    const center = typeof d.center === 'string' && /^[A-Z]{2,6}$/.test(d.center) ? d.center : null;
    const year = Number(String(d.date_created ?? '').slice(0, 4)) || null;
    out.push({
      ...base,
      title,
      description,
      tags: parseTags((d.keywords ?? []).slice(0, 15).join(',')),
      year,
      credit: center ? `NASA/${center}` : 'NASA',
      license: 'Public domain (NASA media)',
      licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(key)}`,
      collection: 'NASA Image and Video Library',
      manifestUrl: httpsOnly(it.href),
      previewUrl: httpsOnly((it.links ?? []).find((l) => l?.rel === 'preview')?.href),
    });
  }
  const total = Number(body?.collection?.metadata?.total_hits ?? 0);
  const hasMore = (body?.collection?.links ?? []).some((l) => l?.rel === 'next') || page * pageSize < total;
  return { items: out, hasMore: hasMore && items.length > 0 };
}

/** NASA's file sizes in the order we would rather stream them: big enough to look good, small enough to start fast. */
const NASA_VIDEO_PREFERENCE = ['~medium.mp4', '~mobile.mp4', '~small.mp4', '~large.mp4', '~preview.mp4', '~orig.mp4'];
const NASA_IMAGE = /~(large|medium|small|thumb|orig)[^/]*\.(jpe?g|png)$/i;

/** Fills in the files for one NASA item from its asset list (a JSON array of URLs). */
export async function nasaDetails(get, item) {
  if (!item.manifestUrl || !item.manifestUrl.startsWith('https://images-assets.nasa.gov/')) return { skip: 'no file list' };
  const list = await get(item.manifestUrl, 'json');
  const urls = (Array.isArray(list) ? list : []).map(httpsOnly).filter((u) => u && u.startsWith('https://images-assets.nasa.gov/'));
  const media = [];
  for (const suffix of NASA_VIDEO_PREFERENCE) {
    const hit = urls.find((u) => decodeURIComponent(u).toLowerCase().endsWith(suffix));
    if (hit) media.push(hit);
  }
  if (!media.length) return { skip: 'no MP4 file' };
  const images = urls.filter((u) => NASA_IMAGE.test(decodeURIComponent(u)));
  const rank = (u) => ['large', 'medium', 'orig', 'small', 'thumb'].findIndex((k) => decodeURIComponent(u).toLowerCase().includes(`~${k}`));
  images.sort((a, b) => rank(a) - rank(b));
  const thumbs = [...images, item.previewUrl].filter(Boolean);
  return { media, thumbs };
}

// ---------------------------------------------------------------- Internet Archive

/** One page of an Internet Archive advanced search. Returns { items, hasMore }. */
export async function archiveSearch(get, { collection, maxYear, page = 1, pageSize = 25 }) {
  const q = `collection:(${collection}) AND mediatype:(movies) AND year:[1890 TO ${maxYear}] AND licenseurl:(*publicdomain*)`;
  const params = new URLSearchParams({ q, rows: String(pageSize), page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'licenseurl', 'downloads']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const body = await get(`${IA_BASE}/advancedsearch.php?${params}`, 'json');
  const docs = body?.response?.docs ?? [];
  const items = [];
  for (const d of docs) {
    const id = String(d?.identifier ?? '');
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) continue;
    items.push({ provider: 'archive', key: id, collection });
  }
  const total = Number(body?.response?.numFound ?? 0);
  return { items, hasMore: docs.length > 0 && page * pageSize < total };
}

/** Formats the Internet Archive uses for H.264 MP4 files, best first. */
const IA_FORMATS = ['h.264', 'h.264 ia', 'mpeg4', '512kb mpeg4'];

/** Reads one item's metadata, re-checks its licence and year, and picks its MP4 and thumbnail. */
export async function archiveDetails(get, item, { maxYear }) {
  const meta = await get(`${IA_BASE}/metadata/${encodeURIComponent(item.key)}`, 'json');
  const m = meta?.metadata;
  if (!m) return { skip: 'no metadata' };
  if (m.mediatype && m.mediatype !== 'movies') return { skip: 'not a video item' };
  const license = publicDomainLabel(first(m.licenseurl));
  if (!license) return { skip: 'no public-domain licence on the item' };
  const year = Number(String(first(m.year) ?? first(m.date) ?? '').slice(0, 4));
  if (!(year >= 1890 && year <= maxYear)) return { skip: `year ${year || 'unknown'} is after ${maxYear}` };
  const title = shortTitle(first(m.title));
  if (!title) return { skip: 'no title' };
  const description = plainDescription(m.description ?? '');
  const rights = [first(m.rights), first(m['possible-copyright-status']), first(m.notes)].filter(Boolean).join(' ');
  if (rights && /in copyright|rights reserved|not in the public domain/i.test(rights)) return { skip: 'item notes say it is in copyright' };

  const files = Array.isArray(meta.files) ? meta.files : [];
  const mp4s = files
    .filter((f) => typeof f?.name === 'string' && /\.mp4$/i.test(f.name) && !f.name.includes('/') && IA_FORMATS.includes(String(f.format ?? '').toLowerCase()))
    .sort((a, b) => IA_FORMATS.indexOf(String(a.format).toLowerCase()) - IA_FORMATS.indexOf(String(b.format).toLowerCase()));
  if (!mp4s.length) return { skip: 'no H.264 MP4 file' };
  const fileUrl = (name) => `${IA_BASE}/download/${encodeURIComponent(item.key)}/${encodeURIComponent(name)}`;
  const subjects = (Array.isArray(m.subject) ? m.subject : String(m.subject ?? '').split(';')).slice(0, 15);
  const creator = shortTitle(first(m.creator) ?? '', 80);
  return {
    title,
    description,
    tags: parseTags(subjects.join(',')),
    year,
    credit: creator || (item.collection === 'prelinger' ? 'Prelinger Archives' : 'Internet Archive'),
    license,
    licenseUrl: String(first(m.licenseurl)).replace(/^http:/, 'https:'),
    pageUrl: `${IA_BASE}/details/${encodeURIComponent(item.key)}`,
    collection: item.collection === 'prelinger' ? 'Prelinger Archives, Internet Archive' : 'Internet Archive',
    media: mp4s.slice(0, 3).map((f) => fileUrl(f.name)),
    thumbs: [`${IA_BASE}/services/img/${encodeURIComponent(item.key)}`],
  };
}
