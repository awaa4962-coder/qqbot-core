#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROP_IN_DIR="/etc/systemd/system/docker.service.d"
DROP_IN_FILE="$DROP_IN_DIR/10-qqfriend-chrony-wait.conf"

fail() {
  printf '[time-order] %s\n' "$1" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "run with sudo"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
systemctl cat chrony-wait.service >/dev/null 2>&1 || fail "chrony-wait.service is unavailable"

install -d -m 755 "$DROP_IN_DIR"
install -m 644 "$ROOT/systemd/docker-chrony-wait.conf" "$DROP_IN_FILE"
timedatectl set-local-rtc 0 --adjust-system-clock
systemctl enable chrony-wait.service >/dev/null
systemctl daemon-reload

if command -v chronyc >/dev/null 2>&1; then
  chronyc waitsync 60 0.1 >/dev/null 2>&1 || printf '[time-order] warning: clock is not synchronized yet\n' >&2
fi
if command -v hwclock >/dev/null 2>&1; then
  hwclock --systohc --utc >/dev/null 2>&1 || printf '[time-order] warning: could not update hardware clock\n' >&2
fi

printf '[time-order] Docker will wait for chrony-wait.service on the next boot.\n'
printf '[time-order] Installed %s\n' "$DROP_IN_FILE"
