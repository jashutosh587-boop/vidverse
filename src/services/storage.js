import fs from 'node:fs';
import path from 'node:path';
import { isVideoId } from '../lib/ids.js';

/**
 * Local-disk storage for uploads and processed video.
 *
 *   <dataDir>/media/incoming/<id>.upload     raw upload, deleted after processing; never served
 *   <dataDir>/media/v/<id>/...               HLS playlists, segments and thumbnails (served through access checks)
 *
 * Only server-generated video ids ever become path segments, and every lookup is re-checked to stay
 * inside its directory. An object-store adapter (S3, R2) would implement the same few methods.
 */
export function createStorage(config) {
  const root = path.join(config.dataDir, 'media');
  const incomingDir = path.join(root, 'incoming');
  const videosDir = path.join(root, 'v');
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });

  const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

  return {
    root,
    incomingPath(id) {
      if (!isVideoId(id)) throw new Error('bad video id');
      return path.join(incomingDir, `${id}.upload`);
    },
    videoDir(id) {
      if (!isVideoId(id)) throw new Error('bad video id');
      return path.join(videosDir, id);
    },
    ensureVideoDir(id) {
      const dir = this.videoDir(id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** Absolute path of a file inside a video's directory, or null if the request tries to leave it. */
    resolve(id, ...parts) {
      if (!isVideoId(id)) return null;
      if (!parts.every((p) => SAFE_NAME.test(p) && p !== '.' && p !== '..')) return null;
      const dir = this.videoDir(id);
      const full = path.resolve(dir, ...parts);
      return full.startsWith(dir + path.sep) ? full : null;
    },
    removeVideo(id) {
      fs.rmSync(this.videoDir(id), { recursive: true, force: true });
      fs.rmSync(this.incomingPath(id), { force: true });
    },
    removeIncoming(id) {
      fs.rmSync(this.incomingPath(id), { force: true });
    },
    exists: (p) => fs.existsSync(p),
  };
}
