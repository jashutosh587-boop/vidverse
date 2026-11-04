/* Starts the AdSense slots on the watch page. Ads are non-personalised unless the site is configured otherwise. */
(function () {
  'use strict';
  var slots = document.querySelectorAll('ins.adsbygoogle');
  if (!slots.length) return;
  window.adsbygoogle = window.adsbygoogle || [];
  if (document.querySelector('.adslot[data-npa="1"]')) window.adsbygoogle.requestNonPersonalizedAds = 1;
  slots.forEach(function () {
    try {
      window.adsbygoogle.push({});
    } catch (e) {
      /* a blocked or failed ad never affects the page */
    }
  });
})();
