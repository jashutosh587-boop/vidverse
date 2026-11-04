# Builds Vidverse with ffmpeg. Used by Railway (see railway.json) and by docker-compose.yml.
# There is deliberately no VOLUME line: Railway refuses images that declare one. Mount storage at /data instead
# (a Railway volume, or the compose "media" volume).
FROM node:22-bookworm-slim

# ffmpeg and ffprobe turn uploads into streamable video, check catalog files and make thumbnails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && command -v setpriv

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY content ./content
COPY scripts ./scripts
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

# Starts as root only long enough to give /data to the "node" user (mounted volumes arrive owned by root), then
# runs the site as "node".
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
