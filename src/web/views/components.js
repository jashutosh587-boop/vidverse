import { html, raw, ariaCurrent } from '../../lib/html.js';
import { formatDuration, formatCount, timeAgo } from '../../lib/format.js';

/** Own icon set: simple 24px strokes. Drawn once in the layout as a sprite, used with icon('home'). */
const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  flame: 'M12 3c1 3-3 5-3 9a3 3 0 006 0c0-1-.5-2-1-3 2 1 4 3 4 6a6 6 0 01-12 0c0-5 4-7 6-12z',
  subs: 'M5 5h14M7 9h10M3 13h18v7H3z',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  thumb: 'M7 11v9H4v-9h3zM7 11l4-8c1.5 0 2.5 1 2 3l-.5 2H19a2 2 0 012 2.3l-1 6A2 2 0 0118 20H7',
  bell: 'M6 17v-6a6 6 0 1112 0v6l2 2H4l2-2zM10 21h4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 115 0c0 1.5-2.5 2-2.5 3.5M12 17h.01',
  close: 'M6 6l12 12M18 6L6 18',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8',
  wallet: 'M4 7h15a1 1 0 011 1v11a1 1 0 01-1 1H5a2 2 0 01-2-2V6a2 2 0 012-2h12M16 14h.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  check: 'M5 12l5 5L20 7',
  chat: 'M4 5h16v11H9l-5 4z',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 018-2.7A4.5 4.5 0 0120 9c0 6-8 11-8 11z',
  share: 'M8 12l8-5M8 12l8 5M6 9a3 3 0 100 6 3 3 0 000-6zM18 4a3 3 0 100 6 3 3 0 000-6zM18 14a3 3 0 100 6 3 3 0 000-6z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  play: 'M7 4l13 8-13 8z',
  plus: 'M12 5v14M5 12h14',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z',
  user: 'M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c0-4 4-6 8-6s8 2 8 6',
  users: 'M9 5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM2 20c0-3.5 3-5.5 7-5.5M17 8a3 3 0 110 6M16 15c3 .3 6 1.8 6 5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
};

export function iconSprite() {
  return raw(
    `<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true" focusable="false"><defs>${Object.entries(PATHS)
      .map(([k, d]) => `<symbol id="i-${k}" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>`)
      .join('')}</defs></svg>`,
  );
}

