import { html } from '../../../lib/html.js';
import { formatCount, formatDuration, formatBytes, formatDate, formatMoney } from '../../../lib/format.js';
import { CATEGORIES } from '../../../lib/video-meta.js';
import { field, csrfField, barChart, tabs, emptyState, thumbUrl, icon } from '../components.js';

const NAV = [
  { id: 'dashboard', href: '/studio', label: 'Dashboard' },
  { id: 'videos', href: '/studio/videos', label: 'Videos' },
  { id: 'upload', href: '/studio/upload', label: 'Upload' },
  { id: 'earnings', href: '/studio/earnings', label: 'Earnings' },
  { id: 'payouts', href: '/studio/payouts', label: 'Payouts' },
];
const MONEY_TABS = new Set(['earnings', 'payouts']);
/** The Studio tabs. Earnings and Payouts only appear when the site has a payment provider configured. */
export const studioNav = (active, req) => tabs(req?.ctx?.monetization ? NAV : NAV.filter((i) => !MONEY_TABS.has(i.id)), active);

const STATUS = { uploading: 'Waiting for file', processing: 'Processing', ready: 'Ready', failed: 'Failed', removed: 'Removed' };
const VIS = { public: 'Public', unlisted: 'Unlisted', private: 'Private' };

export function studioDashboard(req, { overview, videos, steps, money }) {
  const hours = overview.watchMs / 3_600_000;
  return html`<div class="page">
    <header class="pagehead"><h1>Studio</h1><a class="btn btn-primary" href="/studio/upload">${icon('upload')} Upload a video</a></header>
    ${studioNav('dashboard', req)}
    ${steps.length
      ? html`<section class="panel" aria-labelledby="steps-h"><h2 id="steps-h">Get set up to earn</h2>
          <ol class="steps">${steps.map((s) => html`<li class="${s.done ? 'done' : ''}"><span class="stepmark" aria-hidden="true">${s.done ? icon('check') : ''}</span><span>${s.href && !s.done ? html`<a href="${s.href}">${s.label}</a>` : s.label}${s.done ? html` <span class="sr-only">(done)</span>` : ''}</span></li>`)}</ol></section>`
      : ''}
    <section class="stats" aria-label="Last ${overview.days} days">
      <div class="stat"><p class="statnum">${formatCount(overview.views, 'view')}</p><p class="muted">Views, last ${overview.days} days</p></div>
      <div class="stat"><p class="statnum">${hours.toFixed(hours < 10 ? 1 : 0)} hours</p><p class="muted">Watch time</p></div>
      <div class="stat"><p class="statnum">${formatCount(overview.subscribers, 'subscriber')}</p><p class="muted">${overview.subscribersGained ? `+${overview.subscribersGained} in ${overview.days} days` : 'No new subscribers yet'}</p></div>
      ${money ? html`<div class="stat"><p class="statnum">${formatMoney(money.available, money.currency)}</p><p class="muted">Available to withdraw</p></div>` : ''}
    </section>
    <section class="panel" aria-labelledby="chart-h"><h2 id="chart-h">Views per day</h2>
      ${barChart({ points: overview.daily.map((d) => ({ label: d.day, value: d.views })), label: `Views per day over the last ${overview.days} days, ${overview.views} in total`, unit: ' views' })}
    </section>
    <section aria-labelledby="top-h"><h2 id="top-h">Your latest videos</h2>
      ${videos.length ? videoTable(videos) : emptyState({ title: 'No videos yet', body: 'Upload your first video and it will show up here.', action: html`<a class="btn btn-primary" href="/studio/upload">Upload a video</a>` })}
    </section>
  </div>`;
}

function videoTable(items) {
  return html`<div class="tablewrap"><table class="table">
    <caption class="sr-only">Your videos</caption>
    <thead><tr><th scope="col">Video</th><th scope="col">Visibility</th><th scope="col">Status</th><th scope="col" class="num">Views</th><th scope="col" class="num">Likes</th><th scope="col">Date</th></tr></thead>
    <tbody>${items.map((v) => html`<tr>
      <th scope="row"><div class="vrow">
        ${v.status === 'ready' ? html`<img src="${thumbUrl(v)}" alt="" width="96" height="54" loading="lazy">` : html`<span class="vthumb-empty small">${STATUS[v.status]}</span>`}
        <div><a href="/studio/videos/${v.id}">${v.title}</a>${v.duration_ms ? html`<div class="muted timecode">${formatDuration(v.duration_ms)}</div>` : ''}${v.status === 'failed' ? html`<div class="field-error">${v.fail_reason}</div>` : ''}</div>
      </div></th>
      <td>${VIS[v.visibility]}</td><td>${STATUS[v.status]}</td><td class="num">${v.views}</td><td class="num">${v.likes}</td><td>${formatDate(v.published_at)}</td>
    </tr>`)}</tbody></table></div>`;
}

