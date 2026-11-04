# NOTE: this file has not been built or run in the environment where the project was written (no Docker there).
# Read it, build it once with `docker build -t vidverse .`, and fix anything your platform objects to.
FROM node:22-bookworm-slim

# ffmpeg and ffprobe turn uploads into streamable video.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY content ./content
COPY scripts ./scripts

# Run as an ordinary user. /data is where uploaded and processed videos are kept: mount a volume there.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/server.js"]
