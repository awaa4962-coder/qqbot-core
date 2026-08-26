# QQFriend Linux deployment

This deployment is isolated from the Windows installation. It creates fresh Linux state and never copies API keys, QQ login data, chat history, or user memory automatically.

## Recommended layout

- `qqfriend-bridge`: Node.js bridge and browser console.
- `qqfriend-napcat`: official NapCat Docker image pinned to `v4.18.13`.
- Bridge and NapCat use an isolated Docker network. Published host ports stay on loopback.
- Remote administration uses an SSH tunnel instead of public ports.
- Cross-container files use NapCat `upload_file_stream`; local Bridge paths are never passed directly to NapCat.

## Docker Compose

Requirements: Linux x86_64/arm64, Docker Engine, Docker Compose v2, and enough free disk for the NapCat image and persistent QQ data.

On a fresh supported Ubuntu host, install Docker Engine from Docker's official
APT repository, then reconnect so the new `docker` group membership applies:

```bash
sudo ./install-docker-host.sh
```

```bash
cd deploy/linux
chmod +x install-docker-host.sh install-time-order.sh prepare.sh install-summary-schedule.sh check.sh
sudo ./install-time-order.sh
./prepare.sh
```

Fill these files under `state/qqfriend/config`:

```text
.env_mimo
.env_ds
.env_tavily
.env_doubao
```

`prepare.sh` also creates `state/napcat/config/webui.json` before NapCat can start. The WebUI listens inside the isolated container network, while Compose publishes it only on host `127.0.0.1`. Keep its generated token private and use it when signing in.

Set allowlists and the bot QQ number in `qqfriend.env`. Then open NapCat WebUI at `http://127.0.0.1:6099/webui` through an SSH tunnel and configure:

```text
HTTP server:           0.0.0.0:6700
Forward WebSocket:     0.0.0.0:3001
Reverse WebSocket:     ws://bridge:16789
Access token:          state/qqfriend/config/.env_napcat_token
```

After the first QR-code login, set `NAPCAT_ACCOUNT` in `deploy/linux/.env` to
the logged-in QQ number. Subsequent container restarts will then use NapCat's
persisted quick-login state instead of requesting a new QR code.

For unattended recovery when the persisted login state expires, set exactly one
of `NAPCAT_QUICK_PASSWORD` or `NAPCAT_QUICK_PASSWORD_MD5` in the same private
`.env` file. Prefer the 32-character MD5 form so the plaintext QQ password is not
stored on the server. Treat either form as a login credential, keep `.env` mode
`0600`, and never commit or include it in a release bundle. Password fallback
may still require interactive device verification when QQ marks the server as a
new device.

Start and verify:

```bash
docker compose --env-file .env up -d --build
./install-summary-schedule.sh
./check.sh --runtime
docker compose logs -f --tail=100
```

`install-summary-schedule.sh` installs an idempotent user crontab entry that
runs the containerized `daily_summary.mjs` at 00:05 Asia/Shanghai. It does not
require a host Node.js installation or root. `flock` prevents overlapping
containers, while the existing per-group send guard prevents duplicate reports.
The installer requires the host timezone to be `Asia/Shanghai` and keeps any
unrelated user crontab entries intact.

If Docker Hub is unavailable but GitHub is reachable, run the repository's
`Publish Linux image bundle` workflow. Download the release bundle and its
SHA-256 file, verify it with `sha256sum -c`, load it with `docker load`, and
start Compose with `--no-build`. The bundle pins the official NapCat amd64
manifest and builds the Bridge from the workflow commit.

If Python dependency downloads are unusually slow, set `PIP_INDEX_URL` in
`deploy/linux/.env` to a trusted mirror before building. This affects only the
image build and is not passed to the running bot.

If Docker Hub metadata is temporarily unavailable and a previously accepted
`qqfriend-bridge` image with the same dependency lock is already local, update
only the application layer without network access:

```bash
docker build --pull=false \
  --build-arg BASE_IMAGE=qqfriend-bridge:linux-preview \
  -f Dockerfile.overlay \
  -t qqfriend-bridge:1.4.3-prompt-cache ../..
```

Use this only when `package-lock.json` and `scripts/requirements-jm.txt` have no
dependency changes. A normal clean build remains the release baseline.

From a workstation, create tunnels without exposing either console:

```bash
ssh -L 16789:127.0.0.1:16789 -L 6099:127.0.0.1:6099 miku-server
```

Then visit `http://127.0.0.1:16789/console/` and `http://127.0.0.1:6099/webui` locally.

`/health` is process liveness. `/ready` additionally requires a healthy OneBot WebSocket heartbeat and available inbound queue capacity.

## Native Bridge with systemd

The units under `systemd/` are for a native Node.js Bridge while NapCat remains Docker-managed. Install Node.js 22, Python 3, create a `qqfriend` system user, place the source in `/opt/qqfriend`, the Python virtual environment in `/opt/qqfriend-venv`, and configuration in `/etc/qqfriend`.

```bash
sudo install -m 644 systemd/qqfriend.service /etc/systemd/system/
sudo install -m 644 systemd/qqfriend-summary.service /etc/systemd/system/
sudo install -m 644 systemd/qqfriend-summary.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qqfriend.service qqfriend-summary.timer
```

## Update and rollback

Do not overwrite a working installation in place. Build the new Bridge image first, run `npm run release:check`, back up `state/`, and only then recreate the Bridge container. NapCat QQ data and configuration live in bind mounts and survive container replacement.

```bash
docker compose build bridge
docker compose up -d --no-deps bridge
docker compose ps
```

Rollback by restoring the previous source tag or image tag and recreating only the Bridge container. Never run two NapCat instances with the same QQ account at the same time.
