/* Studio scripts: the upload form (create the draft, send the file with progress, wait for processing),
   uploading a custom thumbnail, and refreshing an edit page when processing finishes. */
(function () {
  'use strict';
  var vv = window.vv;
  if (!vv) return;

  function formatBytes(n) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }
  function sleep(ms) {
    return new Promise(function (r) {
      window.setTimeout(r, ms);
    });
  }

  // ------------------------------------------------------------ upload form
  var form = document.getElementById('upload-form');
  if (form) {
    var fileInput = document.getElementById('file');
    var fileName = document.getElementById('file-name');
    var zone = form.querySelector('.dropzone');
    var box = form.querySelector('.progressbox');
    var bar = document.getElementById('upload-progress');
    var statusEl = document.getElementById('upload-status');
    var submit = document.getElementById('upload-submit');
    var done = document.getElementById('upload-done');
    var maxBytes = Number(form.getAttribute('data-max-bytes')) || 0;
    var draftId = null;
    var chosen = null;

    var choose = function (f) {
      if (!f) return;
      if (maxBytes && f.size > maxBytes) {
        chosen = null;
        fileName.textContent = f.name + ' is ' + formatBytes(f.size) + ', which is over the limit of ' + formatBytes(maxBytes) + '.';
        return;
      }
      chosen = f;
      fileName.textContent = f.name + ' (' + formatBytes(f.size) + ')';
      var title = document.getElementById('f-title');
      if (title && !title.value) title.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100);
    };
    fileInput.addEventListener('change', function () {
      choose(fileInput.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        zone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        zone.classList.remove('drag');
      });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) choose(e.dataTransfer.files[0]);
    });

    var say = function (text) {
      statusEl.textContent = text;
    };
    var fail = function (text) {
      say(text);
      submit.disabled = false;
      submit.textContent = draftId ? 'Try the upload again' : 'Upload';
    };

    var sendFile = function (id, file) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/studio/videos/' + encodeURIComponent(id) + '/source');
        xhr.setRequestHeader('X-CSRF-Token', vv.csrf);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var pct = Math.round((e.loaded / e.total) * 100);
          bar.value = pct;
          say('Uploading ' + pct + '% (' + formatBytes(e.loaded) + ' of ' + formatBytes(e.total) + '). Keep this page open.');
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) return resolve();
          var message = 'The upload did not work. Please try again.';
          try {
            message = JSON.parse(xhr.responseText).error.message || message;
          } catch (e) {
            /* keep the default */
          }
          reject(new Error(message));
        };
        xhr.onerror = function () {
          reject(new Error('The connection dropped during the upload. Press the button to try again.'));
        };
        xhr.send(file);
      });
    };

    var waitForProcessing = async function (id) {
      say('Upload finished. Processing the video into streaming formats. This can take a few minutes.');
      bar.removeAttribute('value'); // indeterminate
      for (;;) {
        await sleep(2500);
        var res = await window.fetch('/api/studio/videos/' + encodeURIComponent(id) + '/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        var s = await res.json();
        if (s.status === 'ready') return s;
        if (s.status === 'failed') throw new Error(s.failReason || 'We could not process that video.');
      }
    };

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!chosen) {
        fileName.textContent = 'Choose a video file first.';
        fileInput.focus();
        return;
      }
      var titleEl = document.getElementById('f-title');
      if (!titleEl.value.trim()) {
        titleEl.focus();
        return;
      }
      submit.disabled = true;
      box.hidden = false;
      bar.value = 0;
      say('Preparing…');
      try {
        if (!draftId) {
          var data = new URLSearchParams(new FormData(form));
          data.delete('file');
          ['comments_enabled', 'has_paid_promotion'].forEach(function (name) {
            data.delete(name);
            var cb = form.elements[name];
            if (cb && cb.checked) data.set(name, '1');
          });
          var res = await vv.post('/api/studio/videos', data);
          if (!res.ok) return fail(await vv.errorMessage(res));
          draftId = (await res.json()).id;
        }
        await sendFile(draftId, chosen);
        await waitForProcessing(draftId);
        bar.value = 100;
        say('');
        done.hidden = false;
        done.textContent = '';
        var ok = document.createElement('span');
        ok.textContent = 'Your video is ready. ';
        var edit = document.createElement('a');
        edit.className = 'btn btn-primary';
        edit.href = '/studio/videos/' + encodeURIComponent(draftId);
        edit.textContent = 'Review details and thumbnail';
        done.appendChild(ok);
        done.appendChild(edit);
        submit.hidden = true;
      } catch (err) {
        fail(err.message);
      }
    });
  }

  // ------------------------------------------------------------ custom thumbnail
  var thumb = document.querySelector('[data-thumb-upload]');
  if (thumb) {
    var input = document.getElementById('thumb-file');
    var note = thumb.querySelector('[data-thumb-status]');
    input.addEventListener('change', async function () {
      var f = input.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) {
        note.textContent = 'That image is over 3 MB. Choose a smaller one.';
        return;
      }
      note.textContent = 'Uploading…';
      try {
        var res = await window.fetch('/api/studio/videos/' + encodeURIComponent(thumb.getAttribute('data-thumb-upload')) + '/thumbnail', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': vv.csrf, Accept: 'application/json', 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        });
        if (!res.ok) {
          note.textContent = await vv.errorMessage(res);
          return;
        }
        window.location.href = window.location.pathname + '?saved=1';
      } catch (err) {
        note.textContent = 'The upload did not work. Check your connection and try again.';
      }
    });
  }

  // ------------------------------------------------------------ edit page: reload when processing finishes
  var processing = document.querySelector('[data-processing]');
  if (processing) {
    var pid = processing.getAttribute('data-processing');
    (async function poll() {
      for (;;) {
        await sleep(3000);
        try {
          var res = await window.fetch('/api/studio/videos/' + encodeURIComponent(pid) + '/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          if (res.ok && (await res.json()).status !== 'processing') {
            window.location.reload();
            return;
          }
        } catch (e) {
          /* try again */
        }
      }
    })();
  }
})();