export const icon = (name, cls = 'icon') => html`<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

/** Brand mark: seven colour bars, like the test pattern a broadcast shows before the picture. */
export function brandMark() {
  const colours = ['#e8e8e8', '#e6c619', '#19b8c9', '#2fb34a', '#c43fc4', '#e04242', '#3b5bdb'];
  return raw(
    `<svg class="brandmark" viewBox="0 0 28 20" aria-hidden="true" focusable="false">${colours.map((c, i) => `<rect x="${i * 4}" y="0" width="4" height="20" fill="${c}"/>`).join('')}</svg>`,
  );
}

export function avatar(person, size = 'md') {
  const name = person?.display_name ?? person?.channel_name ?? '?';
  const hue = person?.avatar_hue ?? person?.channel_hue ?? 0;
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return html`<span class="avatar avatar-${size} hue-${hue}" aria-hidden="true">${initial}</span>`;
}

export const thumbUrl = (v) => `/media/t/${v.id}.jpg?v=${Math.floor(new Date(v.updated_at ?? Date.now()).getTime() / 1000)}`;

/**
 * One video in a grid or list. `v` needs: id, title, duration_ms, views, published_at, status,
 * visibility and the channel_* fields.
 */
export function videoCard(v, { now = new Date(), showChannel = true, progress = null, badge = null, headingLevel = 3 } = {}) {
  const hasThumb = v.status === 'ready';
  const titleLink = html`<a href="/watch/${v.id}">${v.title}</a>`;
  const title = headingLevel === 2 ? html`<h2 class="vtitle">${titleLink}</h2>` : html`<h3 class="vtitle">${titleLink}</h3>`;
  return html`<article class="vcard">
    <a class="vthumb" href="/watch/${v.id}" tabindex="-1" aria-hidden="true">
      ${hasThumb ? html`<img src="${thumbUrl(v)}" alt="" width="640" height="360" loading="lazy" decoding="async">` : html`<span class="vthumb-empty">${v.status === 'failed' ? 'Failed' : 'Processing'}</span>`}
      ${v.duration_ms ? html`<span class="timecode vdur">${formatDuration(v.duration_ms)}</span>` : ''}
      ${progress !== null ? html`<progress class="vprogress" max="100" value="${Math.max(2, Math.min(100, Math.round(progress)))}" aria-label="Watched so far"></progress>` : ''}
    </a>
    <div class="vinfo">
      ${showChannel && v.channel_handle ? html`<a class="vavatar" href="/@${v.channel_handle}" tabindex="-1" aria-hidden="true">${avatar({ channel_name: v.channel_name, channel_hue: v.channel_hue }, 'sm')}</a>` : ''}
      <div class="vtext">
        ${title}
        ${showChannel && v.channel_handle ? html`<p class="vchannel"><a href="/@${v.channel_handle}">${v.channel_name}</a></p>` : ''}
        <p class="vstats"><span>${formatCount(v.views, 'view')}</span> ${v.published_at ? html`<span>${timeAgo(v.published_at, now)}</span>` : ''}${badge ? html` <span class="pill">${badge}</span>` : ''}${v.visibility && v.visibility !== 'public' ? html` <span class="pill">${v.visibility === 'private' ? 'Private' : 'Unlisted'}</span>` : ''}</p>
      </div>
    </div>
  </article>`;
}

export function videoGrid(videos, opts = {}) {
  return html`<div class="vgrid">${videos.map((v) => videoCard(v, opts))}</div>`;
}

export function pager({ page, hasMore, path, params = {} }) {
  const link = (p) => `${path}?${new URLSearchParams({ ...params, page: String(p) }).toString()}`;
  if (page <= 1 && !hasMore) return '';
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a class="btn btn-quiet" href="${link(page - 1)}" rel="prev">Newer</a>` : html`<span></span>`}
    <span class="muted">Page ${page}</span>
    ${hasMore ? html`<a class="btn btn-quiet" href="${link(page + 1)}" rel="next">Older</a>` : html`<span></span>`}
  </nav>`;
}

/** A labelled input with its hint and error wired up for screen readers. */
export function field({ name, id: idOverride, label, type = 'text', value = '', error = '', hint = '', autocomplete, required = false, maxlength, rows, options, inputmode, pattern, min, max, step, placeholder }) {
  // The id ties the label, hint and error to the input. Two fields with the same name on one page (the security page has three
  // "password" boxes in three forms) must be given different ids, or a label would point at the wrong box.
  const id = idOverride ?? `f-${name}`;
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ');
  const common = html`id="${id}" name="${name}" ${required ? 'required' : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''} ${error ? html`aria-invalid="true"` : ''}`;
  let control;
  if (type === 'textarea') {
    control = html`<textarea class="input textarea" ${common} rows="${rows ?? 4}" ${maxlength ? html`maxlength="${maxlength}"` : ''}>${value}</textarea>`;
  } else if (type === 'select') {
    control = html`<select class="input" ${common}>${options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? 'selected' : ''}>${o.label}</option>`)}</select>`;
  } else if (type === 'checkbox') {
    return html`<div class="field field-check">
      <label class="check"><input type="checkbox" id="${id}" name="${name}" value="1" ${value ? 'checked' : ''} ${required ? 'required' : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''}> <span>${label}</span></label>
      ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
      ${error ? html`<p class="field-error" id="${id}-err">${error}</p>` : ''}
    </div>`;
  } else {
    control = html`<input class="input" type="${type}" ${common} value="${value}" ${autocomplete ? html`autocomplete="${autocomplete}"` : ''} ${maxlength ? html`maxlength="${maxlength}"` : ''} ${inputmode ? html`inputmode="${inputmode}"` : ''} ${pattern ? html`pattern="${pattern}"` : ''} ${min !== undefined ? html`min="${min}"` : ''} ${max !== undefined ? html`max="${max}"` : ''} ${step !== undefined ? html`step="${step}"` : ''} ${placeholder ? html`placeholder="${placeholder}"` : ''}>`;
  }
  return html`<div class="field">
    <label for="${id}">${label}</label>
    ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${control}
    ${error ? html`<p class="field-error" id="${id}-err">${error}</p>` : ''}
  </div>`;
}

export const csrfField = (req) => html`<input type="hidden" name="_csrf" value="${req.csrfToken}">`;

export function emptyState({ title, body, action }) {
  return html`<section class="empty"><h2>${title}</h2><p>${body}</p>${action ?? ''}</section>`;
}

/** A bar chart as inline SVG: scales with its container, readable by screen readers through the label. */
export function barChart({ points, label, unit = '', height = 90 }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = 280;
  const gap = 2;
  const bw = (w - gap * (points.length - 1)) / points.length;
  return html`<figure class="chart">
    <svg viewBox="0 0 ${w} ${height + 4}" role="img" aria-label="${label}" preserveAspectRatio="none">
      ${points.map((p, i) => {
        const h = p.value === 0 ? 1 : Math.max(2, (p.value / max) * height);
        return html`<rect class="bar" x="${(i * (bw + gap)).toFixed(2)}" y="${(height - h + 2).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="1"><title>${p.label}: ${p.value}${unit}</title></rect>`;
      })}
    </svg>
    <figcaption class="muted"><span>${points[0]?.label}</span><span>${points[points.length - 1]?.label}</span></figcaption>
  </figure>`;
}

export function tabs(items, active) {
  return html`<nav class="tabs" aria-label="Section">${items.map((i) => html`<a href="${i.href}" ${ariaCurrent(i.id === active)}>${i.label}</a>`)}</nav>`;
}