export function studioVideos(req, { items, hasMore, page }) {
  return html`<div class="page">
    <header class="pagehead"><h1>Your videos</h1><a class="btn btn-primary" href="/studio/upload">${icon('upload')} Upload a video</a></header>
    ${studioNav('videos', req)}
    ${items.length ? videoTable(items) : emptyState({ title: 'No videos yet', body: 'Upload your first video to get started.', action: html`<a class="btn btn-primary" href="/studio/upload">Upload a video</a>` })}
    ${page > 1 || hasMore ? html`<nav class="pager" aria-label="Pages">${page > 1 ? html`<a class="btn btn-quiet" href="/studio/videos?page=${page - 1}">Newer</a>` : html`<span></span>`}${hasMore ? html`<a class="btn btn-quiet" href="/studio/videos?page=${page + 1}">Older</a>` : ''}</nav>` : ''}
  </div>`;
}

export function creatorTermsPage(req, { error = '' }) {
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Before you upload</h1></header>
    <p class="lede">Uploading makes you a creator on this site. Please read the creator terms and the community guidelines. The short version:</p>
    <ul class="plain">
      <li>You only upload videos you made, or have the rights to share.</li>
      <li>You give us permission to store, convert and show your video on the site. You keep ownership.</li>
      <li>No sexual content involving minors, no harassment, no illegal content, no scams or misleading titles. We remove such videos and may close accounts.</li>
      <li>Tips and payouts follow the <a href="/legal/creator-terms" target="_blank" rel="noopener">creator terms</a>, including a platform fee and a holding period.</li>
    </ul>
    <form method="post" action="/studio/terms" class="stack">
      ${csrfField(req)}
      ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
      ${field({ name: 'agree', type: 'checkbox', label: html`I have read the <a href="/legal/creator-terms" target="_blank" rel="noopener">creator terms</a> and <a href="/legal/community-guidelines" target="_blank" rel="noopener">community guidelines</a>, and I will only upload videos I have the right to share.`, required: true })}
      <p><button class="btn btn-primary" type="submit">Accept and continue</button></p>
    </form>
  </div>`;
}

export function studioUpload(req, { maxBytes, remainingToday, gate }) {
  return html`<div class="page narrow">
    <header class="pagehead"><h1>Upload a video</h1></header>
    ${studioNav('upload', req)}
    ${gate
      ? html`<div class="flash flash-info" role="status">${gate}</div>`
      : html`<form id="upload-form" class="stack" data-max-bytes="${maxBytes}" novalidate>
        <div class="dropzone">
          <label for="file" class="btn btn-quiet">${icon('upload')} Choose a video file</label>
          <input id="file" name="file" type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi" class="sr-only">
          <p class="muted" id="file-name">MP4, MOV, WebM, MKV or AVI, up to ${formatBytes(maxBytes)}. You can upload ${remainingToday} more today.</p>
        </div>
        ${field({ name: 'title', label: 'Title', required: true, maxlength: 100, hint: 'Say what the video is. Titles that promise something the video does not deliver get less reach: viewers who leave early push a video down.' })}
        ${field({ name: 'description', label: 'Description', type: 'textarea', rows: 5, maxlength: 5000 })}
        ${field({ name: 'tags', label: 'Tags', hint: 'Separate with commas, up to 10.', maxlength: 400 })}
        ${field({ name: 'category', label: 'Category', type: 'select', value: 'other', options: CATEGORIES.map(([value, label]) => ({ value, label })) })}
        ${field({ name: 'visibility', label: 'Who can watch', type: 'select', value: 'public', options: [{ value: 'public', label: 'Public: anyone, listed on the site' }, { value: 'unlisted', label: 'Unlisted: anyone with the link' }, { value: 'private', label: 'Private: only you' }] })}
        ${field({ name: 'comments_enabled', type: 'checkbox', label: 'Allow comments', value: true })}
        ${field({ name: 'has_paid_promotion', type: 'checkbox', label: 'This video includes paid promotion', hint: 'Required if a brand paid you or gave you something for this video. A label is shown on the video.' })}
        <p class="muted">By uploading you confirm you have the rights to share this video, and you agree to the <a href="/legal/creator-terms" target="_blank" rel="noopener">creator terms</a>.</p>
        <div class="progressbox" hidden>
          <progress id="upload-progress" max="100" value="0" aria-label="Upload progress"></progress>
          <p id="upload-status" role="status" aria-live="polite"></p>
        </div>
        <p><button id="upload-submit" class="btn btn-primary" type="submit">Upload</button></p>
        <p id="upload-done" hidden></p>
      </form>`}
  </div>`;
}

export function studioEdit(req, { video, values, errors = {}, saved = false, stats }) {
  const v = values ?? video;
  return html`<div class="page">
    <header class="pagehead"><h1>Edit video</h1>${video.status === 'ready' ? html`<a class="btn btn-quiet" href="/watch/${video.id}">Watch</a>` : ''}</header>
    ${studioNav('videos', req)}
    ${saved ? html`<div class="flash flash-success" role="status">Saved.</div>` : ''}
    ${video.status === 'removed' ? html`<div class="flash flash-error" role="alert">This video was removed by the moderators${video.removed_reason ? `: ${video.removed_reason}` : ''}. You can still delete it.</div>` : ''}
    ${video.status === 'failed' ? html`<div class="flash flash-error" role="alert">Processing failed: ${video.fail_reason}</div>` : ''}
    ${video.status === 'processing' ? html`<div class="flash flash-info" role="status" data-processing="${video.id}">This video is still processing. This page reloads by itself when it is done.</div>` : ''}
    <div class="editgrid">
      <form method="post" action="/studio/videos/${video.id}" class="stack" novalidate>
        ${csrfField(req)}
        ${field({ name: 'title', label: 'Title', value: v.title, error: errors.title, required: true, maxlength: 100 })}
        ${field({ name: 'description', label: 'Description', type: 'textarea', rows: 6, value: v.description, error: errors.description, maxlength: 5000 })}
        ${field({ name: 'tags', label: 'Tags', value: Array.isArray(v.tags) ? v.tags.join(', ') : v.tags, error: errors.tags, hint: 'Separate with commas, up to 10.' })}
        ${field({ name: 'category', label: 'Category', type: 'select', value: v.category, error: errors.category, options: CATEGORIES.map(([value, label]) => ({ value, label })) })}
        ${field({ name: 'visibility', label: 'Who can watch', type: 'select', value: v.visibility, error: errors.visibility, options: [{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted (anyone with the link)' }, { value: 'private', label: 'Private (only you)' }] })}
        ${field({ name: 'comments_enabled', type: 'checkbox', label: 'Allow comments', value: v.comments_enabled })}
        ${field({ name: 'has_paid_promotion', type: 'checkbox', label: 'This video includes paid promotion', value: v.has_paid_promotion })}
        <p><button class="btn btn-primary" type="submit">Save changes</button></p>
      </form>
      <aside class="stack">
        ${video.status === 'ready'
          ? html`<section class="panel" aria-labelledby="thumb-h"><h2 id="thumb-h">Thumbnail</h2>
              <p class="muted">Pick a frame from your video, or upload your own image (16:9, at least 1280 by 720). A thumbnail that does not match the video loses viewers early, and that lowers where the video appears.</p>
              <form method="post" action="/studio/videos/${video.id}/thumbnail" class="thumbchoices">
                ${csrfField(req)}
                ${(video.poster_candidates ?? []).map((p) => html`<label class="thumbchoice"><input type="radio" name="thumb" value="${p.name}" ${video.thumb_kind === 'frame' && video.thumb_name === p.name ? 'checked' : ''}><img src="/media/f/${video.id}/${p.name}?v=${Math.floor(new Date(video.updated_at).getTime() / 1000)}" alt="Frame at ${formatDuration(p.ms)}" width="160" height="90" loading="lazy"><span class="timecode">${formatDuration(p.ms)}</span></label>`)}
                <button class="btn btn-quiet" type="submit">Use this frame</button>
              </form>
              <div class="stack" data-thumb-upload="${video.id}">
                <label for="thumb-file" class="btn btn-quiet">Upload your own image</label>
                <input id="thumb-file" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only">
                <p class="muted" data-thumb-status role="status" aria-live="polite">${video.thumb_kind === 'custom' ? 'Using your uploaded image.' : ''}</p>
              </div>
            </section>`
          : ''}
        ${stats
          ? html`<section class="panel" aria-labelledby="vs-h"><h2 id="vs-h">Performance</h2>
              <p><strong>${formatCount(video.views, 'view')}</strong> <span class="muted">since ${formatDate(video.published_at ?? video.created_at)}</span></p>
              ${video.retention_n > 0 ? html`<p><strong>${Math.round((video.retention_sum / video.retention_n) * 100)}%</strong> <span class="muted">of the video watched on average</span></p>` : ''}
              ${barChart({ points: stats.map((d) => ({ label: d.day, value: d.views })), label: 'Views per day, last 28 days', unit: ' views' })}
            </section>`
          : ''}
        <section class="panel danger" aria-labelledby="del-h"><h2 id="del-h">Delete video</h2>
          <p class="muted">This removes the video, its comments and its statistics for good.</p>
          <form method="post" action="/studio/videos/${video.id}/delete" class="stack">
            ${csrfField(req)}
            ${field({ name: 'confirm', type: 'checkbox', label: 'Yes, delete this video', required: true })}
            <button class="btn btn-danger" type="submit">Delete video</button>
          </form>
        </section>
      </aside>
    </div>
  </div>`;
}
