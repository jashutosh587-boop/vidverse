/* Site-wide behaviour: menus, theme, search suggestions, and buttons that work without a page reload.
   Everything here is an enhancement: the site works without JavaScript. Text is only ever written with
   textContent, never innerHTML. */
(function () {
  'use strict';

  var doc = document;
  var csrfMeta = doc.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* storage can be blocked; the site still works */
    }
    return null;
  }

  // A small live message at the bottom of the screen, shared with the other scripts.
  var toastEl = null;
  var toastTimer = 0;
  function toast(message) {
    if (!toastEl) {
      toastEl = doc.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      doc.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.hidden = true;
    }, 4500);
  }

  function post(url, data, json) {
    var headers = { Accept: 'application/json', 'X-Requested-With': 'fetch', 'X-CSRF-Token': csrf };
    var body;
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    } else {
      body = new URLSearchParams(data);
    }
    return window.fetch(url, { method: 'POST', headers: headers, body: body, credentials: 'same-origin' });
  }

  async function errorMessage(res) {
    try {
      var j = await res.json();
      if (j && j.error && j.error.message) return j.error.message;
    } catch (e) {
      /* not JSON */
    }
    return 'Something went wrong. Please try again.';
  }

  window.vv = { csrf: csrf, toast: toast, post: post, store: store, errorMessage: errorMessage };

  // ---- theme ----
  var themeBtn = doc.querySelector('[data-theme-toggle]');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var root = doc.documentElement;
      var current = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      store('vv-theme', next);
    });
  }

  // ---- left menu: collapses on wide screens, slides in on narrow ones ----
  var railBtn = doc.querySelector('[data-rail-toggle]');
  var narrow = window.matchMedia('(max-width: 900px)');
  function syncRailButton() {
    var open = narrow.matches ? doc.body.classList.contains('rail-open') : !doc.body.classList.contains('rail-collapsed');
    if (railBtn) railBtn.setAttribute('aria-expanded', String(open));
  }
  if (store('vv-rail') === 'collapsed' && !narrow.matches) doc.body.classList.add('rail-collapsed');
  syncRailButton();
  if (railBtn) {
    railBtn.addEventListener('click', function () {
      if (narrow.matches) {
        doc.body.classList.toggle('rail-open');
      } else {
        doc.body.classList.toggle('rail-collapsed');
        store('vv-rail', doc.body.classList.contains('rail-collapsed') ? 'collapsed' : 'open');
      }
      syncRailButton();
    });
    doc.addEventListener('click', function (e) {
      if (narrow.matches && doc.body.classList.contains('rail-open') && !e.target.closest('#rail') && !e.target.closest('[data-rail-toggle]')) {
        doc.body.classList.remove('rail-open');
        syncRailButton();
      }
    });
  }
  narrow.addEventListener('change', syncRailButton);

  // ---- open <details> menus close on outside click and Escape ----
  doc.addEventListener('click', function (e) {
    doc.querySelectorAll('details.menu[open], details.share[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    doc.querySelectorAll('details.menu[open], details.share[open]').forEach(function (d) {
      d.removeAttribute('open');
      var s = d.querySelector('summary');
      if (s) s.focus();
    });
    if (doc.body.classList.contains('rail-open')) {
      doc.body.classList.remove('rail-open');
      syncRailButton();
      if (railBtn) railBtn.focus();
    }
  });

  doc.querySelectorAll('[data-select-on-focus]').forEach(function (el) {
    el.addEventListener('focus', function () {
      el.select();
    });
  });

  // ---- search suggestions (a combobox with a listbox) ----
  var input = doc.querySelector('[data-suggest]');
  var list = doc.getElementById('suggest');
  if (input && list) {
    var items = [];
    var active = -1;
    var timer = 0;
    var controller = null;

    var close = function () {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    var highlight = function (i) {
      var nodes = list.children;
      for (var k = 0; k < nodes.length; k++) nodes[k].setAttribute('aria-selected', String(k === i));
      active = i;
      if (i >= 0) input.setAttribute('aria-activedescendant', nodes[i].id);
      else input.removeAttribute('aria-activedescendant');
    };
    var render = function (found) {
      items = found;
      list.textContent = '';
      if (!found.length) return close();
      found.forEach(function (it, i) {
        var li = doc.createElement('li');
        li.id = 'suggest-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        var label = doc.createElement('span');
        label.textContent = it.label;
        var kind = doc.createElement('span');
        kind.className = 'kind';
        kind.textContent = it.kind === 'channel' ? 'Channel' : '';
        li.appendChild(label);
        li.appendChild(kind);
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          window.location.href = it.href;
        });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    };

    input.addEventListener('input', function () {
      window.clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return close();
      timer = window.setTimeout(async function () {
        if (controller) controller.abort();
        controller = new AbortController();
        try {
          var res = await window.fetch('/api/suggest?q=' + encodeURIComponent(q), { signal: controller.signal, credentials: 'same-origin' });
          if (!res.ok) return close();
          var data = await res.json();
          if (input.value.trim() === q) render(Array.isArray(data.items) ? data.items.filter(function (x) { return typeof x.href === 'string' && x.href.charAt(0) === '/' && x.href.charAt(1) !== '/'; }) : []);
        } catch (e) {
          /* aborted or offline: no suggestions */
        }
      }, 160);
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlight((active + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlight(active <= 0 ? items.length - 1 : active - 1);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        window.location.href = items[active].href;
      } else if (e.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', close);
  }

  // ---- like, dislike, watch later, subscribe and the bell without reloading the page ----
  function setPressed(btn, on) {
    btn.setAttribute('aria-pressed', String(on));
  }
  function handlers(form, data) {
    var type = form.getAttribute('data-action');
    var btn = form.querySelector('button[type="submit"]');
    var on = form.querySelector('input[name="on"]');
    if (type === 'save') {
      setPressed(btn, data.saved);
      on.value = data.saved ? '0' : '1';
      var label = btn.querySelector('.label-text');
      if (label) label.textContent = data.saved ? 'Saved' : 'Watch later';
      toast(data.saved ? 'Saved to Watch later.' : 'Removed from Watch later.');
    } else if (type === 'subscribe') {
      setPressed(btn, data.subscribed);
      on.value = data.subscribed ? '0' : '1';
      btn.textContent = data.subscribed ? btn.getAttribute('data-label-on') : btn.getAttribute('data-label-off');
      btn.classList.toggle('btn-primary', !data.subscribed);
      btn.classList.toggle('btn-quiet', data.subscribed);
      doc.querySelectorAll('form[data-action="notify"]').forEach(function (f) {
        f.hidden = !data.subscribed;
      });
      doc.querySelectorAll('[data-subscribers]').forEach(function (el) {
        var n = Number(data.subscribers) || 0;
        el.textContent = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) + (n === 1 ? ' subscriber' : ' subscribers');
      });
      toast(data.subscribed ? 'Subscribed. Use the bell if you want to hear about new videos.' : 'Unsubscribed.');
    } else if (type === 'notify') {
      setPressed(btn, data.notify);
      on.value = data.notify ? '0' : '1';
      btn.setAttribute('aria-label', data.notify ? 'Turn off notifications for this channel' : 'Notify me about new videos');
      toast(data.notify ? 'You will be notified about new videos.' : 'Notifications off for this channel.');
    } else if (type === 'vote') {
      var wrap = form.closest('.actions');
      var forms = wrap ? wrap.querySelectorAll('form[data-action="vote"]') : [];
      forms.forEach(function (f, i) {
        var v = f.querySelector('input[name="value"]');
        var b = f.querySelector('button[type="submit"]');
        var target = i === 0 ? 1 : -1;
        v.value = data.mine === target ? '0' : String(target);
        setPressed(b, data.mine === target);
      });
      doc.querySelectorAll('[data-likes]').forEach(function (el) {
        el.textContent = String(data.likes);
      });
    }
  }

  doc.querySelectorAll('form[data-action]').forEach(function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        var res = await post(form.action, new FormData(form));
        if (res.status === 401) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
          return;
        }
        if (!res.ok) {
          toast(await errorMessage(res));
          return;
        }
        handlers(form, await res.json());
      } catch (err) {
        toast('You seem to be offline. Try again when you are back online.');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  });
})();
