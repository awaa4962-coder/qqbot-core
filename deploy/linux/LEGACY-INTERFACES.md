# Legacy Interfaces: P5-03

Scope: the earlier cleanup below was inspected on 2026-09-28 against executable
`b85bd00` and documentation `6552950`. The remaining-interface inventory and
browser roots were rechecked against local source on 2026-10-01, without Git,
runtime configuration, private outputs or deployment access. The older commit
identifiers are historical evidence, not a verified identifier for this working
snapshot. This is a cleanup record, not release or whole-P5 acceptance. Windows
installation, runtime state and manual meme data are unchanged. The original
compatibility table in
[MODULAR-RUNTIME.md](MODULAR-RUNTIME.md)
was read before changing code.

P5-03 keeps its original scope: list remaining old interfaces and callers,
remove duplicate implementations with no consumers, and retain necessary thin
adapters and compatibility tests. The tables below cover those three duties;
they do not redefine P5-03 as "all unreachable files must be deleted". This
2026-10-01 follow-up edits only this record and
`test/p5-legacy-interfaces.test.mjs`, not any implementation or checklist.

## Evidence Classes

Paths are repository-relative. "Consumer" means a source import/reexport,
explicit command root, HTML script root, host action or route, not a name in a
catalog or a filename embedded in a test fixture string.

| Class | Actual starting point | What it proves / does not prove |
| --- | --- | --- |
| Linux Node entry | `napcat_bridge.mjs` (`start`, Docker CMD, systemd), `daily_summary.mjs` (`summary:daily`, summary systemd/cron), plus direct non-test/lint Node npm commands | Source reachability for Bot, scheduled jobs and operational commands; an audit/release command is not proof of a live chat call. No command is executed by the AST test. |
| Browser root | `launcher/QQFriendLauncher/Web/index.html` scripts, then their ES module imports; `bridge/web-console.mjs` is the asset whitelist | Browser consumers are independent of Node imports. Serving a JS file alone is not a consumer; a script tag/import path is needed. Classic `host-client.js` supplies the global host before modules. |
| Windows frozen external consumer | `launcher/QQFriendLauncher/App/LauncherForm.Home.cs` host-action switch and `launcher/QQFriendLauncher/Services/BridgeAdminClient.cs` request methods | Source evidence of a separate WebView/C# consumer contract. No installed EXE, deployed client version, Windows configuration or live connection was inspected. It is not a Linux Node graph edge. |
| Historical safety / compatibility test | Literal imports/reexports in `test/*.test.mjs`, traversed separately | Real regression dependencies, not production consumers. Test strings that generate other modules are not parsed as executable modules by this graph. Preserve tests or migrate their safety assertions before removal. |
| Retired archive / stopped interface | `bridge/knowledge/memes/archive.mjs`, retired commands and admin/task rejection handlers | Read-only projection or explicit retirement, not active dictionary learning, network update, scheduler or prompt injection. Manual archive data is never a deletion target. |

## Concrete Cleanup

| Removed implementation | Consumer evidence | Authority retained |
| --- | --- | --- |
| `mimoChat` in `bridge/clients/providers/mimo.mjs` | No named, namespace, literal dynamic import, command or source identifier consumer. `test/llm-client.test.mjs` imports only `mimoVision` from this file. | Current chat uses `model-mimo.mjs` / `model-router.mjs` and the task gateway. `mimoVision`, `deepseekChat`, `llmCall`, token-field tests, single-attempt transport and auth exports are untouched. |
| `bridge/features/stickers/manifest.mjs` / `STICKER_MODULE_MANIFEST` | No import, reexport, command, path or symbol reference outside its own declaration. No directory-based runtime manifest loader exists. | `bridge/modules/manifest.mjs` owns the single `stickers` declaration; module/plugin projections import that authority. Sticker entrypoints, data and behavior are untouched. |

No tests or lint rules were removed. The removed chat helper had no repository
consumer; untracked external integrations cannot be proven absent by a source
audit. No replacement endpoint, model route, reasoning mode or feature default
was introduced.

## Remaining Facades

Paths below are relative to the repository. Production consumers and historical
tests are intentionally listed separately. None of these facades was modified.

