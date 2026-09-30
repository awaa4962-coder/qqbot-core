# P5-02 Fixed Quality Matrix

Scope: Linux candidate on `agent/linux-server-preview`, executable base `b85bd00`, documentation HEAD `6552950`. This is a synthetic acceptance harness, not a deployment or a declaration that P5-02 is complete. The original P5 checklist in `MODULAR-RUNTIME.md` and quality requirements in `ROADMAP.md` remain authoritative. Windows installation stays frozen.

## Evidence Layers

1. Existing `npm run replay:check`: retained unchanged, 11 fixed inputs plus two output boundaries (13 checks). Passing it does not prove model answer quality.
2. `test/p5-quality-matrix.test.mjs`: actual context selection, model request composition, tool permission/failure, memory revision/expiry/erasure, image path and persistent delivery boundaries, using isolated synthetic stores and explicit transport stubs. No real network, paid API or QQ send is permitted.
3. `scripts/p5-quality-fixtures.mjs`: fixed synthetic inputs, 17 boundary rows, eight representative real-model probe inputs, predeclared human rubrics and honest unobserved report fields. It has no paid replay runner, keyword judge or auto-acceptance function.
4. Parent's post-final-commit paid replay and single-group observation: not executed by this worker. These are required separately before full P5 acceptance.

## Concrete Matrix

| Fixed Row | Executed Boundary | What Still Needs Semantic Evidence |
| --- | --- | --- |
| `identity-quote` | Same-name current/quoted IDs stay distinct in real group/interjection model wire | Correct addressee and attribution in a real answer |
| `missing-source` | Unavailable quote cannot be rehydrated from nearby user/group histories | Natural request for original text; no fabricated wording |
| `current-priority` | Group/private/file current input is last; sentence-initial or supported leading self-address plus explicit topic switch drops old thread/advice from actual model wire | Correct nickname, direct arithmetic and natural wording still require real output review |
| `failed-step` | Actual thread carries prior uppercase FS advice and current failure to transport | Acknowledge failed step, ask only the decisive missing error, no invented password |
| `memory-correction` | Revision 1 is retracted from context, derived thread, quoted source and cached tool session | Corrected content used naturally; ordinary correction is not falsely called persisted |
| `memory-expiry` | Exact note expiry invalidates old dependency while thread remains live | No stale preference/fact restatement in real output |
| `memory-forget` | Group/private/file late model response is cancelled after real synthetic erasure | No erased details in subsequent real model answer; cannot retract data already sent |
| `scope-permission` | Foreign notes excluded; forged identity arguments never reach reader; revoked/denied scope stops | No promise to fetch/administer inaccessible data |
| `tool-failure` | Failed/denied tool calls paired by ID; failure data and private protocol not sent to fallback | Honest failure/uncertainty wording, no invented successful execution |
| `privacy` | Reasoning-only is failure, not silence; fallback/result omit synthetic private reasoning | Human inspection of cleaned final text; no privacy inference |
| `current-capability` | Primary/fallback actual model facts differ correctly; caller sees no admin/JM/private endpoint data | Configured readiness must not become live health or execution claim |
| `vision-path` | Prepared native pixels vs objective-description text in group/private/file, without fetching real assets | Real visual recognition, unreadable/animated content and actual image semantics |
| `picture-irony` | Positive-after-failure, negative-after-success and literal control retain distinct facts/fingerprints | Tone can change; confirmed outcome cannot. No unsupported comfort/hostility/motive |
| `ordinary-no-final-cache` | Two independent identical requests per group/private/file each reach transport | Quality/freshness of each response, not claimed savings |
| `interjection-silence` | Explicit empty JSON stops primary with no tools/fallback/send; ledger is silent | Real model chooses silence when no useful contribution exists |
| `partial-send` | Confirmed first chunk + rejected second remain partial; third and duplicate stop | Live transport/receipt behavior remains a parent/operations gate |
| `unknown-send` | Ambiguous first/second receipt remains unknown, stops later chunks, restart keeps fence | No automatic retry; manual resolution/live observation still needed |

## Eight Representative Probes

Exports: `P5_MODEL_PROBES`, `P5_BITMAP_LABELS`, `buildP5ProbePacket(probe, { includeImageDescription })`, `getP5QualityFixtures()`, `createP5ProbeRecord(probe, packet, candidateCommit)`. Packet building uses the existing prompt, identity/current/quote frames, conversation selection, thread layers and context budget builders. No production conversation is loaded into the fixture data. Run packet preparation only in an isolated config/data root, before importing production modules, as the test does.

Worker E consumer API: `await getP5QualityFixtures()` returns exactly `{ id, history, input, bitmap, rubric }` for eight cases, in the order below. `history` contains only supplied synthetic evidence frames, without stable system prompt, dynamic style, current input, pixels or objective image descriptions. `bitmap` is `"good"`, `"terrible"` or `null`; `P5_BITMAP_LABELS` maps these to `GOOD JOB` / `TERRIBLE JOB`. E supplies its prepared bitmaps through the real route. Returned arrays/objects are detached on each call. Alternatively E can select from `P5_MODEL_PROBES` and use `(await buildP5ProbePacket(probe, { includeImageDescription: false })).history`.

