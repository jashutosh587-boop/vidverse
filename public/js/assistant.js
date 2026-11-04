/* The help assistant widget. It asks /api/assistant, which answers only from the help articles.
   Replies are written with textContent, and links are only followed when they stay on this site. */
(function () {
  'use strict';
  var root = document.querySelector('[data-assistant]');
  if (!root) return;
  var toggle = root.querySelector('.assistant-toggle');
  var panel = document.getElementById('assistant-panel');
  var form = root.querySelector('.assistant-form');
  var input = form.querySelector('input[name="q"]');
  var log = root.querySelector('.assistant-log');
  var closeBtn = root.querySelector('[data-assistant-close]');
  var vv = window.vv;
  var busy = false;

  function open() {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function close() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }
  toggle.addEventListener('click', function () {
    if (panel.hidden) open();
    else close();
  });
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  function bubble(kind, text) {
    var p = document.createElement('p');
    p.className = 'assistant-msg assistant-' + kind;
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
    return p;
  }
  function sameSiteLink(url) {
    return typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/' && url.charAt(1) !== '\\';
  }
  function addSources(msg, sources, answered) {
    var ul = document.createElement('ul');
    ul.className = 'assistant-sources';
    (sources || []).forEach(function (s) {
      if (!sameSiteLink(s.url)) return;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = s.url;
      a.textContent = s.title;
      li.appendChild(a);
      ul.appendChild(li);
    });
    if (!answered) {
      var li2 = document.createElement('li');
      var c = document.createElement('a');
      c.href = '/contact';
      c.textContent = 'Contact support';
      li2.appendChild(c);
      ul.appendChild(li2);
    }
    if (ul.children.length) msg.appendChild(ul);
  }

  form.addEventListener('submit', async function (e) {
    if (!window.fetch || !vv) return; // without JavaScript the form searches the help center instead
    e.preventDefault();
    var q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    input.value = '';
    bubble('user', q);
    var pending = bubble('bot', 'Looking through the help articles…');
    try {
      var res = await vv.post('/api/assistant', { q: q }, true);
      if (!res.ok) {
        pending.textContent = res.status === 429 ? 'You are asking quickly. Wait a moment and try again.' : await vv.errorMessage(res);
        return;
      }
      var data = await res.json();
      pending.textContent = data.answer || 'I could not find an answer.';
      addSources(pending, data.sources, data.answered);
    } catch (err) {
      pending.textContent = 'I could not reach the help service. You can also browse the help center.';
    } finally {
      busy = false;
      log.scrollTop = log.scrollHeight;
    }
  });
})();
