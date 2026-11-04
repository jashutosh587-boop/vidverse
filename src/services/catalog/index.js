import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newVideoId } from '../../lib/ids.js';
import { run, sniffImage } from '../transcoder.js';
import { MEDIA_HOSTS, archiveDetails, archiveSearch, nasaDetails, nasaSearch } from './providers.js';

/**
 * The catalog: openly licensed videos that play straight from the archive that holds them.
 *
 * It runs as background jobs, one page of one source per job, so a run can be interrupted at any point and simply
 * continues, and uploads waiting to be processed never wait more than a page. Each candidate is checked before it
 * goes in: licence (in providers.js), a real H.264 MP4 the browser can play (ffprobe reads the remote file), and a
 * thumbnail, which is the only thing stored on this server. Anything refused is remembered in catalog_skips and never
 * fetched again; so is anything staff delete.
 */

/** The channels that hold the catalog. They belong to the site: no usable password, never sign in, never earn. */
export const CHANNELS = {
  space: {
    handle: 'space-archive',
    name: 'Space Archive',
    hue: 22,
    bio: 'Public-domain video from the NASA Image and Video Library: launches, missions, Earth and the planets. Each video credits its source. Vidverse is not affiliated with or endorsed by NASA.',
  },
  shorts: {
    handle: 'vintage-shorts',
    name: 'Vintage Shorts',
    hue: 8,
    bio: 'Educational, industrial and everyday films from the 1930s to the 1960s, from the Prelinger Archives on the Internet Archive. All public domain, each credited. Vidverse is not affiliated with the Internet Archive.',
  },
  silent: {
    handle: 'silent-cinema',
    name: 'Silent Cinema',
    hue: 30,
    bio: 'Feature films from the silent era and the first talkies (up to 1930), public domain and hosted by the Internet Archive. Each film credits its source.',
  },
};

const nasa = (query, limit = 25) => ({ id: `nasa:${query}`, provider: 'nasa', query, channel: 'space', category: 'tech', limit });
const archive = (collection, maxYear, channel, category, limit) => ({ id: `archive:${collection}`, provider: 'archive', collection, maxYear, channel, category, limit });

/** What a full run imports, in this order. A source stops at its limit; later runs only add new items. */
export const DEFAULT_SOURCES = [
  nasa('apollo 11'),
  archive('prelinger', 1965, 'shorts', 'education', 220),
  nasa('international space station'),
  archive('feature_films', 1930, 'silent', 'film', 60),
  nasa('mars rover'),
  nasa('space shuttle launch'),
  nasa('hubble'),
  nasa('spacewalk'),
  nasa('earth from space'),
  nasa('artemis'),
  nasa('james webb space telescope'),
  nasa('solar dynamics observatory'),
  nasa('hurricane'),
  nasa('aurora'),
  nasa('apollo moon'),
  nasa('rocket launch'),
];

const MP4_DEMUXER = 'mov,mp4,m4a,3gp,3g2,mj2';
const AUDIO_OK = new Set(['aac', 'mp3']);
const MIN_SECONDS = 10;
const MAX_SECONDS = 3 * 3600;
const PAGE_SIZE = 25;
const MAX_JSON_BYTES = 6 * 1024 ** 2;
const MAX_IMAGE_BYTES = 8 * 1024 ** 2;

/** A refusal that should be remembered, as opposed to a network hiccup worth trying again on a later run. */
class Skip extends Error {}

