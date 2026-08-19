#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

pass() { printf '[ok] %s\n' "$1"; }
fail() { printf '[fail] %s\n' "$1" >&2; FAILED=1; }

[[ "$(uname -s)" == "Linux" ]] && pass "Linux host" || fail "this deployment is Linux-only"
command -v docker >/dev/null 2>&1 && pass "Docker present" || fail "Docker is not installed"
docker compose version >/dev/null 2>&1 && pass "Docker Compose v2 present" || fail "docker compose is unavailable"
[[ -f "$ROOT/qqfriend.env" ]] && pass "qqfriend.env present" || fail "run ./prepare.sh first"
[[ -s "$ROOT/state/qqfriend/config/.env_napcat_token" ]] \
  && pass "NapCat token present" \
  || fail "NapCat token is missing"
[[ -s "$ROOT/state/napcat/config/webui.json" ]] \
  && pass "NapCat WebUI configuration present" \
  || fail "NapCat WebUI configuration is missing"

if [[ -f "$ROOT/state/napcat/config/webui.json" ]]; then
  grep -Eq '"host"[[:space:]]*:[[:space:]]*"127\.0\.0\.1"' "$ROOT/state/napcat/config/webui.json" \
    && pass "NapCat WebUI is loopback-only" \
    || fail "NapCat WebUI host must be 127.0.0.1"
  grep -Eq '"token"[[:space:]]*:[[:space:]]*"[^"]{16,}"' "$ROOT/state/napcat/config/webui.json" \
    && pass "NapCat WebUI token is non-default" \
    || fail "NapCat WebUI token is missing or too short"
fi

if [[ -f "$ROOT/qqfriend.env" ]]; then
  grep -q '^QQBOT_LISTEN_HOST=127\.0\.0\.1$' "$ROOT/qqfriend.env" \
    && pass "Bridge management endpoint is loopback-only" \
    || fail "QQBOT_LISTEN_HOST must be 127.0.0.1"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if docker compose --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" config --quiet; then
    pass "Compose configuration"
  else
    fail "Compose configuration is invalid"
  fi
fi

if [[ "${1:-}" == "--runtime" ]]; then
  if curl --fail --silent --max-time 5 http://127.0.0.1:16789/health >/dev/null; then
    pass "Bridge health endpoint"
  else
    fail "Bridge health endpoint is unavailable"
  fi
fi

exit "$FAILED"