| Facade | Actual Linux Node consumers | Compatibility/test consumers and retention decision |
| --- | --- | --- |
| `bridge/admin-commands.mjs` | `bridge/admin-api/diagnose-reply.mjs`, `bridge/reply-private.mjs` | `test/admin-commands.test.mjs`, `test/api-usage.test.mjs`, `test/group-summary-command.test.mjs`, `test/version-command.test.mjs`. Keep thin reexports of `bridge/commands/index.mjs`; remove only after known importers migrate. |
| `bridge/context.mjs` | None in current runtime command graphs; live reply uses `context/index.mjs` and split modules. | `test/context-modular.test.mjs`, `test/core.test.mjs`. Keep the thin messages/history/changelog barrel until those compatibility tests migrate. |
| `bridge/jm-provider.mjs` | `bridge/admin-api/diagnose-reply.mjs`, `bridge/admin-api/runtime-status.mjs`, `bridge/commands/action-dispatcher.mjs`, `bridge/reply-private.mjs`, `bridge/runtime-maintenance.mjs`, `bridge/startup.mjs` | `test/jm-provider.test.mjs`. Keep thin reexports and all existing exports until these importers migrate; independent group/private whitelists, uppercase `FS` and delayed cleanup are not cleanup targets. |
| `bridge/memory-profile.mjs` | `bridge/commands/modules/admin.mjs`, `bridge/commands/modules/relationship.mjs`, `bridge/context-retriever.mjs`, `bridge/reply-group.mjs`, `bridge/startup.mjs`, `bridge/user-preferences.mjs` | `test/chat-outcome-integration.test.mjs`, `test/context-retriever.test.mjs`, `test/memory-evidence-integration.test.mjs`, `test/memory-privacy.test.mjs`, `test/memory-profile.test.mjs`, `test/mentions.test.mjs`, `test/quote-context.test.mjs`. Keep thin exports until these importers migrate; generations and storage are out of scope. |
| `bridge/group-summary.mjs` | `scripts/send-summary-for-date.mjs` via `summary:date`; scheduled `daily_summary.mjs` uses `group-summary/index.mjs` directly. | `test/group-summary-command.test.mjs`, `test/group-summary.test.mjs`. Keep the thin reexport until date-summary and compatibility callers migrate. |
| `bridge/clients/providers/mimo.mjs` (`mimoVision`), `deepseek.mjs` (`deepseekChat`) | None; current providers use the task gateway. | `test/llm-client.test.mjs` validates token fields and legacy response shape. Keep these adapters, not duplicate chat implementation. |
| `bridge/clients/llm-client.mjs` | No current production importer; `clients/auth.mjs` separately has live transport/runtime-check consumers. | Provider adapters, `test/core.test.mjs` auth imports and `llm-client.test.mjs`. Preserve `llmCall`, `llmChat`, `buildBearerAuth`, `maskSecret`; even the uncalled `llmChat` is left at the protected auth/transport boundary. |
| `bridge/context-builder.mjs`, `style-router.mjs`, `relationship-export.mjs` | None in runtime command graphs. | `test/relationship-export.test.mjs` checks the reserved interfaces. Keep them; export remains reserved and relationship formulas are unchanged. |

Current barrels such as `commands/index.mjs`, `mentions/index.mjs`,
`group-summary/index.mjs` and feature `index.mjs` files are entrypoints, not
alternate implementations. Their presence is not evidence of dead code.
The follow-up regression checks exact direct Node/test consumer lists for the
five top-level compatibility facades above, and their documented paths. Browser
roots never make a historical Node adapter a production dependency.

## Result Wrappers