export function createCatalogService(ctx, deps = {}) {
  const { db, config, clock, log, storage } = ctx;
  const sources = deps.sources ?? DEFAULT_SOURCES;
  const userAgent = `Vidverse/${config.version} (+${config.baseUrl}; catalog of public-domain video)`;
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // ---------------------------------------------------------------- network, all of it replaceable in tests

  async function fetchLimited(url, { maxBytes, accept }) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await pause(2000 * attempt);
      let res;
      try {
        res = await fetch(url, { headers: { 'user-agent': userAgent, accept }, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        continue;
      }
      if (!res.ok) throw new Skip(`HTTP ${res.status} from ${new URL(url).host}`);
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) throw new Skip('response too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Skip('response too large');
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), type: res.headers.get('content-type') ?? '' };
    }
    throw lastErr ?? new Error('request failed');
  }

  const get =
    deps.get ??
    (async (url, kind) => {
      const { body } = await fetchLimited(url, { maxBytes: MAX_JSON_BYTES, accept: 'application/json' });
      await pause(250); // be a polite client: these archives are run for the public good
      if (kind !== 'json') return body;
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        throw new Skip('the archive answered with something that is not JSON');
      }
    });

  const getImage = deps.getImage ?? ((url) => fetchLimited(url, { maxBytes: MAX_IMAGE_BYTES, accept: 'image/*' }).then((r) => r.body));

  /** Reads a remote MP4's header with ffprobe. Only https, only the MP4 demuxer, never a playlist. */
  const probeRemote =
    deps.probeRemote ??
    (async (url) => {
      try {
        const { stdout } = await run('ffprobe', ['-v', 'error', '-rw_timeout', '20000000', '-user_agent', userAgent, '-protocol_whitelist', 'https,tls,tcp', '-f', MP4_DEMUXER, '-print_format', 'json', '-show_format', '-show_streams', '-i', url], { timeoutMs: 60_000 });
        return JSON.parse(stdout);
      } catch (e) {
        const msg = `${e.message} ${e.stderr ?? ''}`;
        if (e.timedOut || /\b5\d\d\b|timed out|Connection (reset|refused)|Temporary failure|I\/O error/i.test(msg)) throw new Error(`could not reach ${new URL(url).host}`);
        throw new Skip('the file could not be read as MP4');
      }
    });

  /** A frame from the remote video, for items whose archive has no usable picture. */
  const frameFromRemote =
    deps.frameFromRemote ??
    (async (url, atSeconds, output) => {
      await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '20000000', '-user_agent', userAgent, '-protocol_whitelist', 'https,tls,tcp', '-ss', String(Math.max(0, atSeconds)), '-f', MP4_DEMUXER, '-i', url, '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360', '-q:v', '4', '-y', output], { timeoutMs: 90_000 });
    });

  /** Any JPEG, PNG or WebP becomes a 640x360 JPEG (decoded and re-encoded, which also drops metadata). */
  const imageToThumb =
    deps.imageToThumb ??
    (async (bytes, output) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-thumb-'));
      try {
        const raw = path.join(tmp, 'in');
        fs.writeFileSync(raw, bytes);
        const kind = sniffImage(raw);
        if (!kind) throw new Skip('not an image');
        const named = `${raw}.${kind}`;
        fs.renameSync(raw, named);
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-y', '-f', 'image2', '-i', named, '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360', '-q:v', '4', output], { timeoutMs: 30_000 });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

  // ---------------------------------------------------------------- checks

  /** Accepts a probed file only if every browser can play it as it is. */
  function playable(info) {
    const streams = info?.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!v) return { ok: false, why: 'no video track' };
    if (v.codec_name !== 'h264') return { ok: false, why: `video is ${v.codec_name ?? 'an unknown codec'}, not H.264` };
    if (v.pix_fmt && v.pix_fmt !== 'yuv420p' && v.pix_fmt !== 'yuvj420p') return { ok: false, why: `pixel format ${v.pix_fmt}` };
    const a = streams.find((s) => s.codec_type === 'audio');
    if (a && !AUDIO_OK.has(a.codec_name)) return { ok: false, why: `audio is ${a.codec_name}` };
    const seconds = Number(info.format?.duration ?? v.duration);
    if (!(seconds >= MIN_SECONDS)) return { ok: false, why: 'shorter than 10 seconds' };
    if (seconds > MAX_SECONDS) return { ok: false, why: 'longer than 3 hours' };
    const width = Number(v.width);
    const height = Number(v.height);
    if (!(width > 0 && height > 0 && width <= 3840 && height <= 2160)) return { ok: false, why: 'unusual frame size' };
    return { ok: true, durationMs: Math.round(seconds * 1000), width, height };
  }

  // ---------------------------------------------------------------- channels

  async function ensureChannels() {
    const ids = {};
    for (const [k, c] of Object.entries(CHANNELS)) {
      let row = await db.one('SELECT id, is_system FROM users WHERE lower(handle) = $1', [c.handle]);
      if (row && !row.is_system) {
        // Someone signed up with this handle first. Never take over a person's account: use a different handle.
        const alt = `${c.handle}-vv`;
        row = await db.one('SELECT id, is_system FROM users WHERE lower(handle) = $1 AND is_system', [alt]);
        if (!row) row = await createChannel({ ...c, handle: alt });
      } else if (!row) {
        row = await createChannel(c);
      }
      ids[k] = row.id;
    }
    return ids;
  }

  async function createChannel(c) {
    const now = clock();
    // '!' is not a valid password hash, so no password can ever match; login also refuses system accounts outright.
    return db.one(
      `INSERT INTO users (email, password_hash, handle, display_name, bio, avatar_hue, adult_confirmed_at, terms_version, terms_accepted_at, is_system, created_at)
       VALUES ($1, '!', $2, $3, $4, $5, $6, 'system', $6, true, $6)
       ON CONFLICT DO NOTHING RETURNING id, is_system`,
      [`${c.handle}@catalog.invalid`, c.handle, c.name, c.bio, c.hue, now],
    ).then(async (row) => row ?? db.one('SELECT id, is_system FROM users WHERE lower(handle) = $1', [c.handle]));
  }

  // ---------------------------------------------------------------- one item

  async function known(provider, key) {
    const r = await db.one(
      `SELECT (SELECT 1 FROM videos WHERE origin ->> 'provider' = $1 AND origin ->> 'key' = $2) AS imported,
              (SELECT 1 FROM catalog_skips WHERE provider = $1 AND key = $2) AS skipped`,
      [provider, key],
    );
    return !!(r?.imported || r?.skipped);
  }

  async function remember(provider, key, reason) {
    await db.query('INSERT INTO catalog_skips (provider, key, reason, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (provider, key) DO NOTHING', [provider, key, String(reason).slice(0, 300), clock()]);
  }

  async function makeThumb(id, thumbs, mediaUrl, durationMs) {
    const dir = storage.ensureVideoDir(id);
    const out = path.join(dir, 'thumb.jpg');
    for (const url of thumbs) {
      try {
        await imageToThumb(await getImage(url), out);
        if (fs.existsSync(out)) return url;
      } catch (e) {
        log.debug?.('catalog thumbnail failed', { url, err: e.message });
      }
    }
    await frameFromRemote(mediaUrl, Math.min(30, durationMs / 10000), out);
    if (!fs.existsSync(out)) throw new Error('no thumbnail could be made');
    return mediaUrl;
  }

  /** Brings in one candidate. Returns 'imported', 'known' or 'skipped'; throws only for problems worth retrying. */
  async function importOne(source, owners, candidate) {
    const { provider, key } = candidate;
    if (await known(provider, key)) return 'known';
    if (candidate.skip) {
      await remember(provider, key, candidate.skip);
      return 'skipped';
    }
    let details;
    let id = null;
    try {
      details = provider === 'nasa' ? await nasaDetails(get, candidate) : await archiveDetails(get, candidate, { maxYear: source.maxYear });
      if (details.skip) throw new Skip(details.skip);
      const item = { ...candidate, ...details };

      let chosen = null;
      const reasons = [];
      for (const url of item.media) {
        const check = playable(await probeRemote(url));
        if (check.ok) {
          chosen = { url, ...check };
          break;
        }
        reasons.push(check.why);
      }
      if (!chosen) throw new Skip(`no file every browser can play (${[...new Set(reasons)].join('; ')})`);

      id = newVideoId();
      const thumbSource = await makeThumb(id, item.thumbs, chosen.url, chosen.durationMs);
      const now = clock();
      const origin = {
        provider,
        key,
        feed: source.id,
        collection: item.collection,
        page_url: item.pageUrl,
        credit: item.credit,
        license: item.license,
        license_url: item.licenseUrl,
        year: item.year ?? null,
        thumb_source: thumbSource,
      };
      await db.query(
        `INSERT INTO videos (id, owner_id, title, description, tags, category, status, visibility, duration_ms, width, height, thumb_kind, thumb_name,
                             ad_status, source, media_url, origin, created_at, updated_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', 'public', $7, $8, $9, 'custom', 'thumb.jpg', $10, 'linked', $11, $12, $13, $13, $13)`,
        [id, owners[source.channel], item.title, item.description, item.tags ?? [], source.category, chosen.durationMs, chosen.width, chosen.height, config.ads.defaultEligible ? 'eligible' : 'none', chosen.url, JSON.stringify(origin), now],
      );
      return 'imported';
    } catch (e) {
      if (id) storage.removeVideo(id);
      if (e?.code === '23505') return 'known'; // imported by another worker at the same moment
      if (e instanceof Skip) {
        await remember(provider, key, e.message);
        log.debug?.('catalog skipped', { provider, key, reason: e.message });
        return 'skipped';
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- one page of one source

  async function countFeed(feedId) {
    const r = await db.one(`SELECT count(*)::int AS n FROM videos WHERE origin ->> 'feed' = $1`, [feedId]);
    return r.n;
  }

  async function totalLinked() {
    const r = await db.one(`SELECT count(*)::int AS n FROM videos WHERE source = 'linked'`);
    return r.n;
  }

  /**
   * Imports one page of one source. Returns what happened and where the run continues, or next = null at the end.
   * One item failing for a network reason does not stop the page; it is simply tried again on a later run.
   */
  async function importPage({ sourceIndex = 0, page = 1 } = {}) {
    const result = { source: sources[sourceIndex]?.id ?? null, page, imported: 0, known: 0, skipped: 0, failed: 0, next: null };
    const source = sources[sourceIndex];
    if (!source) return result;
    const nextSource = sourceIndex + 1 < sources.length ? { sourceIndex: sourceIndex + 1, page: 1 } : null;

    if ((await totalLinked()) >= config.catalog.maxVideos) return result; // the whole catalog is full: stop the run
    let have = await countFeed(source.id);
    if (have >= source.limit) return { ...result, next: nextSource };

    const owners = await ensureChannels();
    const listing =
      source.provider === 'nasa'
        ? await nasaSearch(get, { query: source.query, page, pageSize: PAGE_SIZE })
        : await archiveSearch(get, { collection: source.collection, maxYear: source.maxYear, page, pageSize: PAGE_SIZE });

    for (const candidate of listing.items) {
      if (have >= source.limit) break;
      try {
        const outcome = await importOne(source, owners, candidate);
        result[outcome]++;
        if (outcome === 'imported') have++;
      } catch (e) {
        result.failed++;
        log.warn('catalog item failed, will retry on a later run', { provider: candidate.provider, key: candidate.key, err: e.message });
      }
    }
    const morePages = listing.hasMore && have < source.limit && page < 40;
    result.next = morePages ? { sourceIndex, page: page + 1 } : nextSource;
    return result;
  }

  // ---------------------------------------------------------------- thumbnails lost with a volume

  /** Re-creates thumbnails that are missing on disk (for example after moving to a new storage volume). */
  async function repairThumbs({ limit = 200 } = {}) {
    const { rows } = await db.query(`SELECT id, media_url, duration_ms, origin FROM videos WHERE source = 'linked' AND status = 'ready' ORDER BY id`);
    let fixed = 0;
    for (const v of rows) {
      if (fixed >= limit) break;
      const file = storage.resolve(v.id, 'thumb.jpg');
      if (file && fs.existsSync(file)) continue;
      try {
        await makeThumb(v.id, [v.origin?.thumb_source].filter((u) => u && u !== v.media_url), v.media_url, v.duration_ms);
        await db.query('UPDATE videos SET updated_at = $2 WHERE id = $1', [v.id, clock()]);
        fixed++;
      } catch (e) {
        log.warn('catalog thumbnail repair failed', { id: v.id, err: e.message });
      }
    }
    return fixed;
  }

  // ---------------------------------------------------------------- jobs

  const api = {
    CHANNELS,
    sources,
    ensureChannels,
    importPage,
    repairThumbs,
    playable,

    /** Extra hosts the watch page must allow in media-src to play this video. */
    mediaHosts(video) {
      if (video?.source !== 'linked') return [];
      return MEDIA_HOSTS[video.origin?.provider] ?? [];
    },

    async stats() {
      const { rows } = await db.query(
        `SELECT u.handle, u.display_name, count(v.id)::int AS videos FROM users u LEFT JOIN videos v ON v.owner_id = u.id AND v.status = 'ready'
          WHERE u.is_system GROUP BY u.handle, u.display_name ORDER BY u.handle`,
      );
      const skipped = await db.one('SELECT count(*)::int AS n FROM catalog_skips');
      return { channels: rows, skipped: skipped.n };
    },

    register(jobs) {
      jobs.register('catalog-import', async (payload) => {
        const r = await importPage(payload);
        log.info('catalog page', { source: r.source, page: r.page, imported: r.imported, known: r.known, skipped: r.skipped, failed: r.failed });
        if (r.next) {
          await jobs.enqueue('catalog-import', { ...r.next, run: payload.run }, { dedupeKey: `catalog:${payload.run}:${r.next.sourceIndex}:${r.next.page}` });
        } else {
          const s = await api.stats();
          log.info('catalog run finished', { run: payload.run, channels: s.channels.map((c) => `${c.handle}=${c.videos}`).join(' '), skippedTotal: s.skipped });
        }
      });
      jobs.register('catalog-repair', async () => {
        const fixed = await repairThumbs();
        if (fixed) log.info('catalog thumbnails repaired', { fixed });
      });
    },

    /** Starts today's run, once per day however many times it is called. Does nothing unless CATALOG_IMPORT is on. */
    async schedule() {
      if (!config.catalog.enabled) return false;
      const run = clock().toISOString().slice(0, 10);
      await ctx.jobs.enqueue('catalog-repair', {}, { dedupeKey: `catalog-repair:${run}` });
      const id = await ctx.jobs.enqueue('catalog-import', { sourceIndex: 0, page: 1, run }, { dedupeKey: `catalog:${run}:0:1` });
      return id !== null;
    },
  };
  return api;
}
