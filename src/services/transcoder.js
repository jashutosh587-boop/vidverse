import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Turns an uploaded file into adaptive-bitrate HLS (H.264 + AAC) and thumbnails with ffmpeg.
 *
 * Safety rules for running ffmpeg on strangers' files:
 *   - the container is identified from the file's first bytes and forced with -f, so ffmpeg never auto-detects
 *     playlist-style formats (HLS, concat, SDP) that can reference other files or network addresses;
 *   - -protocol_whitelist file, so nothing can reach the network even if a format tried to;
 *   - arguments are passed as an array (no shell), the only file names are server-generated;
 *   - every run has a timeout and capped output.
 */
const DEMUXERS = {
  mp4: 'mov,mp4,m4a,3gp,3g2,mj2',
  matroska: 'matroska,webm',
  avi: 'avi',
};

export function sniffContainer(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    if (n < 12) return null;
    const tag = b.toString('latin1', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(tag)) return 'mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI ') return 'avi';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function sniffImage(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const b = Buffer.alloc(16);
    if (fs.readSync(fd, b, 0, 16, 0) < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.toString('latin1', 1, 4) === 'PNG' && b[0] === 0x89) return 'png';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function run(cmd, args, { timeoutMs = 60_000, maxOut = 4_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      if (out.length < maxOut) out += d;
    });
    p.stderr.on('data', (d) => {
      if (err.length < 8000) err += d;
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error(`${cmd} timed out`), { timedOut: true }));
      if (code !== 0) return reject(Object.assign(new Error(`${cmd} exited with ${code}`), { stderr: err.slice(-1500), code }));
      resolve({ stdout: out, stderr: err });
    });
  });
}

const FFMPEG = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-threads', '2'];

/** Reads a file with ffprobe and returns what the pipeline needs, or throws a Rejection with a message safe to show. */
export class Rejection extends Error {}

export async function probe(filePath, { maxSeconds }) {
  const kind = sniffContainer(filePath);
  if (!kind) throw new Rejection('That file type is not supported. Upload an MP4, MOV, WebM, MKV or AVI video.');
  let info;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', DEMUXERS[kind], '-print_format', 'json', '-show_format', '-show_streams', '-i', filePath], { timeoutMs: 30_000 });
    info = JSON.parse(stdout);
  } catch {
    throw new Rejection('We could not read that video. It may be damaged or in an unusual format.');
  }
  const streams = info.streams ?? [];
  if (streams.length > 16) throw new Rejection('That file has too many tracks.');
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Rejection('That file has no video track.');
  const a = streams.find((s) => s.codec_type === 'audio');
  let width = Number(v.width);
  let height = Number(v.height);
  const rotation = Math.abs(Number(v.side_data_list?.find((d) => 'rotation' in d)?.rotation ?? v.tags?.rotate ?? 0)) % 360;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  if (!(width > 0 && height > 0)) throw new Rejection('We could not work out the size of that video.');
  if (width > 7680 || height > 7680) throw new Rejection('That video is larger than 8K, which is more than we can process.');
  const seconds = Number(info.format?.duration ?? v.duration);
  if (!(seconds > 0)) throw new Rejection('We could not work out how long that video is.');
  if (seconds < 1) throw new Rejection('That video is shorter than one second.');
  if (seconds > maxSeconds) throw new Rejection(`Videos can be at most ${Math.round(maxSeconds / 60)} minutes long.`);
  const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  return { kind, demuxer: DEMUXERS[kind], durationMs: Math.round(seconds * 1000), width, height, hasAudio: !!a, fps: fps > 0 && fps < 241 ? fps : 30 };
}

const LADDER = {
  standard: [
    { name: '1080p', height: 1080, videoKbps: 5000, audioKbps: 192, level: '4.2', avc: '64002a' },
    { name: '720p', height: 720, videoKbps: 2800, audioKbps: 128, level: '4.0', avc: '640028' },
    { name: '480p', height: 480, videoKbps: 1400, audioKbps: 128, level: '3.1', avc: '64001f' },
    { name: '360p', height: 360, videoKbps: 800, audioKbps: 96, level: '3.1', avc: '64001f' },
    { name: '240p', height: 240, videoKbps: 400, audioKbps: 64, level: '3.1', avc: '64001f' },
  ],
  fast: [{ name: '360p', height: 360, videoKbps: 800, audioKbps: 96, level: '3.1', avc: '64001f' }],
};

