# P5 Linux Candidate And Gray Acceptance

Status: prepared operational candidate, not P5-04/P5-05 acceptance. The exact final executable commit is still TBD. The parent owns the combined gate, actual quality review and deployment authorization. Windows remains frozen. Nothing in this document authorizes test messages, paid probes or an automatic expansion.

## Predeclared Gray Contract

| Item | Required Value |
| --- | --- |
| Next image version | `1.4.40-final-integration`, not final `2.0.0` |
| Initial selected group | `1105126214` only |
| Bridge process setting | `QQBOT_IMAGE_CONTEXT_ROLLOUT=1105126214` |
| Observation starts | Actual new-image Bridge `/ready`, health and parsed live verification have passed |
| Minimum window | 1,800 seconds (30 minutes) after that readiness confirmation |
| Maximum window | Predeclare 1,800-7,200 seconds before observation; never an unbounded watcher |
| Natural coverage | At least 5 completed model chats in the selected group, including at least 1 successfully read image-evidence case |
| Completion | Terminal trace, successful model attempt, confirmed send, no failed/unknown receipt; one trace counted once |
| Safety | Zero privacy, wrong-recipient, duplicate-send or reasoning-leak incidents; any alert stops the new path immediately |
| Sampling | Natural traffic only. No broadcast replies, private test sends, synthetic QQ sends or probe warm-ups |

Rare permission, cancellation, transport, privacy-generation and protocol cases are covered by the parent's synthetic fixed matrix and full regression gate, not by manufacturing production traffic. Image presence and a successful HTTP response do not establish semantic answer quality. The parent must review the bounded private 32-request quality matrix for the exact executable/image before deployment; this material does not automatically accept P3-06 or P5-02.

If natural traffic, image evidence, continuous coverage or incident evidence is insufficient, leave **P5-05 unaccepted**. Do not lower the thresholds after observing results or set the rollout to `all`. A passing metadata summary is only eligible for parent review, never expansion authorization.

## Concrete Candidate

Private operational files live in the sibling `outputs/` directory, not the public release. They reuse the stable-cache build/promote/backup pattern. There is no approval registry or mandatory placeholder-hook framework.

The immutable baseline is the supplied active record: executable `b85bd00d65a609bf283e189e870b6a9fd7974aed`, image `qqfriend-bridge:1.4.39-stable-cache-b85bd00`, image ID `sha256:15253d4931b6edb009426d0776aacfd6b90b6c8c9b32c52753c811e278a79f06`. Its existing release, backup and deployment record must remain intact. The prior isolated restore parsed 155 JSON files; that is historical evidence, not an expected count for the next live snapshot.

Parameters are the **full new 40-character commit**, source archive SHA-256 and optional deployment base. The archive must be a public-source `git archive` of that exact commit, named `qqfriend-linux-<full-commit>.tar.gz`. Its PAX commit, portable paths, forbidden data paths, package/lock version and unchanged production dependency lock are checked before extraction. Only the exact source-only `.github/workflows/publish-linux-images.yml` exception is allowed; it remains excluded from the release ZIP. Public Linux documents remain subject to the explicitly enumerated release whitelist.

The stage locks the accepted 39 image ID and its OCI/source labels, builds offline on that image, and verifies revision/version/archive/base labels. It compares the actual image's executable trees and copied root files against the new archive; both stale files must be absent:

- `/app/bridge/features/index.mjs`
- `/app/bridge/features/stickers/manifest.mjs`

The full gate uses a fresh extraction of **all new-commit tests**, not inherited image tests. Install development dependencies without real configuration/credentials, then run the existing full `release:check` once, zero-warning lint within that same gate, offline replay and Linux smoke without external networking. Counts come from the same captured test output; unknown counts block readiness. Do not run a second full suite merely to count tests.

The isolated candidate mounts the actual config read-only, uses temporary data/logs, and disables external networking. It checks environment-dependent stable/strict prompt metadata, real admin authentication and configuration tokens, rejected stale CAS over local HTTP (409), retired meme writes (410), retained `mimoVision`, shared `buildBearerAuth`/`maskSecret`, reserved relationship exports, bounded vision sharing, actual JM Python/7-Zip readiness and an actual synthetic ZIP accepting uppercase `FS` and rejecting lowercase `fs`. It never downloads a real JM resource or uploads to QQ.

Stage success writes the top-level `final-integration-candidate-<full-commit>.identity` with exactly four lines, compatible with the probe worker:

```text
<full executable commit>
<source archive sha256>
<exact tested candidate image ID>
<accepted immutable 1.4.39 base image ID>
```

No identity is written after a failed gate. Activation promotes this exact image ID without rebuilding, rechecks source/config/image identity, and references the parent's actual reviewed private report by file and digest. Report existence is not semantic proof: the parent must inspect the report and same-commit Linux CI before invoking activation.

## Persistent Rollout And Recovery

Activation copies the old release environment files with mode 0600. It changes the existing image-tag line and appends **one nonsecret release `.env` key**, `QQBOT_IMAGE_CONTEXT_ROLLOUT=1105126214`. The public Compose environment mapping passes that value only to the Bridge. This is a predeclared intentional environment delta, not a provider/config mutation. Standard Compose, systemd and daily cron reuse the release `.env`; no one-shot `-f` override is required or allowed to carry the gate. Operational Compose calls clear an ambient rollout variable so a QA process set to `all` cannot override the release file. Standard service environments must likewise not override it with `all`.