| Old return shape | Actual caller / retention condition |
| --- | --- |
| `handleExplicitLinkPreviewCommand`, `handleWordcloudCommand` boolean wrappers | `commands/action-dispatcher.mjs` still uses them. Keep until dispatch and external callers migrate without equating recognition with confirmed delivery. |
| `handleMiniApp` boolean wrapper | No current repository caller; `reply-group.mjs` uses `handleMiniAppResult`. Keep the thin compatibility entrypoint; reply ownership is out of scope. |
| `generateGroupSummary` text wrapper | `group-summary/index.mjs` reexports it; `test/group-summary.test.mjs` calls it. Service/management use `generateGroupSummaryResult`. Keep until known callers migrate. |
| `tryMiMo` text wrapper | `test/core.test.mjs`, `model-output.test.mjs`; live routing uses typed variants. Keep reasoning-isolation and output regressions. |
| `tryDeepSeek` text wrapper | `test/model-output.test.mjs`; live routing uses the typed variant. Keep the output regressions. |
| `parseMiMoResponse`, `callMiMoApi` | `model-router.mjs` uses the parser; `test/core.test.mjs` checks both. Keep; active model routing is not owned by this cleanup. |
| `tryMiMoVision` text wrapper | `model-mimo.mjs` via `resolveVisionContext`; `test/safe-url.test.mjs`. Keep current image URL, budget, privacy and fallback boundaries. |
| `shouldInterject(text, oldBoolean, previewSent)` / `buildSafeInterjectionReply` in `bridge/reply-handlers.mjs` | `test/core.test.mjs` calls the old signature/fallback; live `bridge/reply-group.mjs` uses `buildInterjectionDecision`. Keep delegation to `bridge/interjection-policy.mjs`; the old fallback is not an active replacement for a model error. |

The Boolean link/wordcloud wrappers project `.handled`, not `.delivery`; the
mini-app wrapper projects `delivery === "sent"`. Text wrappers project `.text`
from their typed authority. The follow-up AST regression locks the five
single-return link/wordcloud/summary/chat projections, so they cannot quietly
grow a second executor. `handleMiniApp` has no known current repository caller;
its exported compatibility contract is thin, not a duplicate implementation.
Unknown external use is not proven either present or absent. The same caveat
applies to the uncalled `llmChat`, retained at the protected auth/transport
boundary rather than used to justify deleting tested `llmCall` or auth exports.

## Management And Host Compatibility

| Entry / shape | Real browser consumer | Windows frozen external / safety consumer | Decision and exit condition |
| --- | --- | --- | --- |
| Classic `launcher/QQFriendLauncher/Web/host-client.js` / `window.QQFriendHost` | First script in `launcher/QQFriendLauncher/Web/index.html`; `launcher/QQFriendLauncher/Web/ui/state.js` exports `host` for actions/tasks/pages; standalone console modules also use the host | WebView `postMessage({id, action, payload})` handled by `launcher/QQFriendLauncher/App/LauncherForm.Home.cs`; `test/launcher-frontend.test.mjs` covers replies/errors/events | Keep the thin browser/desktop selector. Linux rejects desktop service/native-page actions; desktop does not fall through to browser HTTP. No second authority or Windows update. |
| Direct `GET/POST /admin/stickers` | `launcher/QQFriendLauncher/Web/ui/actions.js` refresh and mutations via `manageStickers`; `launcher/QQFriendLauncher/Web/ui/tasks.js` uses `/admin/tasks` for supported browser long actions, direct host fallback for other actions/desktop | `launcher/QQFriendLauncher/Services/BridgeAdminClient.cs` (`GetStickersJsonAsync`, `ManageStickersJsonAsync`); `test/admin-workflows.test.mjs`, `test/launcher-frontend.test.mjs` | Keep routes in `bridge/admin-api/routes.mjs` delegating to the same sticker manager. Task support does not retire direct reads/settings or the frozen desktop caller. |
| Direct `GET/POST /admin/diagnose/replay` | `launcher/QQFriendLauncher/Web/diagnostics.js` reads and uses `replayAction`; `launcher/QQFriendLauncher/Web/ui/tasks.js` redirects supported browser generation to `/admin/tasks` | `test/launcher-frontend.test.mjs`, `test/diagnostic-replay.test.mjs`; no C# replay-action handler was found in the inspected host switch | Keep direct check/baseline/review and shared replay service; migrate all action callers before route removal. An action sent to WebView is not proof of a working Windows replay handler. |
| `GET /admin/memes`, stopped `POST /admin/memes` | `launcher/QQFriendLauncher/Web/ui/actions.js` calls `getMemes`; `launcher/QQFriendLauncher/Web/pages/memes.js` renders only the archive. Browser host rejects all eight old mutations before request | C# `GetMemesJsonAsync` / `SaveMemeJsonAsync`, host actions `saveMeme`, `toggleMeme`, `deleteMeme`, `clearMemeCandidates`, `runMemeWebUpdate`, `researchMemeWeb`, `rollbackMemeWebUpdate`, `restoreMemeHistory`; `test/admin-memes.test.mjs` checks 410/auth/unchanged bytes | Retired archive, not active production dictionary. Keep authenticated reads and explicit 410 write rejection; deletion would break known old clients or erase the stopping contract. No updater import. |
| `POST /admin/tasks` with `module: "memes"` | No current browser producer; existing managed-task console remains active for other modules | `test/task-runner.test.mjs` covers retirement rejection | Keep the early stopped-module rejection in `bridge/admin-api/task-manager.mjs`; never revive old updater handlers through generic tasks. |
| Old `meme-status`, `meme-search`, `meme-toggle`, `meme:audit` | None as active browser operations | `bridge/commands/modules/basic.mjs`, `bridge/commands/modules/admin.mjs`, `scripts/audit-meme-matches.mjs`; `test/meme-governance.test.mjs`, `test/meme-retirement.test.mjs`, `test/commands-modular.test.mjs` | Keep explicit stopped/read-only responses. `meme:audit` is an operational archive consumer, not active model/learner execution. |

