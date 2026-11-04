import { html } from '../../../lib/html.js';
import { formatCount, formatDate, timeAgo, formatDuration } from '../../../lib/format.js';
import { categoryLabel } from '../../../lib/video-meta.js';
import { REPORT_REASONS } from '../../../services/moderation.js';
import { avatar, icon, csrfField, thumbUrl, field } from '../components.js';
import { adSlot } from '../ads.js';

const TS_RE = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;

/** The description as text, with m:ss times turned into links that seek the player. */
function describe(text, videoId, durationMs) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(TS_RE)) {
    const secs = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    if (secs * 1000 > durationMs) continue;
    parts.push(text.slice(last, m.index), html`<a href="/watch/${videoId}?t=${secs}" data-seek="${secs}">${m[0]}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function actionForm(req, action, fields, button, { hidden = false } = {}) {
  return html`<form class="inline" method="post" action="/actions/${action}" data-action="${action}" ${hidden ? 'hidden' : ''}>
    ${csrfField(req)}
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${button}
  </form>`;
}

function compact(v, now) {
  return html`<article class="vcompact">
    <a class="vthumb" href="/watch/${v.id}" tabindex="-1" aria-hidden="true"><img src="${thumbUrl(v)}" alt="" width="168" height="94" loading="lazy" decoding="async"><span class="timecode vdur">${formatDuration(v.duration_ms)}</span></a>
    <div class="vtext"><h3 class="vtitle"><a href="/watch/${v.id}">${v.title}</a></h3><p class="vchannel"><a href="/@${v.channel_handle}">${v.channel_name}</a></p><p class="vstats"><span>${formatCount(v.views, 'view')}</span> <span>${timeAgo(v.published_at, now)}</span></p></div>
  </article>`;
}

export function commentItem(req, c, { video, isReply = false }) {
  const mine = req.user?.id === c.user_id;
  const canRemove = mine || req.user?.id === video.owner_id || req.user?.role === 'admin' || req.user?.role === 'moderator';
  return html`<li class="comment ${isReply ? 'reply' : ''}" id="c-${c.id}">
    <a class="cavatar" href="/@${c.handle}" tabindex="-1" aria-hidden="true">${avatar(c, 'sm')}</a>
    <div class="cbody">
      <p class="cmeta"><a href="/@${c.handle}"><strong>${c.display_name}</strong></a> <span class="muted">${timeAgo(c.created_at)}</span>${c.user_id === video.owner_id ? html` <span class="pill">Creator</span>` : ''}</p>
      <p class="ctext">${c.body}</p>
      <div class="cactions">
        ${req.user && !isReply && video.comments_enabled
          ? html`<details class="replybox"><summary>Reply</summary>
              <form method="post" action="/videos/${video.id}/comments" class="stack">${csrfField(req)}<input type="hidden" name="parent_id" value="${c.id}">
                <label class="sr-only" for="reply-${c.id}">Your reply</label><textarea class="input textarea" id="reply-${c.id}" name="body" rows="2" maxlength="1000" required></textarea>
                <button class="btn btn-quiet" type="submit">Reply</button></form></details>`
          : ''}
        ${canRemove ? html`<form class="inline" method="post" action="/comments/${c.id}/delete">${csrfField(req)}<input type="hidden" name="video" value="${video.id}"><button class="linkbtn" type="submit">Delete</button></form>` : ''}
        ${req.user && !mine ? html`<a class="linkbtn" href="/report?type=comment&amp;id=${c.id}">Report</a>` : ''}
      </div>
      ${(c.replies ?? []).length ? html`<ul class="replies">${c.replies.map((r) => commentItem(req, r, { video, isReply: true }))}</ul>` : ''}
      ${c.reply_count > (c.replies ?? []).length ? html`<p><a href="/watch/${video.id}?replies=${c.id}#c-${c.id}">View all ${c.reply_count} replies</a></p>` : ''}
    </div>
  </li>`;
}

function commentsSection(req, { video, comments, thread, cpage, canComment, commentGate }) {
  return html`<section id="comments" class="comments" aria-labelledby="comments-h">
    <h2 id="comments-h">${formatCount(video.comment_count, 'comment')}</h2>
    ${!video.comments_enabled
      ? html`<p class="muted">The creator turned comments off for this video.</p>`
      : canComment
        ? html`<form method="post" action="/videos/${video.id}/comments" class="commentform">${csrfField(req)}
            <label class="sr-only" for="comment-body">Add a comment</label>
            <textarea class="input textarea" id="comment-body" name="body" rows="2" maxlength="1000" required placeholder="Add a comment. Be kind; links are not clickable."></textarea>
            <button class="btn btn-primary" type="submit">Comment</button></form>`
        : html`<p class="muted">${commentGate}</p>`}
    ${thread
      ? html`<p><a href="/watch/${video.id}#comments">${icon('list')} All comments</a></p><ul class="commentlist">${commentItem(req, thread, { video })}</ul>`
      : comments.items.length ? html`<ul class="commentlist">${comments.items.map((c) => commentItem(req, c, { video }))}</ul>` : video.comments_enabled ? html`<p class="muted">No comments yet.</p>` : ''}
    ${!thread && (cpage > 1 || comments.hasMore)
      ? html`<nav class="pager" aria-label="Comment pages">${cpage > 1 ? html`<a class="btn btn-quiet" href="/watch/${video.id}?cpage=${cpage - 1}#comments">Newer comments</a>` : html`<span></span>`}${comments.hasMore ? html`<a class="btn btn-quiet" href="/watch/${video.id}?cpage=${cpage + 1}#comments">Older comments</a>` : ''}</nav>`
      : ''}
  </section>`;
}

export function watchPage(req, p) {
  const { video, related, subscribers, subscribed, notify, myVote, saved, resume, comments, thread, cpage, next, ads, tipsEnabled, startAt, canComment, commentGate, autoplay, config, now } = p;
  const back = encodeURIComponent(`/watch/${video.id}`);
  const signedIn = !!req.user;
  const isOwner = req.user?.id === video.owner_id;
  const hlsUrl = `/media/v/${video.id}/master.m3u8`;
  const url = `${config.baseUrl}/watch/${video.id}`;
  return html`<div class="watch">
    <div class="watch-main">
      <div class="stage">
        <video id="player" class="player" controls playsinline preload="metadata" poster="${thumbUrl(video)}"
          data-hls="${hlsUrl}" data-video-id="${video.id}" data-duration="${video.duration_ms}" data-resume="${Math.floor(resume / 1000)}" data-start="${startAt ?? ''}"
          data-next="${next ? `/watch/${next.id}` : ''}" data-next-title="${next?.title ?? ''}" data-autoplay="${autoplay ? '1' : '0'}" data-signed-in="${signedIn ? '1' : '0'}">
          <p>Your browser cannot play this video. Try a recent version of Chrome, Firefox, Edge or Safari.</p>
        </video>
        <div class="upnext" hidden data-upnext role="alertdialog" aria-labelledby="upnext-title">
          <p class="muted">Up next in <span data-upnext-count>5</span></p>
          <p id="upnext-title" class="upnext-title" data-upnext-title></p>
          <p class="row"><button type="button" class="btn btn-primary" data-upnext-now>Play now</button><button type="button" class="btn btn-quiet" data-upnext-cancel>Cancel</button></p>
        </div>
        <div class="upnext" hidden data-stillwatching role="alertdialog" aria-label="Still watching?">
          <p class="upnext-title">Still watching?</p><p class="muted">We paused autoplay after a few videos in a row.</p>
          <p class="row"><button type="button" class="btn btn-primary" data-stillwatching-continue>Keep watching</button></p>
        </div>
      </div>
      <div class="playertools">
        <label>Quality <select id="quality" disabled><option value="-1">Auto</option></select></label>
        <label>Speed <select id="speed">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => html`<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}x</option>`)}</select></label>
        <label class="check"><input type="checkbox" id="autoplay-toggle" ${autoplay ? 'checked' : ''}> <span>Autoplay next</span></label>
        <span class="muted kbd">Keys: K play or pause, J and L skip 10 seconds, F full screen, M mute</span>
      </div>
      <h1 class="watch-title">${video.title}</h1>
      ${video.has_paid_promotion ? html`<p class="paidlabel">${icon('flag')} Includes paid promotion</p>` : ''}
      <div class="watch-bar">
        <div class="channelrow">
          <a href="/@${video.channel_handle}" class="channelrow-link">${avatar({ channel_name: video.channel_name, channel_hue: video.channel_hue }, 'md')}
            <span><strong>${video.channel_name}</strong><span class="muted block" data-subscribers>${formatCount(subscribers, 'subscriber')}</span></span></a>
          ${isOwner
            ? html`<a class="btn btn-quiet" href="/studio/videos/${video.id}">${icon('edit')} Edit</a>`
            : signedIn
              ? html`${actionForm(req, 'subscribe', { channel: video.owner_id, on: subscribed ? '0' : '1', next: `/watch/${video.id}` }, html`<button class="btn ${subscribed ? 'btn-quiet' : 'btn-primary'}" type="submit" aria-pressed="${String(!!(subscribed))}" data-label-on="Subscribed" data-label-off="Subscribe">${subscribed ? 'Subscribed' : 'Subscribe'}</button>`)}
                ${actionForm(req, 'notify', { channel: video.owner_id, on: notify ? '0' : '1', next: `/watch/${video.id}` }, html`<button class="btn btn-quiet" type="submit" aria-pressed="${String(!!(notify))}" aria-label="${notify ? 'Turn off notifications for this channel' : 'Notify me about new videos'}" title="Notify me about new videos">${icon('bell')}</button>`, { hidden: !subscribed })}`
              : html`<a class="btn btn-primary" href="/login?next=${back}">Subscribe</a>`}
          ${tipsEnabled && !isOwner ? html`<a class="btn btn-support" href="/support/@${video.channel_handle}?video=${video.id}">${icon('heart')} Support</a>` : ''}
        </div>
        <div class="actions">
          ${isOwner
            ? html`<span class="btn btn-quiet static">${icon('thumb')} <span class="sr-only">Likes:</span> ${video.likes}</span>`
            : signedIn
            ? html`${actionForm(req, 'vote', { video: video.id, value: myVote === 1 ? '0' : '1', next: `/watch/${video.id}` }, html`<button class="btn btn-quiet" type="submit" aria-pressed="${String(!!(myVote === 1))}">${icon('thumb')} <span class="sr-only">Like</span> <span data-likes>${video.likes}</span></button>`)}
              ${actionForm(req, 'vote', { video: video.id, value: myVote === -1 ? '0' : '-1', next: `/watch/${video.id}` }, html`<button class="btn btn-quiet" type="submit" aria-pressed="${String(!!(myVote === -1))}" aria-label="Dislike">${icon('thumb', 'icon flip')}</button>`)}
              ${actionForm(req, 'save', { video: video.id, on: saved ? '0' : '1', next: `/watch/${video.id}` }, html`<button class="btn btn-quiet" type="submit" aria-pressed="${String(!!(saved))}">${icon('clock')} <span class="label-text">${saved ? 'Saved' : 'Watch later'}</span></button>`)}`
            : html`<a class="btn btn-quiet" href="/login?next=${back}">${icon('thumb')} <span class="sr-only">Sign in to like. Likes:</span> ${video.likes}</a>`}
          <details class="share"><summary class="btn btn-quiet">${icon('share')} Share</summary><div class="sharebox"><label class="sr-only" for="share-url">Link to this video</label><input id="share-url" class="input" readonly value="${url}" data-select-on-focus></div></details>
          ${signedIn && !isOwner ? html`<a class="btn btn-quiet" href="/report?type=video&amp;id=${video.id}">${icon('flag')} Report</a>` : ''}
        </div>
      </div>
      <section class="descbox" aria-label="About this video">
        <p class="muted"><strong>${formatCount(video.views, 'view')}</strong> <span>${formatDate(video.published_at ?? video.created_at)}</span> <span>${categoryLabel(video.category)}</span></p>
        ${video.description ? html`<p class="desc">${describe(video.description, video.id, video.duration_ms)}</p>` : ''}
        ${(video.tags ?? []).length ? html`<p class="tags">${video.tags.map((t) => html`<a class="chip" href="/results?q=${encodeURIComponent(t)}">${t}</a> `)}</p>` : ''}
      </section>
      ${ads ? adSlot(config, config.ads.slotWatchTop) : ''}
      ${commentsSection(req, { video, comments, thread, cpage, canComment, commentGate })}
    </div>
    <aside class="watch-side" aria-label="More videos">
      ${ads ? adSlot(config, config.ads.slotWatchSide) : ''}
      <h2>Up next</h2>
      ${related.length ? related.map((v) => compact(v, now)) : html`<p class="muted">Nothing else to watch yet.</p>`}
    </aside>
  </div>`;
}

export function reportPage(req, { type, id, label, error = '' }) {
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Report ${type}</h1></header>
    <p class="lede">You are reporting: <strong>${label}</strong></p>
    <form method="post" action="/report" class="stack" novalidate>
      ${csrfField(req)}
      <input type="hidden" name="type" value="${type}"><input type="hidden" name="id" value="${id}">
      ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
      ${field({ name: 'reason', label: 'What is wrong?', type: 'select', value: 'other', options: REPORT_REASONS.map(([value, label]) => ({ value, label })) })}
      ${field({ name: 'details', label: 'Anything we should know? (optional)', type: 'textarea', rows: 4, maxlength: 1000 })}
      <p class="muted">Reports go to our moderators. We do not tell the person who reported them. For copyright, please use the <a href="/legal/copyright">copyright page</a>; for something urgent, contact us.</p>
      <p><button class="btn btn-primary" type="submit">Send report</button> <a class="btn btn-quiet" href="/">Cancel</a></p>
    </form>
  </div>`;
}
