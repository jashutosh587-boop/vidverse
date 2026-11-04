import { html, safeExternalUrl, ariaCurrent } from '../../../lib/html.js';
import { formatCount, formatDate } from '../../../lib/format.js';
import { avatar, videoGrid, pager, emptyState, icon, csrfField, tabs } from '../components.js';

/** Support links a creator added: only http(s) links survive, and every one opens as an untrusted outside link. */
export function supportLinks(links) {
  const safe = (Array.isArray(links) ? links : [])
    .map((l) => ({ label: String(l?.label ?? '').slice(0, 40), url: safeExternalUrl(String(l?.url ?? '')) }))
    .filter((l) => l.label && l.url);
  if (!safe.length) return '';
  return html`<ul class="linklist">${safe.map((l) => html`<li><a href="${l.url}" target="_blank" rel="noopener noreferrer nofollow ugc">${l.label}</a> <span class="muted">${new URL(l.url).hostname}</span></li>`)}</ul>`;
}

export function channelHeader(req, { channel, subscribers, videoCount, subscribed, notify, isOwner, tipsEnabled, tab }) {
  const back = encodeURIComponent(`/@${channel.handle}`);
  const subForm = (action, fields, button, { hidden = false } = {}) => html`<form class="inline" method="post" action="/actions/${action}" data-action="${action}" ${hidden ? 'hidden' : ''}>${csrfField(req)}
    <input type="hidden" name="channel" value="${channel.id}"><input type="hidden" name="next" value="/@${channel.handle}">
    ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${button}</form>`;
  return html`<header class="channelhead">
    <div class="banner hue-${channel.avatar_hue}" aria-hidden="true"></div>
    <div class="channelbar">
      ${avatar(channel, 'xl')}
      <div class="channelmeta">
        <h1>${channel.display_name}</h1>
        <p class="muted channelstats"><span>@${channel.handle}</span> <span data-subscribers>${formatCount(subscribers, 'subscriber')}</span> <span>${formatCount(videoCount, 'video')}</span></p>
        ${channel.bio ? html`<p class="clamp bio">${channel.bio.split('\n')[0]}</p>` : ''}
      </div>
      <div class="channelactions">
        ${isOwner
          ? html`<a class="btn btn-quiet" href="/studio/videos">${icon('film')} Manage videos</a><a class="btn btn-quiet" href="/settings/profile">${icon('edit')} Edit profile</a>`
          : req.user
            ? html`${subForm('subscribe', { on: subscribed ? '0' : '1' }, html`<button class="btn ${subscribed ? 'btn-quiet' : 'btn-primary'}" type="submit" aria-pressed="${String(!!(subscribed))}" data-label-on="Subscribed" data-label-off="Subscribe">${subscribed ? 'Subscribed' : 'Subscribe'}</button>`)}
              ${subForm('notify', { on: notify ? '0' : '1' }, html`<button class="btn btn-quiet" type="submit" aria-pressed="${String(!!(notify))}" aria-label="${notify ? 'Turn off notifications for this channel' : 'Notify me about new videos'}" title="Notify me about new videos">${icon('bell')}</button>`, { hidden: !subscribed })}`
            : html`<a class="btn btn-primary" href="/login?next=${back}">Subscribe</a>`}
        ${tipsEnabled && !isOwner ? html`<a class="btn btn-support" href="/support/@${channel.handle}">${icon('heart')} Support</a>` : ''}
      </div>
    </div>
    ${tabs([{ id: 'videos', href: `/@${channel.handle}`, label: 'Videos' }, { id: 'about', href: `/@${channel.handle}/about`, label: 'About' }], tab)}
  </header>`;
}

export function channelVideosPage(req, p) {
  const { channel, videos, page, sort, isOwner, now } = p;
  const sortLink = (id) => `/@${channel.handle}${id === 'new' ? '' : `?sort=${id}`}`;
  return html`<div class="page wide">
    ${channelHeader(req, { ...p, tab: 'videos' })}
    <nav class="tabs subtle" aria-label="Sort videos"><a href="${sortLink('new')}" ${ariaCurrent(sort === 'new', 'true')}>Latest</a><a href="${sortLink('popular')}" ${ariaCurrent(sort === 'popular', 'true')}>Popular</a></nav>
    ${videos.items.length
      ? videoGrid(videos.items, { now, showChannel: false, headingLevel: 2 })
      : emptyState({
          title: 'No public videos yet',
          body: isOwner ? 'Upload a video and set it to public to show it here.' : 'This channel has not published anything yet.',
          action: isOwner ? html`<a class="btn btn-primary" href="/studio/upload">Upload a video</a>` : '',
        })}
    ${pager({ page, hasMore: videos.hasMore, path: `/@${channel.handle}`, params: sort === 'new' ? {} : { sort } })}
  </div>`;
}

export function channelAboutPage(req, p) {
  const { channel, totalViews, joined, links, isOwner, tipsEnabled } = p;
  return html`<div class="page wide">
    ${channelHeader(req, { ...p, tab: 'about' })}
    <div class="about">
      <section aria-labelledby="about-h"><h2 id="about-h">About</h2>
        ${channel.bio ? html`<p class="prewrap">${channel.bio}</p>` : html`<p class="muted">${isOwner ? 'You have not written a description yet.' : 'This channel has no description.'}</p>`}
        ${isOwner && !channel.bio ? html`<p><a class="btn btn-quiet" href="/settings/profile">Add a description</a></p>` : ''}
      </section>
      <section aria-labelledby="stats-h"><h2 id="stats-h">Numbers</h2>
        <dl class="facts"><div><dt>Joined</dt><dd>${formatDate(joined)}</dd></div><div><dt>Total views</dt><dd>${formatCount(totalViews, 'view')}</dd></div></dl>
      </section>
      ${tipsEnabled || links
        ? html`<section aria-labelledby="support-h"><h2 id="support-h">Support this creator</h2>
            ${tipsEnabled && !isOwner ? html`<p>Send a tip with UPI, card or net banking. The creator receives it after our fee, once the holding period has passed.</p><p><a class="btn btn-support" href="/support/@${channel.handle}">${icon('heart')} Send a tip</a></p>` : ''}
            ${links ? html`<p class="muted">Links the creator added. We do not check them, and we are not responsible for what is on them.</p>${links}` : ''}
          </section>`
        : ''}
      ${req.user && !isOwner ? html`<p><a class="linkbtn" href="/report?type=user&amp;id=${channel.id}">${icon('flag')} Report this channel</a></p>` : ''}
    </div>
  </div>`;
}
