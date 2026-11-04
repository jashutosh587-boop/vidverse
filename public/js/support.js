/* Tip pages. One optional enhancement: while a tip is still waiting for the payment provider to confirm it, ask the
   server every few seconds and reload the page once the answer changes. Without scripts the page works the same;
   the person just reloads it. Text is only ever written with textContent. */
(function () {
  'use strict';

  var root = document.querySelector('[data-support-status]');
  if (!root) return;
  var id = root.getAttribute('data-support-status') || '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return;

  var wait = document.querySelector('[data-support-wait]');
  var tries = 0;
  var MAX_TRIES = 40; // about two minutes

  function later() {
    if (tries >= MAX_TRIES) {
      if (wait) {
        wait.textContent =
          'We are still waiting for the payment provider. Reload this page in a few minutes. If you were charged and nothing changes, write to us and quote the reference below.';
      }
      return;
    }
    window.setTimeout(check, 3000);
  }

  function check() {
    tries += 1;
    window
      .fetch('/api/support/' + id + '/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (data && typeof data.status === 'string' && data.status !== 'created') {
          window.location.reload();
          return;
        }
        later();
      })
      .catch(later);
  }

  later();
})();
