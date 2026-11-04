/* The watch page player: adaptive streaming, quality and speed, resume, keyboard keys, honest view
   counting, and "up next" with a "still watching?" pause so a long run of autoplay does not carry on unnoticed. */
(function () {
  'use strict';

  var video = document.getElementById('player');
  if (!video) return;
  var vv = window.vv || { csrf: '', store: function () { return null; }, toast: function () {}, post: function () {} };

  var id = video.getAttribute('data-video-id');
  var src = video.getAttribute('data-hls');
  var resumeSec = Number(video.getAttribute('data-resume')) || 0;
  var startAt = video.getAttribute('data-start') ? Number(video.getAttribute('data-start')) : null;
  var nextUrl = video.getAttribute('data-next') || '';
  var nextTitle = video.getAttribute('data-next-title') || '';
  var signedIn = video.getAttribute('data-signed-in') === '1';
  var qualitySel = document.getElementById('quality');
  var speedSel = document.getElementById('speed');
  var autoToggle = document.getElementById('autoplay-toggle');
  var upNext = document.querySelector('[data-upnext]');
  var stillBox = document.querySelector('[data-stillwatching]');
  var hls = null;

  // ---------------------------------------------------------------- loading the stream
  function showProblem(text) {
    var p = document.createElement('p');
    p.className = 'player-problem';
    p.textContent = text;
    video.insertAdjacentElement('afterend', p);
  }

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 60, capLevelToPlayerSize: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, function (_e, data) {
      if (!qualitySel) return;
      var seen = {};
      data.levels.forEach(function (lvl, i) {
        if (seen[lvl.height]) return;
        seen[lvl.height] = true;
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = lvl.height + 'p';
        qualitySel.appendChild(o);
      });
      qualitySel.disabled = data.levels.length < 2;
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, function (_e, data) {
      if (!qualitySel || qualitySel.value !== '-1') return;
      var lvl = hls.levels[data.level];
      if (lvl) qualitySel.options[0].textContent = 'Auto (' + lvl.height + 'p)';
    });
    hls.on(window.Hls.Events.ERROR, function (_e, data) {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else {
        hls.destroy();
        showProblem('This video could not be played. Reload the page to try again.');
      }
    });
    if (qualitySel) {
      qualitySel.addEventListener('change', function () {
        hls.currentLevel = Number(qualitySel.value);
      });
    }
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src; // Safari and iPhones play HLS natively
    if (qualitySel) qualitySel.parentElement.hidden = true;
  } else {
    showProblem('This browser cannot play the video. Try a recent version of Chrome, Firefox, Edge or Safari.');
  }

  // ---------------------------------------------------------------- start position, speed
  video.addEventListener('loadedmetadata', function () {
    var d = video.duration;
    var from = startAt !== null ? startAt : resumeSec;
    if (from > 5 && isFinite(d) && from < d - 10) video.currentTime = from;
  }, { once: true });

  var savedSpeed = Number(vv.store('vv-speed'));
  if (speedSel && [0.5, 0.75, 1, 1.25, 1.5, 2].indexOf(savedSpeed) !== -1) {
    speedSel.value = String(savedSpeed);
    video.playbackRate = savedSpeed;
  }
  if (speedSel) {
    speedSel.addEventListener('change', function () {
      video.playbackRate = Number(speedSel.value);
      vv.store('vv-speed', speedSel.value);
    });
  }

  // Links such as 1:25 in the description jump to that moment.
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-seek]');
    if (!a) return;
    e.preventDefault();
    video.currentTime = Number(a.getAttribute('data-seek'));
    video.play().catch(function () {});
    video.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---------------------------------------------------------------- counting views honestly
  // The page reports how much it actually played. The server decides how much of that to believe.
  var lastTime = 0;
  var playedMs = 0;
  video.addEventListener('timeupdate', function () {
    var t = video.currentTime;
    var d = t - lastTime;
    if (!video.paused && !video.seeking && d > 0 && d < 2) playedMs += d * 1000;
    lastTime = t;
  });
  video.addEventListener('seeked', function () {
    lastTime = video.currentTime;
  });

  function beatBody() {
    var body = new URLSearchParams();
    body.set('_csrf', vv.csrf);
    body.set('position', String(Math.round(video.currentTime * 1000)));
    body.set('delta', String(Math.round(playedMs)));
    playedMs = 0;
    return body;
  }
  var beatUrl = '/api/videos/' + encodeURIComponent(id) + '/heartbeat';
  function beat(final) {
    if (playedMs < 250 && !final) return;
    var body = beatBody();
    if (final && navigator.sendBeacon) {
      navigator.sendBeacon(beatUrl, body);
      return;
    }
    window.fetch(beatUrl, { method: 'POST', body: body, credentials: 'same-origin', keepalive: true, headers: { 'X-CSRF-Token': vv.csrf } }).catch(function () {});
  }
  window.setInterval(function () {
    if (!video.paused) beat(false);
  }, 10000);
  video.addEventListener('pause', function () {
    beat(false);
  });
  window.addEventListener('pagehide', function () {
    beat(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') beat(true);
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (t && t !== video && t !== document.body && /^(a|button|summary)$/i.test(t.tagName) && (e.key === ' ' || e.key === 'Enter')) return;
    var key = e.key.toLowerCase();
    if (key === 'k') {
      e.preventDefault();
      if (video.paused) video.play().catch(function () {});
      else video.pause();
    } else if (key === 'j') {
      video.currentTime = Math.max(0, video.currentTime - 10);
    } else if (key === 'l') {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
    } else if (key === 'm') {
      video.muted = !video.muted;
    } else if (key === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (video.parentElement.requestFullscreen) video.parentElement.requestFullscreen().catch(function () {});
    }
  });

  // ---------------------------------------------------------------- autoplay and "still watching?"
  var CHAIN_KEY = 'vv-autoplay-chain';
  var NAV_KEY = 'vv-autoplay-nav';
  var chain = 0;
  try {
    var navAt = Number(window.sessionStorage.getItem(NAV_KEY));
    if (navAt && Date.now() - navAt < 15000) chain = Number(window.sessionStorage.getItem(CHAIN_KEY)) || 0;
    else window.sessionStorage.setItem(CHAIN_KEY, '0');
    window.sessionStorage.removeItem(NAV_KEY);
  } catch (e) {
    chain = 0;
  }
  var MAX_CHAIN = 3;
  var autoplay = autoToggle ? autoToggle.checked : false;
  if (autoToggle && !signedIn) {
    var local = vv.store('vv-autoplay');
    if (local === '0') autoplay = false;
    autoToggle.checked = autoplay;
  }
  if (autoToggle) {
    autoToggle.addEventListener('change', function () {
      autoplay = autoToggle.checked;
      if (signedIn) {
        vv.post('/api/preferences/autoplay', { on: autoplay }, true).catch(function () {});
      } else {
        vv.store('vv-autoplay', autoplay ? '1' : '0');
      }
      if (!autoplay) cancelCountdown();
    });
  }

  var countdown = 0;
  function cancelCountdown() {
    window.clearInterval(countdown);
    if (upNext) upNext.hidden = true;
  }
  function goNext() {
    try {
      window.sessionStorage.setItem(CHAIN_KEY, String(chain + 1));
      window.sessionStorage.setItem(NAV_KEY, String(Date.now()));
    } catch (e) {
      /* fine */
    }
    window.location.href = nextUrl;
  }
  function startCountdown() {
    if (!upNext) return;
    var left = 5;
    var counter = upNext.querySelector('[data-upnext-count]');
    upNext.querySelector('[data-upnext-title]').textContent = nextTitle;
    counter.textContent = String(left);
    upNext.hidden = false;
    upNext.querySelector('[data-upnext-now]').focus({ preventScroll: true });
    countdown = window.setInterval(function () {
      left -= 1;
      counter.textContent = String(left);
      if (left <= 0) {
        window.clearInterval(countdown);
        goNext();
      }
    }, 1000);
  }
  if (upNext) {
    upNext.querySelector('[data-upnext-now]').addEventListener('click', goNext);
    upNext.querySelector('[data-upnext-cancel]').addEventListener('click', cancelCountdown);
  }
  if (stillBox) {
    stillBox.querySelector('[data-stillwatching-continue]').addEventListener('click', function () {
      stillBox.hidden = true;
      chain = 0;
      try {
        window.sessionStorage.setItem(CHAIN_KEY, '0');
      } catch (e) {
        /* fine */
      }
      startCountdown();
    });
  }
  video.addEventListener('ended', function () {
    beat(false);
    if (!autoplay || !nextUrl) return;
    if (chain >= MAX_CHAIN && stillBox) {
      stillBox.hidden = false;
      stillBox.querySelector('[data-stillwatching-continue]').focus({ preventScroll: true });
    } else startCountdown();
  });

  // Try to start playing. Browsers may refuse until the person presses play; that is fine.
  var playPromise = video.play();
  if (playPromise && playPromise.catch) playPromise.catch(function () {});
})();
