import fs from 'node:fs';
import path from 'node:path';
import { probe, chooseRenditions, encodeRendition, masterPlaylist, makePosters, directorySize, Rejection } from './transcoder.js';

/**
 * The "transcode" job: validate the upload, encode every rendition, cut thumbnails, write the master playlist,
 * and mark the video ready. A file that cannot be processed is rejected with a reason the creator can act on;
 * a crash or timeout is retried by the job queue (three attempts) before the video is marked failed.
 */
export function createPipeline(ctx) {
  const { config, storage, videos, notifications, log } = ctx;

  async function processVideo(videoId) {
    const video = await videos.get(videoId);
    if (!video || video.status !== 'processing') return; // deleted, removed or already done
    const input = storage.incomingPath(videoId);
    if (!fs.existsSync(input)) {
      await videos.markFailed(videoId, 'The uploaded file went missing. Please upload it again.');
      return;
    }
    let info;
    try {
      info = await probe(input, { maxSeconds: config.uploads.maxSeconds });
    } catch (e) {
      if (e instanceof Rejection) {
        storage.removeIncoming(videoId);
        await videos.markFailed(videoId, e.message);
        await notifications.create(video.owner_id, 'video_failed', { videoId, title: video.title, reason: e.message });
        return;
      }
      throw e;
    }

    const outDir = storage.ensureVideoDir(videoId);
    const renditions = [];
    for (const r of chooseRenditions(config.uploads.profile, info.height)) {
      renditions.push(await encodeRendition({ input, demuxer: info.demuxer, outDir, r, probeInfo: info, profile: config.uploads.profile }));
    }
    const posters = await makePosters({ input, demuxer: info.demuxer, outDir, durationMs: info.durationMs });
    fs.writeFileSync(path.join(outDir, 'master.m3u8'), masterPlaylist(renditions));

    await videos.markReady(videoId, {
      durationMs: info.durationMs,
      width: info.width,
      height: info.height,
      renditions,
      posters,
      thumbName: posters[1]?.name ?? posters[0].name,
      sizeBytes: directorySize(outDir),
    });
    storage.removeIncoming(videoId);
    await notifications.create(video.owner_id, 'video_ready', { videoId, title: video.title });
    log.info('video processed', { videoId, renditions: renditions.map((r) => r.name), durationMs: info.durationMs });
  }

  return {
    processVideo,
    register(jobs) {
      jobs.register('transcode', (payload) => processVideo(payload.videoId));
      // After the last retry fails, tell the creator instead of leaving the video "processing" forever.
      jobs.register('transcode:failed', async (payload, _job, err) => {
        await videos.markFailed(payload.videoId, 'Processing failed on our side after several tries. Please upload the video again.');
        const v = await videos.get(payload.videoId);
        if (v) await notifications.create(v.owner_id, 'video_failed', { videoId: v.id, title: v.title, reason: 'Processing failed on our side. Please upload again.' });
        log.error('transcode gave up', { videoId: payload.videoId, err });
      });
    },
  };
}
