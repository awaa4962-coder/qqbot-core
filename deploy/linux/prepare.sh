#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$ROOT/state/qqfriend/config"
NAPCAT_CONFIG_DIR="$ROOT/state/napcat/config"

random_hex() {
  local bytes="${1:-32}"
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

umask 077
install -d -m 700 \
  "$CONFIG_DIR" \
  "$ROOT/state/qqfriend/data" \
  "$ROOT/state/qqfriend/logs" \
  "$ROOT/state/qqfriend/temp" \
  "$NAPCAT_CONFIG_DIR" \
  "$ROOT/state/napcat/qq"

if [[ ! -f "$ROOT/qqfriend.env" ]]; then
  install -m 600 "$ROOT/qqfriend.env.example" "$ROOT/qqfriend.env"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  install -m 600 "$ROOT/.env.example" "$ROOT/.env"
  sed -i "s/^NAPCAT_UID=.*/NAPCAT_UID=$(id -u)/" "$ROOT/.env"
  sed -i "s/^NAPCAT_GID=.*/NAPCAT_GID=$(id -g)/" "$ROOT/.env"
fi

for key_file in .env_mimo .env_ds .env_tavily .env_doubao; do
  if [[ ! -f "$CONFIG_DIR/$key_file" ]]; then
    install -m 600 /dev/null "$CONFIG_DIR/$key_file"
  fi
done

if [[ ! -s "$CONFIG_DIR/.env_napcat_token" ]]; then
  random_hex 32 > "$CONFIG_DIR/.env_napcat_token"
  chmod 600 "$CONFIG_DIR/.env_napcat_token"
fi

if [[ ! -f "$NAPCAT_CONFIG_DIR/webui.json" ]]; then
  webui_token="$(random_hex 32)"
  cat > "$NAPCAT_CONFIG_DIR/webui.json" <<EOF
{
  "host": "127.0.0.1",
  "port": 6099,
  "prefix": "",
  "token": "$webui_token",
  "loginRate": 3,
  "accessControlMode": "none",
  "ipWhitelist": [],
  "ipBlacklist": [],
  "enableXForwardedFor": false
}
EOF
fi

if ! grep -q '^QQFRIEND_ADMIN_TOKEN=' "$ROOT/qqfriend.env"; then
  printf '\nQQFRIEND_ADMIN_TOKEN=%s\n' "$(random_hex 32)" >> "$ROOT/qqfriend.env"
fi

chmod 600 \
  "$ROOT/qqfriend.env" \
  "$ROOT/.env" \
  "$CONFIG_DIR"/.env_* \
  "$NAPCAT_CONFIG_DIR/webui.json"

cat <<EOF
QQFriend Linux state is ready.

Next:
  1. Fill the four model key files under:
     $CONFIG_DIR
  2. Set QQ allowlists in $ROOT/qqfriend.env or sibling files under the config directory.
  3. Configure NapCat HTTP 6700, forward WebSocket 3001, and reverse WebSocket:
     ws://127.0.0.1:16789
  4. Use the token stored in $CONFIG_DIR/.env_napcat_token for NapCat HTTP/WS auth.
  5. NapCat WebUI is pre-bound to 127.0.0.1; its token is stored in:
     $NAPCAT_CONFIG_DIR/webui.json
  6. Run: docker compose --env-file .env up -d --build
EOF
