#!/usr/bin/env bash
# stage-to-homebase.sh
#
# Stage an existing Family Pulse app directory into Homebase's managed layout
# before running Homebase install/reinstall.
#
# Default mode is dry-run (prints actions only).
# Use --execute to apply.
#
# Example:
#   ./deploy/stage-to-homebase.sh --execute --stop-service
#
set -euo pipefail

SOURCE_APP_DIR="/data/apps/familyPulse"
TARGET_APP_DIR="/opt/sovereign-home/apps/familyPulse"
SERVICE_NAME="family-pulse"
SERVICE_USER="sovereign"
SERVICE_GROUP="sovereign"
BACKUP_DIR="/var/backups/homebase-stage"
SYNC_REF=""
STOP_SERVICE=0
EXECUTE=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --execute                  Apply changes (default is dry-run)
  --source-app-dir <path>    Existing app directory (default: ${SOURCE_APP_DIR})
  --target-app-dir <path>    Homebase target app directory (default: ${TARGET_APP_DIR})
  --backup-dir <path>        Backup output directory (default: ${BACKUP_DIR})
  --service-name <name>      Systemd service name (default: ${SERVICE_NAME})
  --service-user <user>      Target ownership user (default: ${SERVICE_USER})
  --service-group <group>    Target ownership group (default: ${SERVICE_GROUP})
  --sync-ref <git-ref>       Sync source dir to this git ref before staging (optional)
  --stop-service             Stop service before staging (does not restart)
  -h, --help                 Show this help

Notes:
  - This script does NOT run Homebase install.
  - It stages files + .env + ownership so Homebase install dry-run/execute can follow.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --source-app-dir) SOURCE_APP_DIR="$2"; shift ;;
    --target-app-dir) TARGET_APP_DIR="$2"; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift ;;
    --service-name) SERVICE_NAME="$2"; shift ;;
    --service-user) SERVICE_USER="$2"; shift ;;
    --service-group) SERVICE_GROUP="$2"; shift ;;
    --sync-ref) SYNC_REF="$2"; shift ;;
    --stop-service) STOP_SERVICE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
  shift
done

run() {
  if [[ "$EXECUTE" -eq 1 ]]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

run_shell() {
  if [[ "$EXECUTE" -eq 1 ]]; then
    echo "+ $*"
    bash -lc "$*"
  else
    echo "[dry-run] $*"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

require_cmd rsync
require_cmd git
require_cmd tar
require_cmd date

if [[ ! -d "$SOURCE_APP_DIR" ]]; then
  echo "ERROR: source app dir missing: $SOURCE_APP_DIR" >&2
  exit 1
fi

if [[ -n "$SYNC_REF" ]]; then
  if [[ ! -d "$SOURCE_APP_DIR/.git" ]]; then
    echo "ERROR: --sync-ref requested but source dir is not a git repo: $SOURCE_APP_DIR" >&2
    exit 1
  fi
  run git -C "$SOURCE_APP_DIR" fetch origin --prune
  run git -C "$SOURCE_APP_DIR" checkout "$SYNC_REF"
  run git -C "$SOURCE_APP_DIR" reset --hard "$SYNC_REF"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
source_base="$(basename "$SOURCE_APP_DIR")"
target_base="$(basename "$TARGET_APP_DIR")"

run mkdir -p "$BACKUP_DIR"

if [[ -d "$TARGET_APP_DIR" ]]; then
  backup_target="$BACKUP_DIR/${target_base}-before-stage-${stamp}.tar.gz"
  run_shell "tar -C \"$(dirname "$TARGET_APP_DIR")\" -czf \"$backup_target\" \"$target_base\""
fi

backup_source="$BACKUP_DIR/${source_base}-source-snapshot-${stamp}.tar.gz"
run_shell "tar -C \"$(dirname "$SOURCE_APP_DIR")\" -czf \"$backup_source\" \"$source_base\""

if [[ "$STOP_SERVICE" -eq 1 ]]; then
  run sudo systemctl stop "$SERVICE_NAME"
fi

run mkdir -p "$TARGET_APP_DIR"

# Stage code/config files (exclude runtime-only dirs)
run rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.deploy-last-stash-ref' \
  "$SOURCE_APP_DIR/" "$TARGET_APP_DIR/"

# Keep founder env values in sync for first Homebase-managed reinstall
if [[ -f "$SOURCE_APP_DIR/.env" ]]; then
  run cp "$SOURCE_APP_DIR/.env" "$TARGET_APP_DIR/.env"
fi

run sudo chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$TARGET_APP_DIR"

cat <<NEXT

Stage complete (${EXECUTE:+executed}${EXECUTE:+' '}${EXECUTE:+mode}$( [[ "$EXECUTE" -eq 0 ]] && echo "dry-run" )).

Next recommended steps:
  1) Open Homebase -> Apps -> Family Pulse -> Deploy / Reinstall.
  2) Run dry-run first.
  3) Confirm planned git/db/env steps, then run execute.

Backups:
  $BACKUP_DIR

NEXT
