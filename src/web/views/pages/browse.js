import { html, ariaCurrent } from '../../../lib/html.js';
import { formatCount, timeAgo, formatMoney } from '../../../lib/format.js';
import { CATEGORIES } from '../../../lib/video-meta.js';
import { videoCard, videoGrid, pager, emptyState, avatar, icon, csrfField, barChart } from '../components.js';

/** A row of category links. The active one is marked for screen readers as well as by colour. */
export function categoryChips({ active, path }) {
  const href = (id) => (id ? `${path}?category=${id}` : path);
  return html`<nav class="chips" aria-label="Categories">
    <a class="chip" href="${href(null)}" ${ariaCurrent(!active)}>All</a>
    ${CATEGORIES.map(([id, label]) => html`<a class="chip" href="${href(id)}" ${ariaCurrent(active === id)}>${label}</a>`)}
  </nav>`;
}

const progressOf = (v) => (v.duration_ms ? (v.position_ms / v.duration_ms) * 100 : 0);

export function homePage(req, { feed, page, category, continueWatching, now }) {
  const showContinue = page === 1 && !category && continueWatching.length > 0;
  return html`<div class="page wide">
    <h1 class="sr-only">Home</h1>
    ${categoryChips({ active: category, path: '/' })}
    ${showContinue
      ? html`<section class="strip" aria-labelledby="cw-h"><h2 id="cw-h">Continue watching</h2>
          <div class="vgrid">${continueWatching.map((v) => videoCard(v, { now, progress: progressOf(v) }))}</div></section>`
      : ''}
    <section aria-labelledby="feed-h">
      <h2 id="feed-h" class="${showContinue ? '' : 'sr-only'}">${category ? CATEGORIES.find(([id]) => id === category)?.[1] : 'Recommended'}</h2>
      ${feed.items.length
        ? videoGrid(feed.items, { now })
        : emptyState({
            title: category ? 'Nothing in this category yet' : 'No videos yet',
            body: category ? 'Try another category, or be the first to upload one here.' : 'This site is new. Upload the first video and it will show up here.',
            action: html`<a class="btn btn-primary" href="/studio/upload">Upload a video</a>`,
          })}
      ${pager({ page, hasMore: feed.hasMore, path: '/', params: category ? { category } : {} })}
    </section>
  </div>`;
}

export function trendingPage(req, { feed, page, category, now }) {
  return html`<div class="page wide">
    <header class="pagehead"><h1>Trending</h1></header>
    <p class="lede">Videos people have watched past the first 30 seconds in the last three days. A video that viewers leave early does not rank, whatever its title promises.</p>
    ${categoryChips({ active: category, path: '/trending' })}
    ${feed.items.length
      ? videoGrid(feed.items, { now, headingLevel: 2 })
      : emptyState({ title: 'Nothing is trending yet', body: 'Videos appear here once people have watched them. Check back soon, or look at the newest videos on the home page.', action: html`<a class="btn btn-quiet" href="/">Go to Home</a>` })}
    ${pager({ page, hasMore: feed.hasMore, path: '/trending', params: category ? { category } : {} })}
  </div>`;
}

const SORTS = [
  ['relevance', 'Best match'],
  ['new', 'Newest'],
  ['views', 'Most viewed'],
];

export function resultsPage(req, { q, sort, channels, videos, page, now }) {
  const params = { q, ...(sort !== 'relevance' ? { sort } : {}) };
  const sortLink = (id) => `/results?${new URLSearchParams({ q, ...(id !== 'relevance' ? { sort: id } : {}) }).toString()}`;
  if (!q) {
    return html`<div class="page wide">
      <header class="pagehead"><h1>Search</h1></header>
      ${emptyState({ title: 'What do you want to watch?', body: 'Type a word in the search box above. You can search titles, tags and channel names.', action: html`<a class="btn btn-quiet" href="/trending">See what is trending</a>` })}
    </div>`;
  }
  return html`<div class="page wide">
    <header class="pagehead"><h1>Results for <q class="query">${q}</q></h1></header>
    <nav class="tabs" aria-label="Sort results">${SORTS.map(([id, label]) => html`<a href="${sortLink(id)}" ${ariaCurrent(sort === id, 'true')}>${label}</a>`)}</nav>
    ${page === 1 && channels.length
      ? html`<section aria-labelledby="ch-h"><h2 id="ch-h" class="sr-only">Channels</h2>
          <ul class="channellist">${channels.map((c) => html`<li><a class="channelitem" href="/@${c.handle}">${avatar(c, 'lg')}<span class="channeltext"><strong>${c.display_name}</strong><span class="muted">@${c.handle}</span><span class="muted">${formatCount(c.subscribers, 'subscriber')}</span>${c.bio ? html`<span class="clamp">${c.bio}</span>` : ''}</span></a></li>`)}</ul></section>`
      : ''}
    <section aria-labelledby="vid-h"><h2 id="vid-h" class="sr-only">Videos</h2>
      ${videos.items.length
        ? videoGrid(videos.items, { now })
        : channels.length
          ? ''
          : emptyState({ title: 'No results', body: 'Check the spelling, or try fewer or more general words.', action: html`<a class="btn btn-quiet" href="/trending">See what is trending</a>` })}
    </section>
    ${pager({ page, hasMore: videos.hasMore, path: '/results', params })}
  </div>`;
}

