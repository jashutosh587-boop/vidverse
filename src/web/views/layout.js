import { html, jsonForScript, ariaCurrent } from '../../lib/html.js';
import { assetUrl } from '../assets.js';
import { icon, iconSprite, brandMark, avatar } from './components.js';
import { formatCount } from '../../lib/format.js';

const NAV_MAIN = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/trending', icon: 'flame', label: 'Trending' },
  { href: '/subscriptions', icon: 'subs', label: 'Subscriptions' },
];
const NAV_YOU = [
  { href: '/history', icon: 'history', label: 'History' },
  { href: '/watch-later', icon: 'clock', label: 'Watch later' },
  { href: '/liked', icon: 'thumb', label: 'Liked videos' },
];

function navLink(item, path) {
  const current = item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`);
  return html`<li><a class="railink" href="${item.href}" ${ariaCurrent(current)}>${icon(item.icon)}<span>${item.label}</span></a></li>`;
}

function userMenu(user, req) {
  const staff = user.role === 'admin' || user.role === 'moderator';
  return html`<details class="menu">
    <summary class="menu-button" aria-label="Your account">${avatar(user, 'sm')}</summary>
    <div class="menu-panel">
      <p class="menu-who"><strong>${user.display_name}</strong><span class="muted">@${user.handle}</span></p>
      <a href="/@${user.handle}">${icon('user')}Your channel</a>
      <a href="/studio">${icon('film')}Studio</a>
      ${req.ctx.monetization ? html`<a href="/studio/earnings">${icon('wallet')}Earnings</a>` : ''}
      <a href="/history">${icon('history')}Time watched</a>
      <a href="/settings">${icon('settings')}Settings</a>
      <a href="/help">${icon('help')}Help</a>
      ${staff ? html`<a href="/admin">${icon('shield')}Admin</a>` : ''}
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button type="submit" class="menu-signout">Sign out</button></form>
    </div>
  </details>`;
}

function assistantWidget() {
  return html`<div class="assistant" data-assistant>
    <button class="assistant-toggle" type="button" aria-expanded="false" aria-controls="assistant-panel">${icon('spark')}<span>Help</span></button>
    <section id="assistant-panel" class="assistant-panel" role="dialog" aria-label="Help assistant" hidden>
      <header class="assistant-head"><h2>Help assistant</h2><button class="iconbtn" type="button" data-assistant-close aria-label="Close help assistant">${icon('close')}</button></header>
      <div class="assistant-log" role="log" aria-live="polite" tabindex="0"><p class="assistant-msg assistant-bot">Hi. Ask me how something works: uploading, earning, privacy, your account. I answer from our help articles.</p></div>
      <form class="assistant-form" action="/help" method="get">
        <label class="sr-only" for="assistant-q">Your question</label>
        <input id="assistant-q" name="q" maxlength="500" autocomplete="off" placeholder="For example: how do payouts work?">
        <button class="btn btn-primary" type="submit">Ask</button>
      </form>
      <p class="assistant-note">Answers come only from our help articles. For anything about your own account, <a href="/contact">contact support</a>.</p>
    </section>
  </div>`;
}

/**
 * Wraps page content in the site frame. `opts`:
 *   title, description, canonical, noindex, ogImage, ogType, jsonLd, scripts (asset names), bodyClass,
 *   extra: { unread, todayWatchMs } looked up by res.page.
 */
export function renderLayout(req, res, content, opts = {}) {
  const { config } = req.ctx;
  const { user } = req;
  const nonce = res.locals.nonce;
  const path = req.path;
  const siteName = config.siteName;
  const title = opts.title ? `${opts.title} - ${siteName}` : `${siteName}: watch, share and earn from your videos`;
  const description = opts.description ?? `${siteName} is a video site where anyone can watch, and creators can upload and get paid by the people who enjoy their work.`;
  const canonical = opts.canonical ? `${config.baseUrl}${opts.canonical}` : null;
  const extra = opts.extra ?? {};
  const year = req.ctx.clock().getUTCFullYear();
  const legal = config.legal;
  const limitReached = user?.daily_limit_minutes && (extra.todayWatchMs ?? 0) >= user.daily_limit_minutes * 60_000;
  const scripts = ['js/app.js', ...(opts.scripts ?? []), 'js/assistant.js'];

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0b1220">
<meta name="csrf-token" content="${req.csrfToken}">
${opts.noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
${canonical ? html`<link rel="canonical" href="${canonical}">` : ''}
<meta property="og:site_name" content="${siteName}">
<meta property="og:title" content="${opts.title ?? siteName}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="${opts.ogType ?? 'website'}">
${canonical ? html`<meta property="og:url" content="${canonical}">` : ''}
${opts.ogImage ? html`<meta property="og:image" content="${config.baseUrl}${opts.ogImage}"><meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/sans/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${assetUrl('css/app.css')}">
<script nonce="${nonce}">try{var t=localStorage.getItem('vv-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
${opts.jsonLd ? html`<script type="application/ld+json" nonce="${nonce}">${jsonForScript(opts.jsonLd)}</script>` : ''}
${opts.head ?? ''}
</head>
<body class="${opts.bodyClass ?? ''}">
<a class="skip" href="#main">Skip to content</a>
${iconSprite()}
<header class="topbar">
  <button class="iconbtn rail-toggle" type="button" aria-label="Show or hide the menu" aria-controls="rail" aria-expanded="false" data-rail-toggle>${icon('menu')}</button>
  <a class="brand" href="/" aria-label="${siteName} home">${brandMark()}<span class="brand-name">${siteName}</span></a>
  <form class="searchbar" role="search" aria-label="Videos and channels" action="/results" method="get">
    <label class="sr-only" for="q">Search videos and channels</label>
    <input id="q" name="q" type="search" placeholder="Search" autocomplete="off" maxlength="100" value="${opts.query ?? ''}" role="combobox" aria-expanded="false" aria-controls="suggest" aria-autocomplete="list" data-suggest>
    <button type="submit" aria-label="Search">${icon('search')}</button>
    <ul class="suggest" id="suggest" role="listbox" aria-label="Suggestions" hidden></ul>
  </form>
  <div class="topactions">
    <button class="iconbtn" type="button" data-theme-toggle aria-label="Switch between light and dark">${icon('moon')}</button>
    ${user
      ? html`<a class="btn btn-quiet upload-link" href="/studio/upload">${icon('upload')}<span class="label">Upload</span></a>
        <a class="iconbtn bell" href="/notifications" aria-label="Notifications${extra.unread ? `, ${extra.unread} unread` : ''}">${icon('bell')}${extra.unread ? html`<span class="badge" aria-hidden="true">${extra.unread > 9 ? '9+' : extra.unread}</span>` : ''}</a>
        ${userMenu(user, req)}`
      : html`<a class="btn btn-quiet" href="/login?next=${encodeURIComponent(req.originalUrl.startsWith('/') ? req.originalUrl.slice(0, 500) : '/')}">Sign in</a>${config.signupsOpen ? html`<a class="btn btn-primary" href="/signup">Create account</a>` : ''}`}
  </div>
</header>
<div class="shell">
  <nav class="rail" id="rail" aria-label="Main">
    <ul>${NAV_MAIN.map((i) => navLink(i, path))}</ul>
    <hr>
    <ul>${NAV_YOU.map((i) => navLink(i, path))}</ul>
    <hr>
    <ul>
      ${user ? navLink({ href: '/studio', icon: 'film', label: 'Studio' }, path) : ''}
      ${navLink({ href: '/help', icon: 'help', label: 'Help' }, path)}
    </ul>
  </nav>
  <main id="main" class="main" tabindex="-1">
    ${req.flash ? html`<div class="flash flash-${req.flash.type}" role="${req.flash.type === 'error' ? 'alert' : 'status'}">${req.flash.text}</div>` : ''}
    ${user && !user.email_verified_at ? html`<div class="flash flash-info" role="status">Confirm your email address to upload, comment and send tips. <form class="inline" method="post" action="/resend-verification"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="linkbtn" type="submit">Send the email again</button></form></div>` : ''}
    ${limitReached ? html`<div class="flash flash-info" role="status">You set a reminder at ${user.daily_limit_minutes} minutes a day, and you have watched ${formatCount(Math.round((extra.todayWatchMs ?? 0) / 60_000), 'minute')} today. Time for a break? <a href="/settings/preferences">Change the reminder</a></div>` : ''}
    ${content}
  </main>
</div>
<footer class="sitefoot">
  <nav aria-label="About ${siteName}">
    <a href="/help">Help center</a> <a href="/legal/terms">Terms</a> <a href="/legal/privacy">Privacy</a> <a href="/legal/community-guidelines">Community guidelines</a>
    <a href="/legal/copyright">Copyright</a> <a href="/legal/grievance">Grievance officer</a> <a href="/contact">Contact</a>
  </nav>
  <p class="muted">&copy; ${year} ${legal.operatorName ?? siteName}</p>
</footer>
${assistantWidget()}
${scripts.map((s) => html`<script src="${assetUrl(s)}" nonce="${nonce}" defer></script>`)}
</body>
</html>`;
}