The actual Bridge environment and policy are verified after start. The real `qqfriend.env`, provider routes/reasoning, config filename set and bytes, private sidecars and retired archive bytes remain unchanged. Configuration hashes and filenames stay private. After deployment the parent must also check a normal service/cron invocation resolves the same selected-group environment, without sending a test message.

Under the existing daily-summary lock, stop the old Bridge cleanly, take a 0700/0600 private-state backup, test gzip, restore **only into an isolated new directory**, compare bytes and parse its bounded JSON set. The existing original backup is not replaced. Promote the current symlink, start the exact candidate image without rebuilding/pulling, and require a nonempty parsed live result with health, readiness, QQ login, OneBot connection, actual JM readiness, chat-work/vision limits and retained interfaces. Both normal activation and rollback set `P5_RUN_LIVE=1`; successful process exit alone is insufficient. Require one managed daily cron job, inactive duplicate timer, Asia/Shanghai and unchanged NapCat start time.

On failure or a gray safety incident: stop the new Bridge first. The rollback guard runs the actual accepted 39 image against **current stores mounted read-only**. Only after compatibility and baseline environment/config identity pass may old code restart. Rollback changes code/image/current symlink and restores the captured cron definition; it **never extracts old backup data over live stores**. Stop failure, incompatible stores or failed readiness leave the Bridge stopped for manual review. The structural guard covers existing user memory/group chats/topic branches, not every possible schema; the parent must assess final new-state compatibility and old-code read/write behavior beyond that guard before deployment.

## Metadata Observer

`observe-linux-final-integration.sh` is a foreground, bounded observer, started only after the parent has reviewed deployment and the new Bridge is ready. No background process or automation is created by preparing these files. It reads the admin token **inside** the actual Bridge, uses the authenticated existing `/admin/diagnose/traces` API plus read-only health/readiness/runtime APIs, and prints only an anonymous final summary. No token, raw trace/message/user ID, text, context, prompt or private reasoning is printed or persisted.

The current API returns at most 100 latest records from a 300-record, nonpersistent ring and has no pagination. Poll every 5 seconds. Store a durable 0600 checkpoint of HMAC-hashed trace/event IDs and aggregate counters, in a private 0700 directory `/logs/final-integration-gray-<commit>/`; at most 10,000 seen hashes are retained. File and directory fsync precede continued observation. Resume uses the same image, readiness time, window and hashes; counters cannot silently restart or double-count.

Initial incomplete backfill, lost ring overlap, eviction of a processing trace, trace-stage saturation, seen-hash saturation, an API failure, a poll gap over 15 seconds, a late start over 15 seconds or a Bridge restart makes coverage permanently incomplete. Do not turn an unread ring tail into zero incidents. Scope-completed counts require selected-group strict prompt metadata; an unexpected strict policy outside the selected group is an alert. Cancelled, partial, unknown-send and nonmodel command traces do not meet the five-chat threshold.

The existing trace API does **not** expose the actual send recipient or outbound body. Its privacy/reasoning markers and hashed duplicate-event checks are useful alerts, but cannot prove complete absence of those four incident classes. The parent must reconcile actual recipient/receipt/privacy evidence and the bounded quality review using existing authorized operational evidence. Missing evidence remains unknown and blocks acceptance; do not add raw payload logging to fill the gap. Legitimate blocked privacy-generation cancellations are counted separately from suspected sent-after-privacy-change alerts.

## Reviewed Commands

These are parameter templates, not commands executed by Worker D. Run only after the parent has reviewed the exact files, final commit, CI, source scan and actual private quality report. All source/version/frontend edits and the final combined gate remain parent-owned.

```bash
BASE=/home/miku/qqfriend-linux-preview
: "${FINAL_COMMIT:?full reviewed executable commit}"
: "${ARCHIVE_SHA256:?public git archive sha256}"
: "${REVIEW_REPORT:?absolute existing private quality report reviewed by parent}"
bash "$BASE/stage-linux-final-integration.sh" --execute "$FINAL_COMMIT" "$ARCHIVE_SHA256" "$BASE"
# Probe worker uses the four-line identity and the exact staged image. QA may use all in its process only.
# Parent reviews the actual bounded 32-request matrix and same-commit Linux CI here.
bash "$BASE/activate-linux-final-integration.sh" --execute "$FINAL_COMMIT" "$ARCHIVE_SHA256" "$REVIEW_REPORT" "$BASE"
# Start immediately after verified readiness; foreground, default predeclared 30-minute window.
P5_OBSERVE_SECONDS=1800 bash "$BASE/observe-linux-final-integration.sh" --execute "$FINAL_COMMIT" "$ARCHIVE_SHA256" "$BASE"
# On an incident, stop the new path immediately; do not wait for the window or samples.
bash "$BASE/rollback-linux-final-integration.sh" --execute "$FINAL_COMMIT" "$ARCHIVE_SHA256" "$BASE"
```

`verify-final-integration-gray.mjs <activation.json> <anonymous-observer-summary.json>` checks the bounded window, exact identity, natural coverage and metadata alerts offline. Its best result is `eligible_for_parent_incident_and_quality_review`, with `grayAccepted=false` and `expansionAuthorized=false`. It never edits the rollout or acceptance checklist. All operational logs/reports/checkpoints stay private; return machine-readable summaries rather than raw logs or prompts.