`/admin/diagnose/reply` is also a real Linux host `diagnose` request and C#
`DiagnoseReplyJsonAsync` consumer, not an obsolete replay endpoint. Browser
result routing and synthetic desktop acknowledgements are tested without HTTP;
C# source strings establish a consumer contract, not compiled-client success.

## Existing Data And Presentation Adapters

These are required behavior within current modules, not spare entrypoint files
or parallel runtime authorities. No private data was opened to inspect them.

| Compatibility behavior | Actual consumer / evidence | Retention boundary |
| --- | --- | --- |
| `bridge/group-summary/generation-plans.mjs` structured vs old presentation | `bridge/group-summary/providers.mjs`; `test/group-summary.test.mjs`, `test/summary-generation-contract.test.mjs` | Both plans feed one `generateGroupSummaryResult` provider/budget/output pipeline. Keep presentation adaptation, not duplicate model execution. |
| `bridge/group-summary/journal.mjs` legacy capture read; `bridge/group-summary/guard.mjs` old `sentAt` marker | Current loader/member-summary records and summary publisher/catch-up/service; `test/group-summary-catchup.test.mjs`, `test/group-summary-guard.test.mjs` | Preserve old-message availability and already-sent evidence; source audit is not authorization to erase data or resend. |
| `bridge/chat-outcome.mjs` old string vs typed outcome | Live reply/model/tool callers; `test/chat-outcome.test.mjs`, `test/chat-outcome-integration.test.mjs` | Old strings still cross output sanitization; typed outcomes do not re-run it. Keep one delivery/outcome authority. |
| `bridge/api-providers/usage-aggregate.mjs` old usage-event shape | `bridge/api-providers/usage-metrics.mjs`; `test/usage-aggregate.test.mjs` | Old metadata remains explicitly unknown/legacy, not invented current retry/model/cache values. No historical outputs are scanned. |

## Retired Meme Surface

Only `knowledge/memes/archive.mjs` and `image-context.mjs` are reachable from
runtime command graphs. Archive callers are capability/command retirement
messages, `admin-api/meme-manager.mjs`, `admin-api/task-manager.mjs` and
`scripts/audit-meme-matches.mjs`. Image utilities are imported by sticker
`analyzer.mjs` and `image-classifier.mjs`; they are active, not dead adapters.

The retained files have distinct duties:

