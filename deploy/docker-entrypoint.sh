#!/bin/sh
# Container start: make the data folder belong to the "node" user, then run the command as "node", never as root.
# A freshly mounted volume (Railway, Docker) is owned by root, which the site could not write to.
set -eu
DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  # Only what is not already the app's, so a start with many videos stays quick.
  find "$DIR" ! -user node -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