`1800000000000` is a fixed synthetic source label, not a claim that it is a valid server timestamp now. The supplied quote frames carry declared fixture attribution; their source markers are not evidence of a live OneBot lookup. Actual quote-validation tests use an isolated clock or current synthetic receipt time. Do not apply real-time source validation to this fixed label or present it as a production observation.

| Probe | Predeclared Focus |
| --- | --- |
| `exam-fail-positive` | Original exam-failure input + GOOD JOB, outcome unchanged, no inferred motive |
| `exam-pass-positive` | Original exam-pass positive control, no forced irony or negative direction |
| `achievement-negative` | Original personal-record input + TERRIBLE JOB, success unchanged |
| `failed-restart` | Original quoted restart advice and failed-restart input, one next step/question |
| `image-without-context` | GOOD JOB only; literal words available, tone direction and motive unknown |
| `explicit-comfort-intent` | Peer explicitly says they intend comfort; attribute only that supplied statement |
| `current-correction-topic` | Current Xia naming correction; arithmetic 42; no old download advice |
| `same-name-quote` | Different IDs despite same nickname, current addressee, no invented repair |

The first four preserve the old known quote/input semantics exactly: exam failure, exam pass, new personal record with negative words, and restart already tried without success. The ASCII source stores the original Chinese strings as Unicode escapes; the helper contract test asserts the exact quote/input strings and bitmap choice. New rubrics do not select an unknown tone direction, infer unstated psychology or conflate quoted author with current speaker.

Default `buildP5ProbePacket` supplies **text descriptions**, not pixels. The E helper intentionally omits them, allowing parent/E to test actual prepared bitmap paths. The offline native test injects prepared pixels and a synthetic objective description; it proves composition and path separation, not successful recognition. These eight cases are a representative real-model subset of the 17-row offline matrix, not a full matrix semantic pass. Missing-quote wording, expiry/forget quality, tool/permission failure wording, deliberate silence, actual vision recognition and live delivery behavior still need additional authorized evidence.

Historical engineering gap, fixed by parent (2026-09-28): `currentTopicText` in `bridge/context/relevance.mjs` originally accepted only a sentence-initial anchored switch. The leading nickname instruction in `current-correction-topic` prevented that match; the old download/FS-advice turn could enter the selected, budgeted thread layer, separately from the retained preference layer. Parent now strips only a bounded leading Chinese self-address instruction (wording meaning "call me" / "address me", optional future/request words, 1-32 characters and a terminating clause separator) before applying the original anchored switch. Quoted, reported or embedded commands do not become unanchored switches; when no switch follows, the original complete retrieval text is retained.

Parent strengthened the matrix to require `thread === null` and absence of old advice in actual group/private/file model wire for the supported compound input. Parent reports 14 compound-topic tests, 36 existing conversation-selection tests and the 47-test full matrix passed together (97 total). One NFKC expectation was corrected in a test, not production behavior. Worker C inspected the parser/test changes without rerunning this combined set or making core edits. This is an engineering selection-boundary fix, not evidence that a real model used the new nickname, answered 42, understood image semantics or met P5-02 quality/usage requirements.

## Human Rubric And Records

Review `target`, `grounding`, `relevance`, `correction`, `economy`, `naturalness`: 0 = material miss/contradiction, 1 = partial, 2 = meets the declared case criterion. N/A needs a written reason. Retain the cleaned final text, exact input fingerprint and source/output excerpts supporting each review. Review baseline and candidate under consistent model settings; when comparable baseline output is missing, mark comparison unknown, not improved.

Blocking failures: privacy overreach, private reasoning exposed, wrong recipient, duplicate send or fabricated execution. They cannot be averaged away. Keyword matching, a canned transport answer, a prompt rule existing or a 13/13 check is not semantic proof. Rubrics are frozen before paid outputs are observed; parent owns the final evidence-v4 gray rules and declares its case thresholds before replay. A source explicitly saying "I intend comfort" permits attributed reporting of that statement, not general motive inference in other cases.

`createP5ProbeRecord` starts with `not_run`, null final output, null invocation/Token/duration values, false reporting flags, empty evidence, null human scores and unknown blockers. Null means unknown, not zero. Parent records each physical attempt, primary/fallback and tool round, requested/actual model and reasoning mode, prompt/cleaned output fingerprints, cleaned final output, provider-reported input/output/reasoning/cache/creation/total Tokens and elapsed time. Keep reasoning **counts**, never reasoning text, raw protocol, credentials or production messages. Use existing usage reporting flags; preserve unreported values as unknown. Calculate cache rates from consistent Token totals, not mean percentages, and do not call a first request fully cold without evidence.

## Parent-Only Paid Gate

### 2026-10-01 Frozen Image Comparison

