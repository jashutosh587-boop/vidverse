#!/usr/bin/env node
/**
 * Starts the site on http://127.0.0.1:3000 with throwaway data: three creator channels, one viewer account, and
 * a handful of short videos that ffmpeg generates (test patterns, not real content). Nothing is saved: the
 * database lives in memory and the files in a temporary folder. For looking around and for screenshots.
 *
 *   node scripts/demo.js              # then open http://127.0.0.1:3000
 *   PORT=4000 node scripts/demo.js
 *
 * Demo accounts all use the password printed at start-up. The view counts and likes are made-up numbers
 * written straight into the database for this demo; the real site only ever counts them through the player.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, LEGAL_VERSION } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { registerAll } from '../src/register.js';

const PASSWORD = 'river-lantern-maple-42';
const port = Number(process.env.PORT ?? 3000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-demo-'));
const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
const config = loadConfig({
  NODE_ENV: 'development', PORT: String(port), BASE_URL: baseUrl, DATA_DIR: dataDir, PGLITE_DIR: 'memory://',
  TRANSCODE_PROFILE: process.env.TRANSCODE_PROFILE ?? 'fast', LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn', WORKER: 'off',
  PAYMENTS_PROVIDER: process.env.PAYMENTS_PROVIDER ?? 'test', ...process.env.ADSENSE_CLIENT ? { ADSENSE_CLIENT: process.env.ADSENSE_CLIENT } : {},
});

const PEOPLE = [
  { handle: 'asha', name: 'Asha Verma', email: 'asha@example.com', bio: 'Home cooking for people who come back tired. New video most weekends.' },
  { handle: 'rohan', name: 'Rohan Mehta', email: 'rohan@example.com', bio: 'Electronics, small programs and things that nearly worked.' },
  { handle: 'priya', name: 'Priya Nair', email: 'priya@example.com', bio: 'Trains, trails and tea stalls across India.' },
  { handle: 'viewer', name: 'Demo Viewer', email: 'viewer@example.com', bio: '' },
];

const SOURCES = {
  plasma: 'gradients=size=854x480:rate=25:speed=0.015:nb_colors=4',
  fractal: 'mandelbrot=size=854x480:rate=25:end_scale=0.05',
  pattern: 'testsrc2=size=854x480:rate=25',
  bars: 'smptebars=size=854x480:rate=25',
  life: 'life=size=854x480:rate=25:mold=12:ratio=0.08:life_color=#33ccff:death_color=#101840:stitch=1',
  rgb: 'rgbtestsrc=size=854x480:rate=25',
  sierpinski: 'sierpinski=size=854x480:rate=25',
};
const NOTE = '\n\n(Demo clip: a generated test pattern, not real content.)';
const VIDEOS = [
  { by: 'asha', source: 'plasma', seconds: 34, category: 'food', title: 'Ten-minute dal that never fails', tags: 'dal, cooking, quick dinner', description: `Toor dal, a pressure cooker and a good tadka. Starts at 0:12, the tadka is at 0:25.${NOTE}`, views: 48210, likes: 3920, avg: 0.64, age: 3 },
  { by: 'asha', source: 'life', seconds: 26, category: 'food', title: 'Why your rotis go hard (and the fix)', tags: 'roti, cooking, basics', description: `Water temperature, resting time and one thing nobody mentions.${NOTE}`, views: 21850, likes: 1710, avg: 0.58, age: 9 },
  { by: 'rohan', source: 'pattern', seconds: 40, category: 'tech', title: 'Reading a datasheet without panic', tags: 'electronics, datasheet, beginners', description: `The four tables that matter and the five you can skip.${NOTE}`, views: 9420, likes: 802, avg: 0.71, age: 1 },
  { by: 'rohan', source: 'sierpinski', seconds: 22, category: 'tech', title: 'A tiny web server in 30 lines', tags: 'programming, javascript, node', description: `Plain Node, no framework.${NOTE}`, views: 15330, likes: 1210, avg: 0.52, age: 6 },
  { by: 'priya', source: 'fractal', seconds: 38, category: 'travel', title: 'Pune to Goa by train in the monsoon', tags: 'train, travel, goa, monsoon', description: `Seven hours of windows. Tunnels at 0:30.${NOTE}`, views: 33120, likes: 2890, avg: 0.69, age: 2 },
  { by: 'priya', source: 'bars', seconds: 20, category: 'music', title: 'Tea stall playlist: five songs', tags: 'music, chai, playlist', description: `What was playing, in order.${NOTE}`, views: 6120, likes: 530, avg: 0.47, age: 14 },
  { by: 'priya', source: 'rgb', seconds: 28, category: 'travel', title: 'Hampi in one day, on foot', tags: 'hampi, travel, heritage', description: `Start early, carry water, skip the autos.${NOTE}`, views: 12780, likes: 1100, avg: 0.6, age: 20 },
  { by: 'rohan', source: 'plasma', seconds: 30, category: 'gaming', title: 'I built a cardboard game console', tags: 'diy, gaming, cardboard', description: `It runs two games. One of them is Snake.${NOTE}`, views: 2210, likes: 190, avg: 0.55, age: 0 },
];

function generate(spec, file) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', SOURCES[spec.source], '-f', 'lavfi', '-i', `sine=frequency=${220 + spec.title.length * 7}`, '-t', String(spec.seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '64k', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const ctx = await createContext(config, { register: [registerAll] });
const { db } = ctx;
const users = {};
for (const p of PEOPLE) {
  await ctx.auth.signup({ email: p.email, password: PASSWORD, handle: p.handle, displayName: p.name }, {});
  const u = await db.one(
    `UPDATE users SET email_verified_at = now(), bio = $2, creator_terms_version = $3, creator_terms_accepted_at = now() WHERE handle = $1 RETURNING id, handle, display_name`,
    [p.handle, p.bio, LEGAL_VERSION],
  );
  users[p.handle] = u;
}

process.stdout.write('Making demo videos');
const made = [];
for (const spec of VIDEOS) {
  const draft = await ctx.videos.createDraft(users[spec.by].id, { title: spec.title, description: spec.description, tags: spec.tags.split(', '), category: spec.category, visibility: 'public', comments_enabled: true, has_paid_promotion: false });
  const tmp = path.join(dataDir, `${draft.id}.mp4`);
  generate(spec, tmp);
  fs.copyFileSync(tmp, ctx.storage.incomingPath(draft.id));
  fs.rmSync(tmp);
  await db.query(`UPDATE videos SET status = 'processing', size_bytes = $2 WHERE id = $1`, [draft.id, fs.statSync(ctx.storage.incomingPath(draft.id)).size]);
  await ctx.jobs.enqueue('transcode', { videoId: draft.id }, { dedupeKey: `transcode:${draft.id}` });
  await ctx.jobs.drain();
  made.push({ id: draft.id, ...spec });
  process.stdout.write('.');
}
process.stdout.write('\n');

// Made-up numbers so the lists look lived in.
const now = Date.now();
for (const v of made) {
  const retentionN = Math.round(v.views * 0.8);
  await db.query(
    `UPDATE videos SET views = $2, likes = $3, dislikes = $4, retention_n = $5, retention_sum = $6, published_at = $7, updated_at = $7 WHERE id = $1`,
    [v.id, v.views, v.likes, Math.round(v.likes * 0.04), retentionN, retentionN * v.avg, new Date(now - v.age * 86400_000)],
  );
  const viewers = Math.min(60, Math.round(v.views / (v.age <= 3 ? 400 : 3000)));
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < viewers; i++) {
      await db.query(
        `INSERT INTO video_view_days (video_id, day, viewer_hash, watch_ms, qualified, counted, last_beat_at) VALUES ($1, (now() - ($2 || ' days')::interval)::date, $3, 30000, true, true, now()) ON CONFLICT DO NOTHING`,
        [v.id, String(d), `demo${d}-${i}-${v.id}`.slice(0, 22)],
      );
    }
  }
}
const byTitle = (t) => made.find((m) => m.title.startsWith(t));
const viewer = users.viewer;
for (const h of ['asha', 'priya']) await ctx.engagement.subscribe(viewer.id, users[h].id);
await ctx.engagement.setNotify(viewer.id, users.asha.id, true);
await db.query(
  `INSERT INTO watch_history (user_id, video_id, position_ms, watched_ms, completed, last_watched_at) VALUES ($1, $2, 14000, 14000, false, now()), ($1, $3, 20000, 20000, true, now() - interval '1 day')`,
  [viewer.id, byTitle('Pune to Goa').id, byTitle('Ten-minute dal').id],
);
const dal = await ctx.videos.get(byTitle('Ten-minute dal').id);
const goa = await ctx.videos.get(byTitle('Pune to Goa').id);
await ctx.comments.add({ user: { id: viewer.id, display_name: viewer.display_name, handle: viewer.handle }, video: dal, body: 'The tadka at 0:25 is the whole trick. Made this twice this week.' });
const c = await db.one('SELECT id FROM comments ORDER BY id LIMIT 1');
await ctx.comments.add({ user: { id: users.asha.id, display_name: users.asha.display_name, handle: users.asha.handle }, video: dal, body: 'So glad it worked! Try a pinch of hing next time.', parentId: c.id });
await ctx.comments.add({ user: { id: users.rohan.id, display_name: users.rohan.display_name, handle: users.rohan.handle }, video: goa, body: 'The tunnel section is beautiful.' });
await ctx.engagement.vote(viewer.id, dal.id, 1);
await ctx.notifications.create(viewer.id, 'new_video', { videoId: byTitle('Why your rotis').id, title: 'Why your rotis go hard (and the fix)', channel: 'Asha Verma', handle: 'asha' });

const app = createApp(ctx, { extraRoutes: ctx.extraRoutes });
const server = app.listen(port, config.host, () => {
  console.log(`\nVidverse demo is running at ${baseUrl}`);
  console.log('Sign in with any of these (password for all of them: ' + PASSWORD + '):');
  for (const p of PEOPLE) console.log(`  ${p.email.padEnd(22)} ${p.name}`);
  console.log('\nData is in memory and disappears when you stop the server (Ctrl+C).');
});
const stop = async () => {
  server.close();
  await ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
