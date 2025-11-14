#!/usr/bin/env bash
set -euo pipefail

# Remote deployment configuration.
REMOTE_USER="codex-browser-bridge"
REMOTE_HOST="codex-browser-bridge.loltek.net"
DEST_PATH="/home/codex-browser-bridge/web/codex-browser-bridge.loltek.net/public_html"

# ROOT_DIR is the repository root; SOURCE_DIR is the tree we actually send to the server.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/server/src"

# Avoid syncing repository metadata and transient directories.
RSYNC_EXCLUDES=(
  "sessions/"
  "db.db3"
  "db.db3-journal"
)

EXCLUDE_FLAGS=()
for entry in "${RSYNC_EXCLUDES[@]}"; do
  EXCLUDE_FLAGS+=("--exclude=${entry}")
done

# Push only the server/src tree to the remote host while keeping runtime state intact.
rsync -avz --delete --info=progress2 "${EXCLUDE_FLAGS[@]}" "$SOURCE_DIR/" "${REMOTE_USER}@${REMOTE_HOST}:${DEST_PATH}"

# Ensure the SQLite database file exists on the deployment target so the new api2.php can immediately start writing messages.
REMOTE_DB_PATH="${DEST_PATH}/db.db3"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "touch '${REMOTE_DB_PATH}' && chmod 660 '${REMOTE_DB_PATH}' || true"
