# qqfriend / qqbot_core

NapCat OneBot v11 bridge for the 夜星 QQ bot.

## Commands

On Windows PowerShell, use `npm.cmd` to avoid `npm.ps1` execution policy issues.

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run check:runtime
npm.cmd start
```

## Startup

The bridge entry point is:

```powershell
npm.cmd start
```

For the full local QQ stack, use:

```powershell
.\start_bridge.bat
```

`start_bridge.bat` starts NapCat first, waits for OneBot on `127.0.0.1:6700`, then starts `napcat_bridge.mjs`.

## Health Check

The bridge listens on port `16789`.

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:16789/health
```

Expected JSON includes:

```json
{
  "status": "ok"
}
```

If the port is already in use, do not start a second bridge process. Check the existing `/health` response first.

## Runtime Diagnostics

Run:

```powershell
npm.cmd run check:runtime
```

`check:runtime` is a local deployment check, not a pure CI check. It expects real
`.env_mimo` and `.env_ds` files on the deployed machine. A clean release archive
must not include real `.env` files, so this command may fail in a freshly
unpacked package until local secrets are created.

For CI or source-only package checks, use:

```powershell
npm.cmd run check:runtime:ci
```

This allows missing `.env_mimo` and `.env_ds` while still checking the auth
header builder, proxy visibility, and health endpoint when reachable.

This checks:

- `.env_mimo` exists and is non-empty
- `.env_ds` exists and is non-empty
- Authorization headers are generated as `Bearer <raw key>`
- real Authorization values do not contain `****`
- proxy variables are visible
- `/health` is reachable when the bridge is running

The script must not print real API keys and must not call real model APIs.

## 401 Troubleshooting

`401` means authentication failed. Check these first:

- `.env_mimo` and `.env_ds` exist
- keys are not empty
- request headers are exactly `Authorization: Bearer ${apiKey}`
- masked values such as `****` never enter real request headers

Other common classes:

- `403`: permission, account policy, or provider-side rejection
- `429`: rate limit or quota
- `5xx`: provider-side failure
- `ENOTFOUND`: DNS issue
- `ETIMEDOUT`: network timeout
- `ECONNRESET`: connection reset
- `fetch failed`: network, proxy, TLS, or runtime fetch failure

## Proxy Check

```powershell
echo $env:HTTP_PROXY
echo $env:HTTPS_PROXY
echo $env:ALL_PROXY
```

The runtime check also reports whether these variables are set.

## Test Rules

Tests must not:

- connect to real NapCat
- call real DeepSeek, MiMo, MiniMax, Tavily, or other external APIs
- use real keys
- delete assertions to pass

Use mocks for all external boundaries.

## Relationship Surface

v1.2.1-relationship enables self-check relationship summaries for relationship
commands. Relationship table export remains reserved.

v1.2.4-command-profile adds user-controlled personalization commands. These
commands store structured preferences and summaries only; they do not expose raw
chat text or private-chat content in groups.

v1.2.5-cognition-core adds bounded short-term conversation threads. Group turns
are isolated by user and group and expire after 90 minutes. Private turns remain
in process memory only and expire after six hours. A completed turn is recorded
only after NapCat confirms that the reply was sent. Context assembly applies a
hard budget and keeps direct quotes, mentions, explicit preferences and the active
thread ahead of older background. The current message is never re-added as history.

v1.2.6-context-aware gives passive text and image replies a small, same-group
context window. Vision produces an objective description first, then MiMo decides
what a meme means in the current conversation. DeepSeek can reuse that description
after a MiMo chat failure. Similar images reuse a non-reversible perceptual
fingerprint cache; image files and raw group text are never stored in that cache or
included in release packages.

v1.2.7-meme-governance replaces substring-heavy meme learning with a guarded
v2 pipeline. Automatic candidates require frequency, distinct-user and
distinct-context evidence plus semantic verification, and they remain scoped to
their source groups. Deletes create tombstones, local edits survive dictionary
sync, legacy raw evidence is hashed during migration, and corrupt stores recover
from a last-good snapshot. The console exposes aggregate evidence and
quarantine controls without exposing QQ numbers or chat samples. Run
`npm run meme:audit -- --strict` for an aggregate-only historical replay.