export function subscriptionsPage(req, { channels, feed, page, now }) {
  return html`<div class="page wide">
    <header class="pagehead"><h1>Subscriptions</h1></header>
    ${channels.length
      ? html`<ul class="avatarstrip" aria-label="Channels you subscribe to">${channels.map((c) => html`<li><a href="/@${c.handle}">${avatar(c, 'lg')}<span>${c.display_name}</span></a></li>`)}</ul>`
      : ''}
    ${feed.items.length
      ? videoGrid(feed.items, { now, headingLevel: 2 })
      : emptyState({
          title: channels.length ? 'No new videos from your channels' : 'You have not subscribed to anyone yet',
          body: channels.length ? 'When a channel you subscribe to publishes a video, it appears here, newest first.' : 'Subscribe to channels you like. Their newest videos show up here, in order, with nothing mixed in.',
          action: html`<a class="btn btn-quiet" href="/">Find something to watch</a>`,
        })}
    ${pager({ page, hasMore: feed.hasMore, path: '/subscriptions' })}
  </div>`;
}

function removeForm(req, action, fields, label, back) {
  return html`<form class="inline vremove" method="post" action="${action}">${csrfField(req)}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <input type="hidden" name="next" value="${back}">
    <button class="linkbtn" type="submit">${label}</button></form>`;
}

export function historyPage(req, { feed, page, week, today, now }) {
  const weekMs = week.reduce((s, d) => s + d.watchMs, 0);
  const minutes = (ms) => Math.round(ms / 60_000);
  const limit = req.user.daily_limit_minutes;
  return html`<div class="page wide">
    <header class="pagehead"><h1>Watch history</h1></header>
    <section class="panel timewatched" aria-labelledby="tw-h">
      <h2 id="tw-h">Time watched</h2>
      <p class="muted">Only you can see this. It is here so you can decide how you want to spend your time.</p>
      <div class="stats">
        <div class="stat"><p class="statnum">${formatCount(minutes(today), 'minute')}</p><p class="muted">Today</p></div>
        <div class="stat"><p class="statnum">${formatCount(minutes(weekMs / 7), 'minute')}</p><p class="muted">Daily average, last 7 days</p></div>
      </div>
      ${barChart({ points: week.map((d) => ({ label: d.day, value: minutes(d.watchMs) })), label: `Minutes watched per day over the last 7 days, ${minutes(weekMs)} in total`, unit: ' min' })}
      <p>${limit ? html`Your reminder is set to ${limit} minutes a day.` : html`You have no daily reminder.`} <a href="/settings/preferences">Change reminder and autoplay</a></p>
    </section>
    ${feed.items.length
      ? html`<div class="vgrid">${feed.items.map((v) => html`<div class="vwrap">${videoCard(v, { now, progress: v.completed ? 100 : progressOf(v) })}
            ${removeForm(req, '/history/remove', { video: v.id }, 'Remove from history', '/history')}</div>`)}</div>
          <details class="confirm"><summary class="btn btn-quiet">${icon('trash')} Clear all watch history</summary>
            <form method="post" action="/history/clear" class="stack">${csrfField(req)}<p>This removes every video from your history and your "continue watching" list. Your recommendations start fresh.</p><button class="btn btn-danger" type="submit">Yes, clear everything</button></form></details>`
      : emptyState({ title: 'Your history is empty', body: 'Videos you watch while signed in appear here, so you can pick up where you stopped.', action: html`<a class="btn btn-quiet" href="/">Find something to watch</a>` })}
    ${pager({ page, hasMore: feed.hasMore, path: '/history' })}
  </div>`;
}

