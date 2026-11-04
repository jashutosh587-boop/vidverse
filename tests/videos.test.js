import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startTestApp } from './helpers/app.js';
import { createMember, PASSWORD } from './helpers/users.js';
import { sampleBytes } from './helpers/sample.js';

const META = { title: 'Pune street food walk', description: 'A short walk.\nSecond line.', tags: 'food, pune, #Street Food', category: 'food', visibility: 'public' };

/** Creates a draft, sends the file, and returns { id, draft, upload }. */
async function upload(app, client, { meta = {}, bytes = sampleBytes(), type = 'video/mp4' } = {}) {
  const draft = await client.postJson('/api/studio/videos', { ...META, ...meta });
  if (draft.status !== 201) return { draft };
  const id = draft.json().id;
  const token = await client.csrfToken();
  const up = await client.request('PUT', `/api/studio/videos/${id}/source`, { body: bytes, headers: { 'content-type': type, 'x-csrf-token': token } });
  return { id, draft, upload: up };
}

describe('uploading, processing and playing a video', () => {
  let app;
  let cc;
  let video;
  let oc;

  before(async () => {
    app = await startTestApp();
    cc = app.client();
    await createMember(app, cc, { email: 'asha@example.com', handle: 'asha' });
    await cc.post('/studio/terms', { agree: '1' });
    oc = app.client();
    await createMember(app, oc, { email: 'rohan@example.com', handle: 'rohan' });
  });
  after(() => app.close());

  describe('before a file is sent', () => {
    test('uploading is closed until the address is confirmed and the creator terms are accepted', async () => {
      const unconfirmed = app.client();
      await createMember(app, unconfirmed, { email: 'new@example.com', handle: 'newbie', verify: false, signIn: false });
      await app.ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE handle = 'newbie'`);
      const c = app.client();
      await c.post('/login', { email: 'new@example.com', password: PASSWORD });
      const r = await c.postJson('/api/studio/videos', META);
      assert.equal(r.status, 403);
      assert.equal(r.json().error.code, 'creator_terms');
      assert.equal((await c.get('/studio/upload')).location, '/studio/terms');
      assert.equal((await app.client().postJson('/api/studio/videos', META)).status, 401);
    });

    test('the details are checked on the server', async () => {
      for (const bad of [{ title: '' }, { title: 'x'.repeat(101) }, { category: 'not-a-category' }, { visibility: 'everyone' }]) {
        const r = await cc.postJson('/api/studio/videos', { ...META, ...bad });
        assert.equal(r.status, 422, JSON.stringify(bad));
      }
      assert.equal((await app.ctx.db.query('SELECT 1 FROM videos')).rows.length, 0, 'nothing was created');
    });

    test('tags are cleaned: lower-cased, # removed, duplicates and junk dropped, at most ten', async () => {
      const r = await cc.postJson('/api/studio/videos', { ...META, tags: 'Food, #food, FOOD ,  , <script>, ' + Array.from({ length: 15 }, (_, i) => `t${i}`).join(',') });
      assert.equal(r.status, 201);
      const row = await app.ctx.db.one('SELECT tags FROM videos WHERE id = $1', [r.json().id]);
      assert.equal(row.tags.length, 10);
      assert.equal(row.tags[0], 'food');
      assert.ok(row.tags.every((t) => /^[\p{L}\p{N} _-]+$/u.test(t)));
      await app.ctx.videos.deleteVideo(r.json().id);
    });
  });

  describe('sending a file', () => {
    test('a real video becomes ready, with a playlist, segments and a thumbnail', async () => {
      const out = await upload(app, cc);
      assert.equal(out.draft.status, 201);
      assert.equal(out.upload.status, 202);
      video = out.id;
      assert.equal((await cc.get(`/api/studio/videos/${video}/status`)).json().status, 'processing');
      await app.ctx.jobs.drain();
      const status = (await cc.get(`/api/studio/videos/${video}/status`)).json();
      assert.equal(status.status, 'ready', JSON.stringify(status));
      assert.ok(status.durationMs >= 5000 && status.durationMs <= 7000, `duration ${status.durationMs}`);
      const row = await app.ctx.db.one('SELECT * FROM videos WHERE id = $1', [video]);
      assert.equal(row.visibility, 'public');
      assert.ok(row.published_at, 'a public video gets a publish time');
      assert.ok(row.thumb_name);
      assert.ok(!fs.existsSync(app.ctx.storage.incomingPath(video)), 'the original upload is removed after processing');
    });

    test('anyone can fetch the playlist and its pieces, with the right types and cache rules', async () => {
      const anon = app.client();
      const master = await anon.get(`/media/v/${video}/master.m3u8`);
      assert.equal(master.status, 200);
      assert.equal(master.header('content-type'), 'application/vnd.apple.mpegurl');
      assert.match(master.header('cache-control'), /^public, max-age=60$/);
      assert.match(master.header('x-content-type-options'), /nosniff/);
      assert.match(master.text, /#EXTM3U/);
      const rendition = /^(\d+p)\/index\.m3u8$/m.exec(master.text)?.[1];
      assert.ok(rendition, `a rendition is listed:\n${master.text}`);
      const list = await anon.get(`/media/v/${video}/${rendition}/index.m3u8`);
      assert.equal(list.status, 200);
      const seg = /^(seg_\d{5}\.ts)$/m.exec(list.text)[1];
      const piece = await anon.get(`/media/v/${video}/${rendition}/${seg}`);
      assert.equal(piece.status, 200);
      assert.equal(piece.header('content-type'), 'video/mp2t');
      assert.match(piece.header('cache-control'), /immutable/);
      assert.equal(piece.buffer[0], 0x47, 'an MPEG transport stream packet starts with 0x47');
      const ranged = await anon.get(`/media/v/${video}/${rendition}/${seg}`, { headers: { range: 'bytes=0-187' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.buffer.length, 188);
      const thumb = await anon.get(`/media/t/${video}.jpg`);
      assert.equal(thumb.status, 200);
      assert.equal(thumb.header('content-type'), 'image/jpeg');
      assert.deepEqual([...thumb.buffer.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    });

    test('the watch page shows the title and description as text, counts nothing yet, and offers the player', async () => {
      const page = await app.client().get(`/watch/${video}`);
      assert.equal(page.status, 200);
      assert.match(page.text, /Pune street food walk/);
      assert.match(page.text, /master\.m3u8/);
      assert.ok(page.text.includes('<title>Pune street food walk'));
    });

    test('files that are not video are refused and the draft stays empty', async () => {
      for (const [name, bytes] of [['text', Buffer.from('this is not a video, just words '.repeat(50))], ['html', Buffer.from('<html><script>alert(1)</script></html>'.repeat(20))], ['zip', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(2000)])]]) {
        const out = await upload(app, cc, { meta: { title: `bad ${name}` }, bytes, type: 'video/mp4' });
        assert.equal(out.upload.status, 415, name);
        assert.equal((await app.ctx.db.one('SELECT status FROM videos WHERE id = $1', [out.id])).status, 'uploading', name);
        assert.ok(!fs.existsSync(app.ctx.storage.incomingPath(out.id)), `${name}: nothing kept on disk`);
      }
    });

    test('a file that looks like video but cannot be played ends as "failed", with a reason the creator can read', async () => {
      const real = sampleBytes();
      const broken = Buffer.concat([real.subarray(0, 40), Buffer.alloc(3000, 7)]);
      const out = await upload(app, cc, { meta: { title: 'Broken file' }, bytes: broken });
      assert.equal(out.upload.status, 202);
      for (let i = 0; i < 4; i++) {
        await app.ctx.jobs.drain();
        app.clock.advance(5 * 60_000);
      }
      const status = (await cc.get(`/api/studio/videos/${out.id}/status`)).json();
      assert.equal(status.status, 'failed');
      assert.ok(status.failReason && status.failReason.length > 10 && !/\n|\/tmp|ffmpeg/i.test(status.failReason), `a plain reason: ${status.failReason}`);
    });

    test('a second file for the same draft, and files from other people, are refused', async () => {
      const token = await cc.csrfToken();
      const again = await cc.request('PUT', `/api/studio/videos/${video}/source`, { body: sampleBytes(), headers: { 'x-csrf-token': token } });
      assert.equal(again.status, 409);
      const draft = (await cc.postJson('/api/studio/videos', META)).json().id;
      const theirs = await oc.request('PUT', `/api/studio/videos/${draft}/source`, { body: sampleBytes(), headers: { 'x-csrf-token': await oc.csrfToken() } });
      assert.equal(theirs.status, 404, 'looks like it does not exist');
      assert.equal((await app.ctx.db.one('SELECT status FROM videos WHERE id = $1', [draft])).status, 'uploading');
      await app.ctx.videos.deleteVideo(draft);
    });

    test('the daily limit stops a runaway script, and deleting a draft frees the slot', async () => {
      const small = await startTestApp({ env: { DAILY_UPLOAD_LIMIT: '2' } });
      try {
        const c = small.client();
        await createMember(small, c, { email: 'many@example.com', handle: 'many1' });
        await c.post('/studio/terms', { agree: '1' });
        const a = await c.postJson('/api/studio/videos', META);
        const b = await c.postJson('/api/studio/videos', META);
        const third = await c.postJson('/api/studio/videos', META);
        assert.deepEqual([a.status, b.status], [201, 201]);
        assert.ok([403, 429].includes(third.status), `third is refused, got ${third.status}`);
        assert.match(third.json().error.message, /up to 2 uploads a day/);
        await small.ctx.videos.deleteVideo(a.json().id);
        assert.equal((await c.postJson('/api/studio/videos', META)).status, 201);
        small.clock.advance(25 * 3600_000);
        assert.equal((await c.postJson('/api/studio/videos', META)).status, 201, 'a new day');
      } finally {
        await small.close();
      }
    });
  });

  describe('size and storage limits', () => {
    test('a file over the maximum is refused before it is stored; a creator over their allowance is told', async () => {
      const small = await startTestApp({ env: { MAX_UPLOAD_BYTES: '200000', CREATOR_STORAGE_QUOTA_BYTES: '300000' } });
      try {
        const c = small.client();
        await createMember(small, c, { email: 'big@example.com', handle: 'biggie' });
        await c.post('/studio/terms', { agree: '1' });
        const big = await upload(small, c, { bytes: Buffer.alloc(250_000, 1) });
        assert.equal(big.upload.status, 413);
        assert.equal(big.upload.json().error.code, 'too_large');
        const ok = await upload(small, c, { bytes: sampleBytes({ seconds: 2, width: 160, height: 90, audio: false }) });
        assert.ok([202, 413].includes(ok.upload.status));
        if (ok.upload.status === 202) {
          const used = (await small.ctx.videos.storageUsed((await small.ctx.db.one(`SELECT id FROM users WHERE handle = 'biggie'`)).id)) ;
          assert.ok(used > 0);
          await small.ctx.db.query(`UPDATE videos SET size_bytes = 299000 WHERE id = $1`, [ok.id]);
          const over = await upload(small, c, { bytes: Buffer.concat([sampleBytes({ seconds: 2, width: 160, height: 90, audio: false })]) });
          assert.equal(over.upload.status, 413);
          assert.equal(over.upload.json().error.code, 'quota');
        }
      } finally {
        await small.close();
      }
    });
  });

  describe('who can see what', () => {
    let priv;
    let unlisted;
    before(async () => {
      for (const visibility of ['private', 'unlisted']) {
        const out = await upload(app, cc, { meta: { title: `A ${visibility} video`, visibility } });
        await app.ctx.jobs.drain();
        if (visibility === 'private') priv = out.id;
        else unlisted = out.id;
        assert.equal((await app.ctx.db.one('SELECT status FROM videos WHERE id = $1', [out.id])).status, 'ready');
      }
    });

    test('a private video is invisible to everyone but its owner — pages and files alike — and gives no hint that it exists', async () => {
      const probes = [`/watch/${priv}`, `/media/v/${priv}/master.m3u8`, `/media/t/${priv}.jpg`];
      for (const who of [app.client(), oc]) {
        for (const p of probes) assert.equal((await who.get(p)).status, 404, p);
      }
      const missing = await app.client().get('/watch/AAAAAAAAAAA');
      const hidden = await app.client().get(`/watch/${priv}`);
      assert.equal(hidden.status, missing.status);
      assert.equal(hidden.text.replace(/nonce="[^"]*"|content="[^"]{40,}"/g, ''), missing.text.replace(/nonce="[^"]*"|content="[^"]{40,}"/g, '').replace('AAAAAAAAAAA', priv), 'the same page whether it is hidden or missing');
      assert.equal((await cc.get(`/watch/${priv}`)).status, 200);
      assert.equal((await cc.get(`/media/v/${priv}/master.m3u8`)).status, 200);
      assert.match((await cc.get(`/media/v/${priv}/master.m3u8`)).header('cache-control'), /^private/);
    });

    test('a refused file is a quiet plain-text 404: it is not a fault, so it is not logged as an error', async () => {
      const logged = [];
      const realError = app.ctx.log.error;
      app.ctx.log.error = (...args) => logged.push(args);
      try {
        for (const p of [`/media/t/${priv}.jpg`, `/media/v/${priv}/master.m3u8`, `/media/v/${priv}/360p/seg_00000.ts`, '/media/t/AAAAAAAAAAA.jpg']) {
          const refused = await app.client().get(p);
          assert.equal(refused.status, 404, p);
          assert.match(refused.header('content-type'), /^text\/plain/, p);
          assert.equal(refused.text, 'Not found.', p);
        }
      } finally {
        app.ctx.log.error = realError;
      }
      assert.deepEqual(logged, []);
    });

    test('a viewer who closes the connection in the middle of a download is not logged as a server error', async () => {
      // Players do this all the time: the tab is closed, the person skips ahead, the quality switches. It is not a fault.
      const file = app.ctx.storage.resolve(unlisted, '360p', 'seg_09999.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024)); // far more than the connection can hold, so the transfer is still going when the viewer leaves
      const logged = [];
      const realError = app.ctx.log.error;
      app.ctx.log.error = (...args) => logged.push(args);
      try {
        const { port } = new URL(app.baseUrl);
        await new Promise((resolve) => {
          const socket = net.connect(Number(port), '127.0.0.1', () => {
            socket.write(`GET /media/v/${unlisted}/360p/seg_09999.ts HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
          });
          socket.on('data', () => socket.destroy()); // the answer has started: hang up
          socket.on('error', () => {});
          socket.on('close', resolve);
        });
        await new Promise((resolve) => setTimeout(resolve, 600)); // let the server notice
      } finally {
        app.ctx.log.error = realError;
        fs.rmSync(file, { force: true });
      }
      assert.deepEqual(logged.map((l) => l[1]?.err?.message ?? l[0]), []);
      assert.equal((await app.client().get(`/media/v/${unlisted}/master.m3u8`)).status, 200, 'and the site carries on');
    });

    test('an unlisted video plays for anyone with the link but is not listed or searchable', async () => {
      assert.equal((await app.client().get(`/watch/${unlisted}`)).status, 200);
      assert.equal((await app.client().get(`/media/v/${unlisted}/master.m3u8`)).status, 200);
      for (const p of ['/', '/trending', '/results?q=unlisted', '/@asha']) {
        const page = await app.client().get(p);
        assert.ok(!page.text.includes(unlisted), `${p} does not list it`);
        assert.ok(!page.text.includes('A unlisted video'), `${p} does not name it`);
      }
      assert.ok(!(await app.client().get('/sitemap.xml')).text.includes(unlisted), 'not in the sitemap');
      assert.match((await app.client().get(`/watch/${unlisted}`)).text, /noindex/);
    });

    test('a public video is listed, searchable and in the sitemap', async () => {
      assert.ok((await app.client().get('/')).text.includes(video));
      assert.ok((await app.client().get('/results?q=street+food')).text.includes(video));
      assert.ok((await app.client().get('/@asha')).text.includes(video));
      assert.ok((await app.client().get('/sitemap.xml')).text.includes(`/watch/${video}`));
    });

    test('nobody else can open, change, delete or read the status of someone’s video', async () => {
      const token = await oc.csrfToken();
      assert.equal((await oc.get(`/studio/videos/${video}`)).status, 404);
      assert.equal((await oc.post(`/studio/videos/${video}`, { ...META, title: 'Hijacked' })).status, 404);
      assert.equal((await oc.post(`/studio/videos/${video}/delete`, { confirm: '1' })).status, 404);
      assert.equal((await oc.post(`/studio/videos/${video}/thumbnail`, { thumb: 'thumb_0.jpg' })).status, 404);
      assert.equal((await oc.get(`/api/studio/videos/${video}/status`)).status, 404);
      assert.equal((await oc.request('PUT', `/api/studio/videos/${video}/thumbnail`, { body: Buffer.alloc(500, 1), headers: { 'x-csrf-token': token } })).status, 404);
      assert.equal((await oc.get(`/media/f/${video}/thumb_0.jpg`)).status, 404, 'candidate frames are for the owner');
      assert.equal((await app.client().get(`/studio/videos/${video}`)).status, 303);
      const row = await app.ctx.db.one('SELECT title, status FROM videos WHERE id = $1', [video]);
      assert.deepEqual({ t: row.title, s: row.status }, { t: META.title, s: 'ready' });
    });

    test('the owner sees the candidate thumbnail frames of their own public video; nobody else does', async () => {
      // found by the browser test: the owner of a PUBLIC video got 404 here, so the thumbnail chooser showed broken images
      for (const n of [0, 1, 2]) {
        const r = await cc.get(`/media/f/${video}/thumb_${n}.jpg`);
        assert.equal(r.status, 200, `frame ${n}`);
        assert.match(r.header('content-type'), /image\/jpeg/);
        assert.match(r.header('cache-control'), /no-store/);
        assert.ok(r.buffer.length > 500);
      }
      assert.equal((await app.client().get(`/media/f/${video}/thumb_0.jpg`)).status, 404, 'a stranger');
      assert.equal((await oc.get(`/media/f/${video}/thumb_0.jpg`)).status, 404, 'another member');
    });

    test('the owner can edit; hostile text is stored as typed and shown as text everywhere', async () => {
      const evil = '<img src=x onerror=alert(1)> & "quotes" \'single\'';
      const r = await cc.post(`/studio/videos/${video}`, { ...META, title: evil, description: `${evil}\n<script>alert(2)</script>`, tags: 'a<b>c, ok' });
      assert.equal(r.status, 303);
      for (const p of [`/watch/${video}`, '/', '/results?q=quotes', '/@asha', `/studio/videos/${video}`, '/studio/videos', '/studio']) {
        const page = await cc.get(p);
        assert.ok(!page.text.includes('<img src=x'), `${p}: no raw tag`);
        assert.ok(!page.text.includes('<script>alert'), `${p}: no raw script`);
        const withoutValues = page.text.replace(/="[^"]*"|='[^']*'/g, '=""'); // text inside quotes is only text
        assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(withoutValues), `${p}: no element carries an event handler`);
      }
      assert.ok((await cc.get(`/watch/${video}`)).text.includes('&lt;img src=x onerror=alert(1)&gt;'));
      await cc.post(`/studio/videos/${video}`, META);
    });

    test('a staff removal takes the files offline for everyone, including the owner', async () => {
      const staff = await app.ctx.db.one(`SELECT id, role FROM users WHERE handle = 'rohan'`);
      await app.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [staff.id]);
      const gone = await upload(app, cc, { meta: { title: 'About to go' } });
      await app.ctx.jobs.drain();
      assert.equal((await app.client().get(`/media/v/${gone.id}/master.m3u8`)).status, 200);
      await app.ctx.videos.removeByStaff(gone.id, staff.id, 'Test removal');
      for (const who of [app.client(), cc]) assert.equal((await who.get(`/media/v/${gone.id}/master.m3u8`)).status, 404);
      assert.equal((await app.client().get(`/watch/${gone.id}`)).status, 404);
      const ownerView = await cc.get(`/watch/${gone.id}`);
      assert.equal(ownerView.status, 303, 'the owner is sent to the studio page, which explains what happened');
      assert.equal(ownerView.location, `/studio/videos/${gone.id}`);
      assert.match((await cc.get(ownerView.location)).text, /Test removal/);
      const edit = await cc.post(`/studio/videos/${gone.id}`, { ...META, title: 'Try to bring it back' });
      assert.equal(edit.status, 403);
      await app.ctx.db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [staff.id]);
    });

    test('file requests cannot climb out of the video folder', async () => {
      const anon = app.client();
      const attempts = [
        `/media/v/${video}/..%2f..%2f..%2fetc%2fpasswd`,
        `/media/v/${video}/%2e%2e/%2e%2e/index.m3u8`,
        `/media/v/..%2f${video}/master.m3u8`,
        `/media/v/${video}/360p/..%2f..%2fmaster.m3u8`,
        `/media/v/${video}/360p/seg_00000.ts%00.m3u8`,
        `/media/v/${video}/master.m3u8/../../../etc/passwd`,
        `/media/t/..%2f${video}.jpg`,
        `/media/f/${video}/..%2fthumb_0.jpg`,
        '/media/v/AAAAAAAAAAA/master.m3u8',
      ];
      for (const p of attempts) {
        const r = await anon.get(p);
        assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
        assert.ok(!/root:|#EXTM3U/.test(r.text), p);
      }
    });

    test('deleting a video removes its files and everything attached to it', async () => {
      const doomed = await upload(app, cc, { meta: { title: 'Delete me' } });
      await app.ctx.jobs.drain();
      const dir = app.ctx.storage.videoDir(doomed.id);
      assert.ok(fs.existsSync(dir));
      await cc.post(`/studio/videos/${doomed.id}/delete`, {});
      assert.ok(await app.ctx.db.one('SELECT 1 AS x FROM videos WHERE id = $1', [doomed.id]), 'needs the confirmation box');
      await cc.post(`/studio/videos/${doomed.id}/delete`, { confirm: '1' });
      assert.equal(await app.ctx.db.one('SELECT 1 AS x FROM videos WHERE id = $1', [doomed.id]), null);
      assert.ok(!fs.existsSync(dir), 'the folder is gone');
      assert.equal((await app.client().get(`/media/v/${doomed.id}/master.m3u8`)).status, 404);
    });
  });
});
