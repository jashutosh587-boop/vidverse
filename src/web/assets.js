import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.js';

export const PUBLIC_DIR = path.join(ROOT, 'public');
const cache = new Map();

/** "/assets/css/app.css?v=ab12cd34": the version changes whenever the file's content does. */
export function assetUrl(name) {
  const file = name === 'vendor/hls.min.js' ? HLS_FILE : path.join(PUBLIC_DIR, name);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return `/assets/${name}`;
  }
  const hit = cache.get(name);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.url;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  const url = `/assets/${name}?v=${hash}`;
  cache.set(name, { mtime: st.mtimeMs, size: st.size, url });
  return url;
}

export const FONT_DIRS = {
  sans: path.join(ROOT, 'node_modules/@fontsource-variable/schibsted-grotesk/files'),
  mono: path.join(ROOT, 'node_modules/@fontsource-variable/jetbrains-mono/files'),
};
export const HLS_FILE = path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js');