| Retained surface | Actual consumer class | Keep / later removal condition |
| --- | --- | --- |
| `bridge/knowledge/memes/archive.mjs` | Node retirement commands/status/admin/task guard and `scripts/audit-meme-matches.mjs`; browser GET archive through routes | Retired read-only authority; never seeds or rewrites manual archive. Keep while archive/stopping interfaces exist. |
| `bridge/knowledge/memes/image-context.mjs` | Active `bridge/features/stickers/analyzer.mjs`, `bridge/features/stickers/image-classifier.mjs`; `test/image-context.test.mjs`, `test/image-codecs.test.mjs` | Shared active image utilities, not retired dictionary. Do not delete the directory wholesale. |
| `bridge/knowledge/memes/index.mjs`, `store.mjs`, `schema.mjs`, `seed.mjs`, `learner.mjs`, `matcher.mjs`, `message-policy.mjs` | Historical governance/knowledge/command/retirement tests via the compatibility barrel | Not Linux production. Retain boundedness, governance and reserved contracts until equivalent tests are migrated; no runtime startup/scheduler export. |
| `bridge/knowledge/memes/trend-updater.mjs`, `deduplicator.mjs`, `evidence-search.mjs`, `evidence-verifier.mjs`, `sources/daily-hot.mjs`, `sources/rsshub.mjs` | Historical updater/governance/knowledge tests; direct fetch-boundary tests for evidence search and both sources | Not Linux production. Preserve the existing network-response/security regressions. Future removal needs migrated coverage and consumer evidence, not just zero Node reachability. |

The old `knowledge/memes/index.mjs` is a pure compatibility barrel consumed by
`test/commands-modular.test.mjs`, `meme-governance.test.mjs`,
`meme-knowledge.test.mjs`, `meme-retirement.test.mjs` and `meme-updater.test.mjs`.
Its store/schema/seed, learner/matcher/message-policy and updater/deduplicator
implementations remain required by those tests. Updater tests also directly use
evidence-search/verifier. `test/feature-fetch-boundaries.test.mjs` directly uses
both trend source readers and evidence search for bounded-response security
regressions. These are real compatibility consumers, not production consumers.

Retired `meme-status`, `meme-search`, `meme-toggle`, admin write/update/research
actions and `meme:audit` remain explicit stopped/read-only interfaces. They do
not import the old updater. `initializeMemeKnowledge` and
`scheduleMemeTrendUpdates` remain absent. No source/data migration, manual-term
deletion or archive write occurs here. Safety tests must be preserved or moved
to an equivalent current boundary before further implementation removal.

## Commands, Dynamic Calls And Overlay Handoff

`test/p5-legacy-interfaces.test.mjs` parses source JS with ESLint's existing
Espree dependency. It traverses static imports, reexports and literal dynamic
imports from every direct Node package command except test/lint families:
start, watchdog, release/check/zip, daily/date summary, JM/runtime/dependency
checks, Linux smoke, scaffolding, self-description, meme audit and replay.
It does not execute those commands or import runtime state. A regression rejects
unclassified non-test/lint command syntax rather than silently omitting new
roots. `package.json.main` must be covered. Docker CMD, systemd services and the
summary cron installer currently reference the same bridge/daily roots; these
deployment sources were read, not run. Reached Node modules currently have no
computed dynamic imports. Module/plugin catalogs
project `MODULE_DEFINITIONS`; command registries dispatch explicit handlers,
not arbitrary manifest paths. Source/path searches also covered deploy files,
scripts, frontend and test consumers. Generated dynamic imports inside test
strings and the Windows NapCat launcher target explicit fixture/NapCat modules,
not either removed implementation. The additional browser graph starts at every
executable external `index.html` script (currently classic `host-client.js`,
then module `api-usage.js`, `app.js`, `diagnostics.js`,
`conversation-summaries.js`, `summaries.js`). It strips URL cache query/hash,
traverses imports/reexports/literal dynamic imports, checks the static asset
whitelist and rejects computed/non-local imports in reached browser modules.
Relative import cache query/hash is resolved with file URLs too. Non-script JSON
and commented-out tags are not roots. New inline, off-console, unterminated or
unclassified-type scripts fail closed and require explicit inspection. The
script-tag reader is restricted to the current external-tag syntax, not a
general browser HTML parser. Source collection does not descend
into private `outputs`, `.qqfriend`, backups/logs, dependencies, build outputs
or symlinks. Node, browser and test graphs are never merged for classification.
Unknown external callers remain a risk.

The worker did not edit `deploy/linux/Dockerfile.overlay`. Parent has appended
this exact inherited-file cleanup, verified in the shared source after handoff:

```text
/app/bridge/features/stickers/manifest.mjs
```