v1.3.3-meme-web-update supersedes that automatic-candidate path with a v3 store.
Unknown group messages never create meme entries or candidates. Scheduled updates
collect public trends, require independent multi-domain web evidence that actually
mentions the candidate, then ask MiMo to structure only the supplied evidence and
cite the supporting evidence indexes; DeepSeek remains the request/parse fallback.
Source failures leave the store unchanged. Web entries retain only cited source
links and expire to `stale`, while manually protected fields survive later updates.
The local console can edit entries and group scope, research one term, protect
selected fields, restore edit history, and roll back the latest web batch. Neither
raw group text nor QQ identifiers are stored by this pipeline.

## Bot Commands

Group chat commands must mention the bot. Plain group messages such as `help`,
`状态`, or `测试` do not trigger commands unless the bot is mentioned.

Capability discovery is generated from the shared catalog:

- `@夜星 帮助` / `@夜星 你能干嘛` opens the six-category capability center.
- `@夜星 帮助 1` through `@夜星 帮助 6` opens a category.
- `@夜星 帮助 JM` / `@夜星 JM怎么用` / `@夜星 能识图吗` looks up a specific capability.
- Availability reflects the current group or private whitelist, configured dependencies and runtime mode without exposing identifiers or keys.

User commands:

- `@夜星 help` / `@夜星 帮助`
- `@夜星 status` / `@夜星 状态`
- `@夜星 ping` / `@夜星 测试`
- `@夜星 version` / `@夜星 版本`
- `@夜星 更新` / `@夜星 更新日志` / `@夜星 changelog`
- `@夜星 更新列表` / `@夜星 更新 v1.2.3` / `@夜星 更新 jm`
- `@夜星 好感度` / `@夜星 关系` / `@夜星 熟悉度` / `@夜星 my-status`
- `@夜星 我的档案` / `@夜星 隐私` / `@夜星 忘记我`
- `@夜星 设置称呼 <名字>`
- `@夜星 回复风格 简短 技术 少吐槽 给步骤`
- `@夜星 回复风格 帮助` / `@夜星 回复风格 推荐` / `@夜星 回复风格 预览` / `@夜星 回复风格 重置`

Private chat commands can omit the mention:

- `help` / `帮助`
- `status` / `状态`
- `ping` / `测试`
- `version` / `版本`
- `更新` / `更新日志` / `changelog`
- `更新列表` / `更新 v1.2.3` / `更新 jm`
- `好感度` / `关系` / `熟悉度` / `my-status`
- `我的档案` / `隐私` / `忘记我`
- `设置称呼 <名字>`
- `回复风格 简短 技术 少吐槽 给步骤`

Admin commands require `QQBOT_ADMINS` or `.env_admins`:

- `@夜星 admin help` / `@夜星 管理帮助`
- `@夜星 runtime` / `@夜星 运行状态`

In private chat, admins can omit `@夜星`.

Admin config:

```powershell
$env:QQBOT_ADMINS="123456789,987654321"
```

Or create `.env_admins` with one or more QQ numbers separated by commas,
semicolons, spaces, or newlines.

Relationship commands return a self-check summary for the current user:

```text
你和我的互动状态：
熟悉度：...
```

They calculate the summary from existing interaction data only. They do not
output raw chat text, expose keys, or export relationship tables.

User relationship aliases:

- `关系`
- `好感度`
- `熟悉度`
- `my-status`

Reserved admin export commands:

- `/export-relationships`
- `/export-relationships csv`
- `/export-relationships json`
- `/export-relationships md`

Current boundaries:

- no real relationship export is generated
- no files are written by the reserved exporters
- `/export-relationships` remains reserved only
- ordinary users cannot inspect other users' relationship scores
- cross-group privacy is not exposed
- "好感度" means interaction familiarity, not a romantic signal
- evidence text and full chat history are not exported
- `我的档案` shows summaries and preferences only, not raw chat text
- `回复风格` affects wording only and cannot override safety rules
- `忘记我` clears user profiles, preferences, relationship comment caches, and personal memory; old group-log text for that user is replaced with a cleanup placeholder

## JM Runtime

JM download uses the Python `jmcomic` runtime. It no longer depends on a Windows
Temp source checkout by default.