The parent is preparing a new `1.4.42-image-evidence` candidate, not changing the
eight `P5_MODEL_PROBES` inputs, quote authors, bitmaps or scoring dimensions.
The no-context rubric clarification distinguishes positive literal words from
an unknown sincere/ironic tone; it does not permit inferred intent. Original
eight probes remain a representative subset, not all 17 semantic rows.

This batch compares the accepted `1.4.39-stable-cache` image against the exact new
candidate image. Each runs the same frozen pure fixture module, whose relative
imports bind to that image's own context/prompt implementation. Binding a new
fixture module into the baseline must not bind new production code or run the
new selector on behalf of the old image. Both images keep actual primary and
fallback providers and their reasoning configuration; only the candidate's
selected-group image-policy setting is enabled in isolated QA.

Predeclared limits: 8 probes x 2 actual slots x 2 image versions = **32 physical
HTTP attempts maximum**, 16 per image, no paid retry, warm-up or QQ send.
Each trial permits one HTTP attempt and no more than the existing 1536-token
completion allowance; total requested output allowance is at most 49152.
Each image lane has a ten-minute deadline. The shared private plan freezes
fixture/runner/assets/config fingerprints, image IDs, case IDs and thresholds
before any HTTP access. Durable lane and paid-batch reservations reject reruns.
Both lanes must first finish their exact sixteen-request **mocked, network-none**
dry run. A failed or interrupted paid lane is not automatically resumed.

Parent evidence review uses the existing 0/1/2 scale. Every applicable candidate
target, grounding, relevance and correction score must be 2; economy and
naturalness must be at least 1, with no critical failure. N/A needs a written
reason. Original rubrics still govern: no false success, unnamed motive,
wrong speaker, fabricated execution or leaked reasoning may be averaged away.
Baseline/candidate outputs and actual reported usage are retained privately;
missing evidence stays unknown. A requested model ID is not proof of a served
training version. Different-version requests are not a cold/hot cache experiment.

These are predeclared gates, **not results**. At this update the paid comparison,
Linux promotion, natural single-group window, P3-06 and full P5-02 are unaccepted.
The native-tool probe's existing 24-hour quota remains untouched; this comparison
declares no tools and cannot count as a repeated native-tool compatibility probe.

Result appended after the frozen run: both lanes completed sixteen real HTTP
attempts, no retry or QQ send. Parent inspected every cleaned output against the
unchanged criteria and found six failing candidate cases. This was a Codex
evidence review, not user/human sign-off. The new image rules are **not eligible
for gray activation**; P3-06 and P5-02 remain open. Pixel text was received,
but context/intent interpretation and an unsolicited memory-command suggestion
still failed. No new attempt was paid to seek a passing answer. Private reports
retain the full synthetic evidence and native reported usage; public documents
record only aggregated outcomes. P5-03 is separately accepted from its complete
source/consumer, two-audit and final Linux gate, not from this quality replay.

After the final integration commit, the parent must preselect probes/routes and persist a hard budget before network access. Count physical HTTP attempts, including retries, fallback, description generation and tool rounds, not only logical cases. A suggested upper plan for these eight text-only probes is eight primary attempts plus at most eight explicitly reserved fallback attempts, no automatic retry/warm-up; use a tighter parent limit when appropriate. This document is a budget proposal, not authorization or an enforced replay executor. Also predeclare total Token/output/time limits and fail closed if actual transport accounting is incomplete. Do not run all routes or extra controls outside that recorded budget. No QQ sends, production history, real private state or private reasoning are needed for the synthetic replay.

Use the real current route/self-context injection at transport time; fixture packets never prove the provider actually used. Preserve actual primary/fallback config and reasoning settings. Recompute final request fingerprints after runtime self-facts/pixel injection. Keep complete synthetic outputs and human evidence in the parent's restricted report, not in public fixtures. Missing runs, usage or review remain unverified.

## Scoped Commands And Status

From repository root, on Linux:

```sh
node --test --test-concurrency=1 test/p5-quality-matrix.test.mjs
./node_modules/.bin/eslint test/p5-quality-matrix.test.mjs scripts/p5-quality-fixtures.mjs
```

On the Windows development checkout use the same Node command and `node node_modules/eslint/bin/eslint.js` for the two paths. This is local source verification only, not an update to the frozen installed bot. Parent owns final Linux full gate and original checklist status.

Worker C local source checks (2026-09-28): the scoped Node run passed 47/47 tests, zero failure/cancellation/skip; its unchanged legacy replay check passed all 13 internal checks. ESLint for the two new JS files had zero errors/warnings. No second full-suite run was used to obtain counts. This Windows development-source run is not the final Linux gate, which remains parent-owned. Paid calls and real QQ sends = 0.

P5-02 is **not fully accepted** until actual outputs, comparable quality review and actual usage are recorded and integrated by the parent. No commit, push, deploy or original checklist edits are performed here; no net accepted roadmap item is claimed. The original checklist still records 35/43 = 81.4%, this worker +0 items; that is the documented roadmap state, not a new deployment verification.
