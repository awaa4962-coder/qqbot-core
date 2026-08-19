#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BEGIN_MARKER="# BEGIN QQFRIEND DAILY SUMMARY"
END_MARKER="# END QQFRIEND DAILY SUMMARY"
LOG_FILE="$ROOT/state/qqfriend/logs/summary-cron.log"
LOCK_FILE="$ROOT/state/qqfriend/logs/summary-cron.lock"

fail() {
  printf '[summary-schedule] %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v crontab >/dev/null 2>&1 || fail "crontab is not installed"
command -v flock >/dev/null 2>&1 || fail "flock is not installed"
[[ -f "$ROOT/compose.yaml" ]] || fail "compose.yaml is missing"
[[ -f "$ROOT/.env" ]] || fail "run prepare.sh before installing the schedule"
[[ -f "$ROOT/qqfriend.env" ]] || fail "qqfriend.env is missing"
[[ "$ROOT" != *[[:space:]]* ]] || fail "deployment path must not contain whitespace"
[[ "$(timedatectl show -p Timezone --value 2>/dev/null || true)" = "Asia/Shanghai" ]] \
  || fail "host timezone must be Asia/Shanghai"
systemctl is-active cron >/dev/null 2>&1 || fail "cron service is not active"

mkdir -p "$ROOT/state/qqfriend/logs"
current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | awk \
  -v begin="$BEGIN_MARKER" \
  -v end="$END_MARKER" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ')"

job="5 0 * * * /usr/bin/flock -n $LOCK_FILE /usr/bin/docker compose --project-directory $ROOT --env-file $ROOT/.env -f $ROOT/compose.yaml run --rm --no-deps -T bridge node daily_summary.mjs >> $LOG_FILE 2>&1"
{
  if [[ -n "${cleaned//[[:space:]]/}" ]]; then
    printf '%s\n' "$cleaned"
  fi
  printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$job" "$END_MARKER"
} | crontab -

# Disable the short-lived user-systemd preview if it was installed by an older Linux preview.
systemctl --user disable --now qqfriend-compose-summary.timer >/dev/null 2>&1 || true

printf '[summary-schedule] installed for 00:05 Asia/Shanghai\n'
crontab -l | sed -n "/^${BEGIN_MARKER}$/,/^${END_MARKER}$/p"