`COPY bridge ./bridge` does not remove an inherited file. The existing removal
of `/app/bridge/features/index.mjs` is also retained. `mimo.mjs` remains in the overlay
and is overwritten by COPY, so its removed function needs no separate path
deletion. Image build checks and the final Linux full gate belong to the parent;
this worker performs only scoped offline tests/lint, with no commit, push,
deployment, paid API call or QQ send.

## Scoped Verification

### 2026-10-01 Follow-Up Boundary

New focused regressions cover browser roots and whitelist reachability, exact
facade consumers, single-authority result projections, fake browser route
calls/retired-mutation rejection and synthetic Windows host acknowledgements.
The earlier six regressions and all existing test files/rules are retained.
Only the two assigned documentation/test files are changed. No paid model,
real HTTP, QQ, real configuration, complete suite, Git or deployment operation
is authorized for this follow-up. Temporary test state is confined to
`F:/CodexArtifacts/qqfriend/20261001/temp`.

Actual local verification: the focused run included
`test/p5-legacy-interfaces.test.mjs`, `test/entry-outcomes.test.mjs`,
`test/admin-memes.test.mjs`, `test/meme-retirement.test.mjs`,
`test/llm-client.test.mjs`, `test/context-modular.test.mjs`,
`test/relationship-export.test.mjs` and `test/task-runner.test.mjs` only.
Captured totals: **61 tests, 60 passed, 0 failed, 1 skipped**. The skip was the
existing archive file-symlink test, due to unavailable Windows symlink
permission; it is not Linux acceptance. All **14 P5-03 regressions passed**
(the original six plus eight additions). The run used `NODE_ENV=test`, isolated
synthetic config/data/log/temp paths and rejection guards on unmocked fetch,
HTTP/HTTPS request/get and socket connect. Existing tests supplied mocks or
in-process request streams, never a real HTTP/QQ service. The run directory was
`F:/CodexArtifacts/qqfriend/20261001/temp/p5-03-8367e36aa48b4475bc2e009eab69bee9`.
Scoped ESLint via `node node_modules/eslint/bin/eslint.js
test/p5-legacy-interfaces.test.mjs --max-warnings=0` passed with no warnings or
errors. The full suite and Git checks were intentionally not run.

Evidence limits: this is a local source snapshot while image/Agent writers may
still be active; final integration must rerun the AST check after writers stop.
Static graphs are module reachability, not runtime execution or proof of every
export's use. C# is inspected as explicit source consumer evidence, not compiled
or AST-traversed; installed frozen/external clients and arbitrary generated
imports/child-process code are unverified. The inherited overlay path removal
is source intent only; built-image absence, Linux CI/full gate, backup/recovery,
live route/auth behavior, server version and deployment remain unverified here.
No P5 item or added Agent item is marked accepted by this follow-up; the source
checklist remains 35/43 = 81.4%, this follow-up adds 0 accepted items. That count
is documentation-derived, not a fresh whole-project operational acceptance.

### Historical 2026-09-28 Verification

ESLint on `bridge/clients/providers/mimo.mjs` and
`test/p5-legacy-interfaces.test.mjs`, with `--max-warnings=0`, passed with no
warnings or errors. `git diff --check` passed for the four owned paths. A second
source/path search found no remaining callers for either removed implementation.

The isolated local regression run captured 92 tests: 91 passed, 0 failed,
1 skipped because Windows file-symlink permission was unavailable. It included
the six new removal tests plus existing llm-client, admin-modules,
context-modular, commands-modular, relationship-export, meme-retirement,
meme-updater, meme-governance, meme-knowledge, feature-fetch-boundaries and
stickers tests. Tests used temporary synthetic config/data roots and an
unmocked-fetch rejection guard. They did not start the Bot or use production
configuration/data. This run occurred while other workers were still active;
after all source writers finish, the parent must rerun the source-wide AST
test to validate a stable final snapshot, not a potentially raced intermediate
file. The Windows skip is not Linux acceptance. Parent/operational candidate
verification must also confirm the exact inherited path is absent inside the
built candidate before promotion; the Dockerfile removal alone is not image
evidence. No original P5 checklist item is marked accepted by this worker.
