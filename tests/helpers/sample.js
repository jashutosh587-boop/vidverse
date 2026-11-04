import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidverse-samples-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Makes a real, tiny video with ffmpeg's test sources (a moving pattern and a tone) and returns its path.
 * Results are cached per parameter set.
 */
export function sampleVideo({ seconds = 6, width = 640, height = 360, container = 'mp4', audio = true, rotate = 0 } = {}) {
  const name = `s${seconds}-${width}x${height}-${audio ? 'a' : 'n'}-${rotate}.${container}`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=25:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', container === 'webm' ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p');
  if (container !== 'webm') args.push('-preset', 'ultrafast');
  if (audio) args.push('-c:a', container === 'webm' ? 'libopus' : 'aac', '-shortest');
  if (rotate) args.push('-metadata:s:v', `rotate=${rotate}`);
  args.push(file);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not make sample video: ${r.stderr}`);
  return file;
}

export const sampleBytes = (opts) => fs.readFileSync(sampleVideo(opts));