export function watchLaterPage(req, { feed, page, now }) {
  return html`<div class="page wide">
    <header class="pagehead"><h1>Watch later</h1></header>
    ${feed.items.length
      ? html`<div class="vgrid">${feed.items.map((v) => html`<div class="vwrap">${videoCard(v, { now, headingLevel: 2 })}${removeForm(req, '/actions/save', { video: v.id, on: '0' }, 'Remove', '/watch-later')}</div>`)}</div>`
      : emptyState({ title: 'Nothing saved', body: 'Use "Watch later" under a video to keep it here for when you have time.', action: html`<a class="btn btn-quiet" href="/">Find something to watch</a>` })}
    ${pager({ page, hasMore: feed.hasMore, path: '/watch-later' })}
  </div>`;
}

export function likedPage(req, { feed, page, now }) {
  return html`<div class="page wide">
    <header class="pagehead"><h1>Liked videos</h1></header>
    ${feed.items.length
      ? videoGrid(feed.items, { now, headingLevel: 2 })
      : emptyState({ title: 'No liked videos', body: 'Press the thumbs-up under a video you enjoyed and it is saved here.', action: html`<a class="btn btn-quiet" href="/">Find something to watch</a>` })}
    ${pager({ page, hasMore: feed.hasMore, path: '/liked' })}
  </div>`;
}

/** Turns a notification row into { text, href }. Values come from our own services, but are still escaped by html``. */
export function describeNotification(n, config) {
  const d = n.data ?? {};
  const watch = d.videoId ? `/watch/${d.videoId}` : '/';
  switch (n.kind) {
    case 'new_video': return { text: html`<strong>${d.channel}</strong> published ${d.title}`, href: watch };
    case 'comment': return { text: html`<strong>${d.by}</strong> commented on ${d.title}`, href: `${watch}#c-${d.commentId}` };
    case 'reply': return { text: html`<strong>${d.by}</strong> replied to a comment on ${d.title}`, href: `${watch}#c-${d.commentId}` };
    case 'video_ready': return { text: html`${d.title} is ready to watch`, href: `/studio/videos/${d.videoId}` };
    case 'video_failed': return { text: html`We could not process ${d.title}: ${d.reason}`, href: `/studio/videos/${d.videoId}` };
    case 'tip': return { text: html`${d.from ?? 'A viewer'} sent you a tip of ${formatMoney(d.amountMinor, config.payments.currency)}`, href: '/studio/earnings' };
    case 'payout': return { text: html`Your payout of ${formatMoney(d.amountMinor, config.payments.currency)} is now ${d.status}${d.note ? `: ${d.note}` : ''}`, href: '/studio/payouts' };
    case 'policy': return { text: html`${d.title} was removed: ${d.reason}`, href: `/studio/videos/${d.videoId}` };
    case 'milestone': return { text: html`${d.title} passed ${formatCount(d.views, 'view')}`, href: watch };
    default: return { text: html`Update`, href: '/' };
  }
}

export function notificationsPage(req, { items, hasMore, page, config, now }) {
  const unread = items.some((n) => !n.read_at);
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Notifications</h1>
      ${unread ? html`<form method="post" action="/notifications/read" class="inline">${csrfField(req)}<button class="btn btn-quiet" type="submit">${icon('check')} Mark all as read</button></form>` : ''}</header>
    ${items.length
      ? html`<ul class="notifs">${items.map((n) => {
          const { text, href } = describeNotification(n, config);
          return html`<li class="notif ${n.read_at ? '' : 'unread'}"><a href="${href}"><span class="notif-text">${text}</span><span class="muted notif-time">${timeAgo(n.created_at, now)}${n.read_at ? '' : html`<span class="sr-only"> (unread)</span>`}</span></a></li>`;
        })}</ul>`
      : emptyState({ title: 'No notifications', body: 'We tell you about comments on your videos, replies, and new videos from channels where you turned the bell on. Nothing else.', action: html`<a class="btn btn-quiet" href="/settings/preferences">Notification settings</a>` })}
    ${pager({ page, hasMore, path: '/notifications' })}
  </div>`;
}

