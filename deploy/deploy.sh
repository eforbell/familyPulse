#!/usr/bin/env bash
# deploy.sh — smart git-based deploy for familyPulse
# Usage:
#   ./deploy.sh                   # deploy origin/main
#   ./deploy.sh feat/my-branch    # deploy a specific branch
#   ./deploy.sh --restore-stash   # restore last auto-stashed local changes
#   FORCE_DEPLOY=1 ./deploy.sh    # skip dirty-check (not recommended)
# Env:
#   AUTO_STASH=1                  # default; auto-stash dirty tree before deploy
#   AUTO_STASH=0                  # fail instead of auto-stashing

set -euo pipefail

APP_DIR="/data/apps/familyPulse"
SERVICE="family-pulse"
NOTIFICATION_TIMER="family-pulse-notifications.timer"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REF="${1:-origin/main}"

if [[ -d "$APP_DIR/.git" ]]; then
  GIT_CMD=(git -C "$APP_DIR")
  STASH_REF_FILE="$APP_DIR/.deploy-last-stash-ref"
  MODE="repo"
else
  GIT_CMD=(git --git-dir="$REPO_DIR/.git" --work-tree="$APP_DIR")
  STASH_REF_FILE="$REPO_DIR/.deploy-last-stash-ref"
  MODE="worktree"
fi

restore_stash() {
  local stash_ref="${1:-}"
  if [[ -z "$stash_ref" ]]; then
    if [[ -f "$STASH_REF_FILE" ]]; then
      stash_ref="$(cat "$STASH_REF_FILE")"
    else
      echo "ERROR: No saved stash ref found."
      exit 1
    fi
  fi
  echo "==> Restoring stash: $stash_ref"
  "${GIT_CMD[@]}" stash pop "$stash_ref"
  rm -f "$STASH_REF_FILE"
  echo "==> Local changes restored."
}

if [[ "$REF" == "--restore-stash" ]]; then
  restore_stash "${2:-}"
  exit 0
fi

echo "==> familyPulse deploy: $REF"

AUTO_STASH="${AUTO_STASH:-1}"

# Warn/handle local changes in the deploy work tree
if [[ -z "${FORCE_DEPLOY:-}" ]]; then
  if [[ -n "$("${GIT_CMD[@]}" status --porcelain)" ]]; then
    if [[ "$AUTO_STASH" == "1" ]]; then
      stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      stash_msg="deploy:auto-stash:${stamp}:${REF}"
      echo "==> Local changes detected; auto-stashing before deploy"
      "${GIT_CMD[@]}" stash push --include-untracked -m "$stash_msg" >/dev/null
      stash_ref="$("${GIT_CMD[@]}" rev-parse -q --verify refs/stash || true)"
      if [[ -n "$stash_ref" ]]; then
        echo "$stash_ref" > "$STASH_REF_FILE"
        echo "==> Saved stash ref: $stash_ref"
        echo "==> Restore later with: ./deploy/deploy.sh --restore-stash"
      fi
    else
      echo "ERROR: Uncommitted local changes. Commit/stash first, or set AUTO_STASH=1."
      exit 1
    fi
  fi
fi

"${GIT_CMD[@]}" fetch origin --prune

TARGET="$REF"
if [[ "$REF" != origin/* ]] && "${GIT_CMD[@]}" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  TARGET="origin/$REF"
fi

echo "==> Updating work tree to $TARGET"
if [[ "$MODE" == "repo" ]]; then
  "${GIT_CMD[@]}" checkout -B deploy-current "$TARGET"
  "${GIT_CMD[@]}" reset --hard "$TARGET"
else
  "${GIT_CMD[@]}" checkout "$TARGET" -- .
fi

echo "==> Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev

echo "==> Running database migrations"
node db/migrate.js

echo "==> Installing systemd unit files"
sudo cp deploy/family-pulse.service /etc/systemd/system/
sudo cp deploy/family-pulse-notifications.service /etc/systemd/system/
sudo cp deploy/family-pulse-notifications.timer /etc/systemd/system/

echo "==> Reloading systemd units"
sudo systemctl daemon-reload

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sudo systemctl status  "$SERVICE" --no-pager -l

if sudo systemctl is-enabled "$NOTIFICATION_TIMER" >/dev/null 2>&1; then
  echo "==> Restarting $NOTIFICATION_TIMER"
  sudo systemctl restart "$NOTIFICATION_TIMER"
fi

echo "==> Done."
