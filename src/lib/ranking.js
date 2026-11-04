/**
 * How videos are ordered on the home page, in related lists and on Trending.
 *
 * The principle: reach comes from people actually liking what they clicked. A video that many people start and
 * quickly leave (the signature of a misleading title or thumbnail) gets less reach, because the average share of the
 * video that viewers watch is squared in the score. New videos get a short, fair exploration boost so creators can
 * gather signal before the numbers decide.
 */
export const PRIOR_RETENTION = 0.4; // what we assume about a video nobody has watched yet
export const PRIOR_WEIGHT = 15; // how many "average" viewers that assumption is worth

/** Average share of the video watched per viewer, pulled towards the prior while there are few viewers. */
export function avgViewed(v) {
  return (Number(v.retention_sum) + PRIOR_RETENTION * PRIOR_WEIGHT) / (Number(v.retention_n) + PRIOR_WEIGHT);
}

/** Share of votes that are likes, smoothed so one like on a new video is not "100%". */
export function likeRatio(v) {
  return (v.likes + 2) / (v.likes + v.dislikes + 4);
}

export function freshness(ageDays, halfLifeDays = 21) {
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

export function exploration(ageDays, views) {
  return ageDays < 3 && views < 50 ? 1.5 * (1 - views / 50) : 0;
}

/**
 * @param v        video row with views, likes, dislikes, retention_sum, retention_n and a published date
 * @param opts     now, recentViews (qualified views lately), affinity 0..1 (how well it fits this viewer), watched
 */
export function score(v, { now = new Date(), recentViews = null, affinity = 0, watched = false } = {}) {
  const ageDays = (now.getTime() - new Date(v.published_at).getTime()) / 86_400_000;
  const reach = Math.log10((recentViews ?? Number(v.views)) + 10);
  const quality = avgViewed(v) ** 2 * likeRatio(v) ** 0.5;
  let s = reach * quality * freshness(ageDays) ** 0.7 * (1 + exploration(ageDays, Number(v.views))) * (1 + 0.6 * affinity);
  if (watched) s *= 0.3;
  return s;
}

/** Trending: quality-weighted qualified views over the last few days. */
export function trendScore(v, { recentViews }) {
  return recentViews * avgViewed(v) ** 1.5 * likeRatio(v) ** 0.5;
}

/** Keeps one channel from filling the top of a list: after `perChannel` videos from it within `window` items, the rest move down. */
export function diversify(items, { perChannel = 2, window = 12 } = {}) {
  const head = [];
  const tail = [];
  const count = new Map();
  for (const it of items) {
    const key = it.owner_id;
    if (head.length < window && (count.get(key) ?? 0) >= perChannel) {
      tail.push(it);
      continue;
    }
    head.push(it);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...head, ...tail];
}

/** How well a video fits what a viewer has been watching: 0..1, from category and tag weights. */
export function affinityOf(v, profile) {
  if (!profile) return 0;
  const cat = profile.categories.get(v.category) ?? 0;
  const tagBest = Math.max(0, ...(v.tags ?? []).map((t) => profile.tags.get(t) ?? 0));
  return Math.min(1, 0.6 * cat + 0.4 * tagBest);
}
