#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SOURCE="$ROOT/systemd-user"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qqfriend"

fail() {
  printf '[summary-timer] %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v systemctl >/dev/null 2>&1 || fail "systemd is not available"
[[ -f "$ROOT/compose.yaml" ]] || fail "compose.yaml is missing"
[[ -f "$ROOT/.env" ]] || fail "run prepare.sh before installing the timer"
[[ -f "$ROOT/qqfriend.env" ]] || fail "qqfriend.env is missing"
[[ "$ROOT" != *[[:space:]]* ]] || fail "deployment path must not contain whitespace"

install -d -m 700 "$UNIT_DIR" "$CONFIG_DIR"
install -m 644 \
  "$UNIT_SOURCE/qqfriend-compose-summary.service" \
  "$UNIT_SOURCE/qqfriend-compose-summary.timer" \
  "$UNIT_DIR/"

umask 077
printf '%s\n' \
  "QQFRIEND_COMPOSE_DIR=$ROOT" \
  "QQFRIEND_ENV_FILE=$ROOT/.env" \
  "QQFRIEND_COMPOSE_FILE=$ROOT/compose.yaml" \
  > "$CONFIG_DIR/summary.env"

systemctl --user daemon-reload
systemctl --user enable --now qqfriend-compose-summary.timer

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  printf '[summary-timer] warning: enable user lingering for reboot persistence: sudo loginctl enable-linger %s\n' "$USER" >&2
fi

systemctl --user list-timers qqfriend-compose-summary.timer --no-pager