- `QQBOT_JMCOMIC_SRC` is optional. Use it only for a stable, complete source tree such as `runtime_deps\jmcomic\src`.
- If `QQBOT_JMCOMIC_SRC` is missing or incomplete, the downloader falls back to the installed `jmcomic` package when available.
- `QQBOT_JM_AUTO_INSTALL=1` lets the downloader install `jmcomic` and Python dependencies when they are missing.
- `QQBOT_JM_DOMAINS` is optional. When empty, `jmcomic` uses its built-in API domain list and auto-update logic. When set, comma-separated domains are passed to the API client.
- `QQBOT_JM_ZIP_PASSWORD` defaults to `FS`.
- `QQBOT_JM_USERS` or `.env_jm_users` controls which private QQ users can run `jm <code>` in private chat.
- Temporary downloaded files remain in `%TEMP%\qqfriend-jm-*` for about 1 day after upload.

Check the runtime:

```powershell
npm.cmd run check:jm
```

Allow dependency installation during the check:

```powershell
npm.cmd run check:jm:install
```

## API Quick Swap

The Windows console includes an `API` page for model-provider presets and task
routing. The current defaults remain MiMo as primary and DeepSeek as fallback.

Supported protocol families:

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- Gemini native `generateContent`

The route table separates group chat, interjections, private chat, file chat,
group summaries, relationship comments, vision, profiles, and search summaries.
Each task has a primary and fallback slot.

Provider metadata is stored in `.qqfriend/api-providers.json`. API keys are
stored separately in `.env_api_<provider-id>` and are not returned by the admin
API. Legacy `.env_mimo` and `.env_ds` remain supported for the built-in defaults.
Saving a configuration keeps `.qqfriend/api-providers.previous.json` for the
console rollback action.

For an unknown service, start from one of the generic presets and identify:

1. the request path and protocol family
2. the model ID
3. the authentication header
4. whether image input or tool calls are supported

Public endpoints must use HTTPS. Localhost models such as Ollama, LM Studio, or
vLLM require the explicit local-connection option. Provider connection tests use
a minimal prompt and still pass through the output-safety pipeline.

## Favorite Sticker Replies

QQ favorite stickers are handled by the isolated `bridge/features/stickers/`
module. NapCat supplies the favorite list; QQFriend stores only remote references,
perceptual hashes, short descriptions, and tags. It does not keep image files.

The reply order is fixed: send the normal text first, then optionally select and
send one sticker. A sticker failure cannot cancel or replace the text reply.
Selection uses local semantic recall before the small `sticker_select` model task,
whose fallback remains DeepSeek.

Use the launcher's `表情` page to synchronize favorites, analyze pending items,
edit tags, disable individual items, configure group scope/probability/cooldown,
and simulate a selection without sending it to QQ. Runtime catalog data under
`.qqfriend/stickers/` and all `.env_sticker_groups` files are excluded from
release archives.

NapCat `v4.18.13` also enables optional group-sticker capture. Capture is
allowlist-only and defaults to `observe`: incoming group images are safely
downloaded, classified, perceptually deduplicated, and counted without keeping
the image file. Set the capture mode to `auto` in the launcher's `表情` page to
promote high-confidence or independently reused candidates into QQ cloud
favorites. Daily/catalog limits and confidence/distinct-sender thresholds are
configurable there. Sender QQ numbers are converted to salted pseudonymous digests
for duplicate counting; this is not an anonymity guarantee.
the admin API does not return those hashes. Upload temporary files are deleted
in a `finally` path, and stale leftovers are cleaned on startup.

NapCat is discovered from `QQBOT_NAPCAT_EXE`, `.env_napcat_exe`, or the highest
`NapCat.vX.Y.Z.Shell` directory. The original `NapCat.44498.Shell` remains a
rollback target.

## Packaging

Before packaging:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run check:runtime:ci
npm.cmd run check:jm
```

Run `npm.cmd run check:runtime` on the deployment machine after creating real
`.env_mimo` and `.env_ds`.

Create a checked release from the project root with only source, tests, CI, scripts, and public config examples. The release plugin runs lint, tests, runtime CI checks, safety scans, zip path checks, manifest generation, and sha256 generation. Do not package `.env*`, `.env_admins`, `node_modules`, logs, chat memory, generated `.docx`, or NapCat runtime data.

Example:

```powershell
npm.cmd run release
```

Verify the archive:

```powershell
tar -tf dist\qqfriend_*.zip
```

The archive should preserve directories such as `bridge/`, `test/`, `.github/`, and `scripts/`. Release metadata is written to `dist/release-manifest.json`, `dist/release-file-list.txt`, and `dist/release-sha256.txt`. The old `npm.cmd run package:release` command is kept as a compatibility alias.
