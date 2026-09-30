# Legacy Interfaces: P5-03

Scope: Linux source based on executable `b85bd00` and documentation HEAD
`6552950`, inspected on 2026-09-28. This is a cleanup record, not release or
whole-P5 acceptance. Windows installation, runtime state and manual meme data
are unchanged. The original compatibility table in
[MODULAR-RUNTIME.md](MODULAR-RUNTIME.md)
was read before changing code.

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

| Facade | Actual production consumers | Compatibility/test consumers and decision |
| --- | --- | --- |
| `bridge/admin-commands.mjs` | `admin-api/diagnose-reply.mjs`, `reply-private.mjs` | `test/admin-commands.test.mjs`, `api-usage.test.mjs`, `group-summary-command.test.mjs`, `version-command.test.mjs`. Keep thin reexports of `commands/index.mjs`. |
| `bridge/context.mjs` | None in current runtime command graphs; live reply uses `context/index.mjs` and split modules. | `test/context-modular.test.mjs`, `core.test.mjs`. Keep the thin messages/history/changelog barrel. |
| `bridge/jm-provider.mjs` | `admin-api/diagnose-reply.mjs`, `admin-api/runtime-status.mjs`, `commands/action-dispatcher.mjs`, `reply-private.mjs`, `runtime-maintenance.mjs`, `startup.mjs` | `test/jm-provider.test.mjs`. Keep all existing exports; independent group/private whitelists, uppercase `FS` and delayed cleanup are not cleanup targets. |
| `bridge/memory-profile.mjs` | `commands/modules/admin.mjs`, `commands/modules/relationship.mjs`, `context-retriever.mjs`, `reply-group.mjs`, `startup.mjs`, `user-preferences.mjs` | `test/chat-outcome-integration.test.mjs`, `context-retriever.test.mjs`, `memory-evidence-integration.test.mjs`, `memory-privacy.test.mjs`, `memory-profile.test.mjs`, `mentions.test.mjs`, `quote-context.test.mjs`. Keep thin exports; generations and storage are out of scope. |
| `bridge/group-summary.mjs` | `scripts/send-summary-for-date.mjs` via `summary:date`; scheduled `daily_summary.mjs` uses `group-summary/index.mjs` directly. | `test/group-summary-command.test.mjs`, `group-summary.test.mjs`. Keep the reexport. |
| `bridge/clients/providers/mimo.mjs` (`mimoVision`), `deepseek.mjs` (`deepseekChat`) | None; current providers use the task gateway. | `test/llm-client.test.mjs` validates token fields and legacy response shape. Keep these adapters, not duplicate chat implementation. |
| `bridge/clients/llm-client.mjs` | No current production importer; `clients/auth.mjs` separately has live transport/runtime-check consumers. | Provider adapters, `test/core.test.mjs` auth imports and `llm-client.test.mjs`. Preserve `llmCall`, `llmChat`, `buildBearerAuth`, `maskSecret`; even the uncalled `llmChat` is left at the protected auth/transport boundary. |
| `bridge/context-builder.mjs`, `style-router.mjs`, `relationship-export.mjs` | None in runtime command graphs. | `test/relationship-export.test.mjs` checks the reserved interfaces. Keep them; export remains reserved and relationship formulas are unchanged. |

Current barrels such as `commands/index.mjs`, `mentions/index.mjs`,
`group-summary/index.mjs` and feature `index.mjs` files are entrypoints, not
alternate implementations. Their presence is not evidence of dead code.

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

## Retired Meme Surface

Only `knowledge/memes/archive.mjs` and `image-context.mjs` are reachable from
runtime command graphs. Archive callers are capability/command retirement
messages, `admin-api/meme-manager.mjs`, `admin-api/task-manager.mjs` and
`scripts/audit-meme-matches.mjs`. Image utilities are imported by sticker
`analyzer.mjs` and `image-classifier.mjs`; they are active, not dead adapters.

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

The new `test/p5-legacy-interfaces.test.mjs` parses repository JS with ESLint's
existing Espree dependency. It traverses static imports, reexports and literal
dynamic imports from every direct Node package command except test/lint:
start, watchdog, release/check/zip, daily/date summary, JM/runtime/dependency
checks, Linux smoke, scaffolding, self-description, meme audit and replay.
It does not execute those commands or import runtime state. Reached runtime
modules currently have no computed dynamic imports. Module/plugin catalogs
project `MODULE_DEFINITIONS`; command registries dispatch explicit handlers,
not arbitrary manifest paths. Source/path searches also covered deploy files,
scripts, frontend and test consumers. Generated dynamic imports inside test
strings and the Windows NapCat launcher target explicit fixture/NapCat modules,
not either removed implementation. Unknown external callers remain a risk.

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