/** Renditions at or below the source height (never upscale); at least one, even for a tiny source. */
export function chooseRenditions(profile, sourceHeight) {
  const ladder = LADDER[profile] ?? LADDER.standard;
  const chosen = ladder.filter((r) => r.height <= sourceHeight);
  if (chosen.length) return chosen;
  const smallest = ladder[ladder.length - 1];
  return [{ ...smallest, name: `${Math.max(2, sourceHeight - (sourceHeight % 2))}p`, height: Math.max(2, sourceHeight - (sourceHeight % 2)) }];
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function readPlaylist(playlistPath, dir) {
  const lines = fs.readFileSync(playlistPath, 'utf8').split('\n');
  const segs = [];
  let dur = null;
  for (const line of lines) {
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) dur = Number(m[1]);
    else if (line && !line.startsWith('#') && dur !== null) {
      segs.push({ dur, bytes: fs.statSync(path.join(dir, line.trim())).size });
      dur = null;
    }
  }
  return segs;
}

export async function encodeRendition({ input, demuxer, outDir, r, probeInfo, profile }) {
  const dir = path.join(outDir, r.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const width = even((probeInfo.width * r.height) / probeInfo.height);
  const preset = profile === 'fast' ? 'ultrafast' : 'veryfast';
  const args = [
    ...FFMPEG, '-y', '-f', demuxer, '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${width}:${r.height}:flags=bicubic,format=yuv420p`,
    '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-level:v', r.level, '-crf', '23',
    '-maxrate', `${r.videoKbps}k`, '-bufsize', `${r.videoKbps * 2}k`,
    '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), path.join(dir, 'index.m3u8'),
  ];
  const timeoutMs = Math.max(120_000, probeInfo.durationMs * 4 + 60_000);
  await run('ffmpeg', args, { timeoutMs });
  const segs = readPlaylist(path.join(dir, 'index.m3u8'), dir);
  if (!segs.length) throw new Error('ffmpeg produced no segments');
  const totalBytes = segs.reduce((s, x) => s + x.bytes, 0);
  const totalDur = segs.reduce((s, x) => s + x.dur, 0);
  const avg = Math.round((totalBytes * 8) / totalDur);
  const peak = Math.round(Math.max(...segs.map((x) => (x.bytes * 8) / x.dur)));
  const codecs = probeInfo.hasAudio ? `avc1.${r.avc},mp4a.40.2` : `avc1.${r.avc}`;
  return { name: r.name, width, height: r.height, bandwidth: Math.max(peak, avg), avgBandwidth: avg, codecs, fps: Math.round(probeInfo.fps) };
}

export function masterPlaylist(renditions) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of [...renditions].sort((a, b) => b.height - a.height)) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.avgBandwidth},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}",FRAME-RATE=${r.fps}`);
    lines.push(`${r.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

/** Three candidate thumbnails taken from the video itself at 10%, 40% and 70%. */
export async function makePosters({ input, demuxer, outDir, durationMs }) {
  const seconds = durationMs / 1000;
  const out = [];
  for (const [i, f] of [0.1, 0.4, 0.7].entries()) {
    const t = Math.max(0, Math.min(seconds - 0.2, seconds * f));
    const name = `thumb_${i}.jpg`;
    await run('ffmpeg', [...FFMPEG, '-y', '-ss', t.toFixed(2), '-f', demuxer, '-i', input, '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360', '-q:v', '4', path.join(outDir, name)], { timeoutMs: 60_000 });
    out.push({ name, ms: Math.round(t * 1000) });
  }
  return out;
}

/** A creator's own thumbnail: identified by its bytes, decoded and re-encoded (which also strips metadata). */
export async function processCustomThumbnail({ input, output }) {
  const kind = sniffImage(input);
  if (!kind) throw new Rejection('Use a JPEG, PNG or WebP image.');
  const named = `${input}.${kind}`;
  fs.renameSync(input, named);
  try {
    await run('ffmpeg', [...FFMPEG, '-y', '-f', 'image2', '-i', named, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-q:v', '3', output], { timeoutMs: 30_000 });
  } catch {
    throw new Rejection('We could not read that image.');
  } finally {
    fs.rmSync(named, { force: true });
  }
}

export function directorySize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? directorySize(p) : fs.statSync(p).size;
  }
  return total;
}
