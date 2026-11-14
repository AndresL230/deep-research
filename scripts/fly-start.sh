#!/bin/sh
# Start Orro in its container (Dockerfile). The server writes saved batches and uploads into folders at the repo root;
# here each of those folders is a link into the persistent volume at $DATA_DIR, so they survive restarts and deploys.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
APP_DIR="${APP_DIR:-/app}"

for dir in batches datasets user_scripts controllers runs; do
  mkdir -p "$DATA_DIR/$dir"
  # A folder baked into the image by mistake would hide the volume's: replace it with the link.
  if [ -e "$APP_DIR/$dir" ] && [ ! -L "$APP_DIR/$dir" ]; then rm -rf "${APP_DIR:?}/$dir"; fi
  ln -sfn "$DATA_DIR/$dir" "$APP_DIR/$dir"
done

cd "$APP_DIR"
exec uvicorn deep_research.api:app --host 0.0.0.0 --port "${PORT:-8080}" --proxy-headers --forwarded-allow-ips='*'
