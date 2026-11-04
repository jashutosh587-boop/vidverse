import { html } from '../../lib/html.js';

/**
 * Ads show only on the watch page of a public, ready, eligible video, never to the video's owner or to staff
 * (nobody should click their own ads), and only when AdSense is configured.
 */
export function adsAllowed(config, video, viewer) {
  const { ads } = config;
  if (!ads.client || !(ads.slotWatchTop || ads.slotWatchSide)) return false;
  if (video.ad_status !== 'eligible' || video.status !== 'ready' || video.visibility !== 'public' || video.owner_status !== 'active') return false;
  if (viewer && (viewer.id === video.owner_id || viewer.role === 'admin' || viewer.role === 'moderator')) return false;
  return true;
}

export function adSlot(config, slot) {
  if (!slot) return '';
  // A plain box with a visible label, not a landmark: two landmarks with the same name confuse screen-reader navigation,
  // and an ad is not part of the page's structure. The visible word "Advertisement" is read out before the ad.
  return html`<div class="adslot" data-npa="${config.ads.nonPersonalized ? '1' : '0'}">
    <p class="adlabel">Advertisement</p>
    <ins class="adsbygoogle" data-ad-client="${config.ads.client}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>
  </div>`;
}

/** The AdSense library, loaded with this response's nonce. ads.js asks for non-personalised ads unless told otherwise. */
export function adsScripts(config, nonce) {
  return html`<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${config.ads.client}" crossorigin="anonymous" nonce="${nonce}"></script>`;
}
