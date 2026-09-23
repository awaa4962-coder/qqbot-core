# QQFriend Linux deployment

This deployment is isolated from the Windows installation. It creates fresh Linux state and never copies API keys, QQ login data, chat history, or user memory automatically.

As of 2026-09-07, Linux is the primary update target and the installed Windows
bot is frozen. See [ROADMAP.md](ROADMAP.md) for the staged work.

The browser console's Diagnostics page now includes recent message traces and
synthetic conversation replay. Traces contain metadata only, remain in memory
for at most 24 hours / 300 records, and reset on restart. Replay candidates,
pinned baselines and fixed-choice reviews live under
`$QQBOT_DATA_DIR/.qqfriend/diagnostics/replay.json`, never in a release bundle.
`npm run replay:check` is offline. Generating a selected candidate explicitly
calls the configured group model (with fallback), but never sends to QQ.

### Chat Delivery Metadata (1.4.18)

Numbered ordinary chat events use `$QQBOT_DATA_DIR/.qqfriend/chat-delivery.json`
for atomic, fsynced metadata. It stores salted event keys and counters, not message
bodies or plaintext account IDs. Run a single Bridge writer against this file.
Missing event IDs retain the legacy nonpersistent behavior; they are not covered
by restart deduplication. This is not a business-command outbox or exactly-once QQ delivery.
Coverage starts when the upgraded runtime claims an event; it does not backfill
delivery acknowledgements for replies sent by older versions.

The Diagnostics page can filter and mark an unknown, partial or interrupted reply
as manually checked. This never resends a message, removes its duplicate fence or
reconstructs conversation history. Resolved/terminal rows expire after roughly
24 hours (hourly cleanup); unresolved rows stay until checked. The 10000-row cap
and unreadable/corrupt state stop ordinary chats rather than discarding evidence.
Known commands retain their existing permission checks and remain independent of
this file. Forgetting a user removes their actor/scope indexes, while retaining
negative event keys to reject replayed messages.

On the first upgrade from a version without this journal, automatic rollback to
that older sender is safe only before the new release has accepted any journaled
chat events. If new records exist, stop the failing Bridge and keep NapCat running;
preserve the journal and repair forward or prepare a compatible rollback. Do not
blindly start an older sender or restore an old data backup over new records.

Receipt rules follow the [OneBot 11 HTTP response specification](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md):
async acceptance is not completed delivery. Contradictory fields and HTTP failures
remain unknown; only a definite rejection is eligible for existing bounded retries.

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

Since 1.4.11, both HTTP event posts and reverse WebSocket connections must send
`Authorization: Bearer <token>`. Set the same existing token in all three NapCat
connections above; query-string tokens are not accepted. `/reply` and
`/inspect_msg` require the management token. Health/readiness remain available
through the host loopback port. Do not expose these ports publicly.

The console shows saved values separately from effective startup configuration.
Restart Bridge to apply sidecar changes; environment-owned fields must instead
be changed in the private deployment environment. Invalid API configuration is
reported as degraded and stops model calls rather than selecting default routes.
Restore a known-good private configuration before resuming model traffic.

Compose bounds each container's stdout log to three 10 MB files. This takes
effect when that container is recreated, not when its source files change.
Recreate NapCat separately during a login-safe maintenance window if it still
has the old logging configuration. Never delete login state to rotate logs.

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
  -t qqfriend-bridge:1.4.9-security-patch ../..
```

Use this only when `package-lock.json` and `scripts/requirements-jm.txt` have no
dependency changes. A normal clean build remains the release baseline.

All image recipes run `npm run check:dependencies` (via its Node script) to
verify the installed sharp version against the lock and reject vulnerable
sharp/libheif versions. An overlay does not install dependencies: for the
1.4.9 security update, rebuild with `Dockerfile`, not an old 1.4.8 base overlay.
After switching releases, run `docker compose exec -T bridge npm run check:dependencies`
to verify the running container, not just the source package version.
The patched baseline is sharp 0.35.4 with libheif 1.23.2; development-only
js-yaml is locked to 4.3.2 and remains omitted from the production image.
CI also runs `npm audit --audit-level=high`; the local version floor is not a
substitute for checking newly published advisories.

If Docker Hub cannot be reached but the npm registry is available, an accepted
local Bridge image can supply the unchanged OS/Python runtime while **all**
production npm dependencies are reinstalled from the new lock:

```bash
docker build --pull=false \
  --build-arg BASE_IMAGE=qqfriend-bridge:1.4.8-member-summary-a218154 \
  -f Dockerfile.dependencies \
  -t qqfriend-bridge:1.4.9-security-patch ../..
```

This is not the offline source overlay. It runs `npm ci`, rechecks bundled
7-Zip permissions, and verifies the loaded sharp/libheif versions. Use it only
when the selected base was already accepted and OS/Python dependencies are
unchanged; it does not patch the base OS or Python. Validate the candidate image
before replacing the running Bridge, and retain its previous image for rollback.

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

The Linux browser now includes an editable [summary workbench](SUMMARY-WORKBENCH.md).
Keep `state/qqfriend/logs/summary-state` in update backups together with configuration
and data; these delivery markers prevent duplicate automatic reports after updates.

Do not overwrite a working installation in place. Build the new Bridge image first, run `npm run release:check`, back up `state/`, and only then recreate the Bridge container. NapCat QQ data and configuration live in bind mounts and survive container replacement.

```bash
docker compose build bridge
docker compose up -d --no-deps bridge
docker compose ps
```

Before restoring an older image, stop Bridge, confirm it exited and check data compatibility without changing the data. From `1.4.24-memory-state`, existing memory items may contain `recordType`, `status` and `eventAt`; the `1.4.23` editor can read but silently discard these fields when writing. If any current item contains these fields, or the configured memory file is missing, malformed or cannot be checked reliably, do not start that older writer. Keep Bridge stopped with all current state preserved until a compatible fix is ready. Never restore an old state backup over newer records. With compatible state, restore only the previous source/image and recreate Bridge; the older release is not feature-equivalent. Never run two NapCat instances with the same QQ account at the same time.
