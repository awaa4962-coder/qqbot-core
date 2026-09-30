import { createHash } from "node:crypto";

// Fixed synthetic evidence only. This module never invokes a model or sends a message.
export const P5_FIXTURE = Object.freeze({
  now: 1800000000000, groupId: "50150", otherGroupId: "50151", userId: "60150", peerId: "60151",
  botId: "90150", currentMessageId: "70150", quoteId: "70151", noteSourceId: "70152",
  sameName: "\u540c\u540d", obsolete: "Project OBSOLETE_P5_NOTE", corrected: "Project CURRENT_P5_NOTE",
  independent: "Project INDEPENDENT_P5_NOTE", foreign: "Project FOREIGN_P5_NOTE",
  failedInput: "\u6309\u4f60\u8bf4\u7684\u5927\u5199 FS \u8bd5\u4e86\uff0c\u8fd8\u662f\u4e0d\u884c\uff0c\u4e0b\u4e00\u6b65\u5462\uff1f",
  failedTurns: [{
    userSummary: "\u4e0b\u8f7d\u5b8c\u4e86\uff0c\u89e3\u538b\u63d0\u793a\u5bc6\u7801\u9519\u8bef\u3002",
    assistantSummary: "\u5148\u786e\u8ba4\u5bc6\u7801\u4f7f\u7528\u5927\u5199 FS\u3002",
  }],
});

export function p5SyntheticConfig() {
  const f = P5_FIXTURE;
  return { selfUin: Number(f.botId), groupWhitelist: [Number(f.groupId)], friendWhitelist: [Number(f.userId)],
    adminUins: [], botBlacklist: [], botNames: ["SyntheticBot"], resourceGroupWhitelist: [], jmUserWhitelist: [],
    summaryGroupWhitelist: [], featureGroupWhitelist: [], conversationSummaryGroupWhitelist: [], stickerEnabled: false,
    legacyProfileRefreshEnabled: false, tavilyKey: "", napcatApi: "http://p5-onebot.invalid" };
}

export const P5_QUALITY_MATRIX = Object.freeze([
  { id: "identity-quote", roadmap: "P2-02/P2-03", scenario: "Two same-named members; quote belongs to peer, reply belongs to current user.",
    boundary: "Verified author/source IDs remain distinct in selected context and actual model wire." },
  { id: "missing-source", roadmap: "P2-03/P3-02", scenario: "Unavailable quote plus nearby history with a matching message ID.",
    boundary: "No replacement quote, nearby history, image or fabricated source enters context." },
  { id: "current-priority", roadmap: "P2-03/P2-04", scenario: "Old download task; current nickname correction and explicit arithmetic topic switch.",
    boundary: "Current input stays last; recognized sentence-initial topic switch exits old task in group/private/file. Compound switch is a semantic risk." },
  { id: "failed-step", roadmap: "P2-03/P2-04", scenario: "Uppercase FS advice was tried and failed; no new error detail supplied.",
    boundary: "Real thread and current failure feedback reach model together, without claiming the advice succeeded." },
  { id: "memory-correction", roadmap: "P3-02", scenario: "Explicit note revision 1 is read, then corrected to revision 2.",
    boundary: "Old thread/quote/tool evidence stops; fresh reads carry only current revision." },
  { id: "memory-expiry", roadmap: "P3-02/P4-04", scenario: "A one-day explicit note expires while a derived thread is still alive.",
    boundary: "Expiry retracts note/source descendants and invalidates an already populated read session." },
  { id: "memory-forget", roadmap: "P2-01/P3-02", scenario: "User erasure occurs while a model response is awaiting consumption.",
    boundary: "Old result is cancelled before fallback, output or outbound work." },
  { id: "scope-permission", roadmap: "P1-02/P3-04", scenario: "Foreign user/group/private notes and forged recall arguments; whitelist later removed.",
    boundary: "Scope comes from executor; undeclared identity arguments and revoked permission cannot reach a reader." },
  { id: "tool-failure", roadmap: "P3-04/P3-05", scenario: "Recall unavailable, unknown admin tool, then no final primary body.",
    boundary: "Paired tool results preserve failure/denial; fallback does not inherit failed data or private reasoning." },
  { id: "privacy", roadmap: "P1-04/P2-05", scenario: "Reasoning-only or reasoning-plus-final model response.",
    boundary: "Only cleaned final text leaves the model boundary; internal reasoning is not silence or receipt evidence." },
  { id: "current-capability", roadmap: "P1-02/P1-03", scenario: "Configured primary fails, fallback differs; caller lacks administrator/JM permission.",
    boundary: "Each wire has its actually selected model and scoped capability projection, not credentials or health claims." },
  { id: "vision-path", roadmap: "P3-06/P4-03", scenario: "Same prepared pixels go to vision-enabled slot or to objective-description text path.",
    boundary: "Native pixels and text description stay distinct; current context survives group/private/file composition." },
  { id: "picture-irony", roadmap: "P3-06/P5-02", scenario: "GOOD JOB after failure; TERRIBLE JOB after success; literal positive control.",
    boundary: "Original outcome and candidate picture evidence survive; actual tone/motive interpretation requires human review." },
  { id: "ordinary-no-final-cache", roadmap: "P4-06", scenario: "Two independent identical ordinary requests at each chat entrypoint.",
    boundary: "Every request reaches mocked physical transport; no old final reply is reused." },
  { id: "interjection-silence", roadmap: "P2-02/P2-05", scenario: "Unaddressed short acknowledgement; primary returns explicit empty interjection JSON.",
    boundary: "Intentional silence invokes neither fallback nor any send and stays distinct from failure." },
  { id: "partial-send", roadmap: "P2-05/P5-02", scenario: "First chunk confirmed; second explicitly rejected; third must not be sent.",
    boundary: "Ledger remains partial, outcome is not full success, restart and duplicate event do not resend." },
  { id: "unknown-send", roadmap: "P2-05/P5-02", scenario: "Ambiguous receipt after first attempt, with or without a prior confirmed chunk.",
    boundary: "No unknown-delivery retry, no later chunks, persistent duplicate fence; no invented confirmation." },
]);

const speaker = { name: P5_FIXTURE.sameName, userId: P5_FIXTURE.userId };
const quote = (text, userId = P5_FIXTURE.peerId) => ({ text, speaker: P5_FIXTURE.sameName,
  source: { state: "verified", userId, messageId: P5_FIXTURE.quoteId, groupId: P5_FIXTURE.groupId, at: P5_FIXTURE.now - 1000 } });
const rubric = (target, grounding, relevance, correction, economy) => ({ target, grounding, relevance, correction, economy,
  naturalness: "Natural short Chinese; persona must not displace facts, attribution or the requested answer." });

export const P5_BITMAP_LABELS = Object.freeze({ good: "GOOD JOB", terrible: "TERRIBLE JOB" });

export const P5_MODEL_PROBES = Object.freeze([
  { id: "exam-fail-positive", covers: ["picture-irony"], speaker, bitmap: "good",
    input: "\u8fd9\u53e5\u662f\u4ec0\u4e48\u610f\u601d\uff1f",
    quote: quote("\u6211\u8003\u8bd5\u6ca1\u8fc7", P5_FIXTURE.userId),
    rubric: rubric("The quoted current speaker reports exam failure; image sender intent is not provided.",
      "Failure remains failure. Visible GOOD JOB supports a positive literal meaning and possible contrast, not a motive.",
      "Explain the words and evidence-supported ironic contrast; no inferred comfort, encouragement or hostility.",
      "Do not rewrite failure as success; attribute a motive only if explicitly stated in supplied text.", "A short answer, no extra psychological analysis.") },
  { id: "exam-pass-positive", covers: ["picture-irony"], speaker, bitmap: "good",
    input: "\u8fd9\u53e5\u662f\u4ec0\u4e48\u610f\u601d\uff1f",
    quote: quote("\u6211\u8003\u8bd5\u901a\u8fc7\u4e86", P5_FIXTURE.userId),
    rubric: rubric("The quoted current speaker reports passing; no other person's result is given.",
      "Success remains success; positive words align with it. Do not force an ironic or negative direction.",
      "Explain literal praise when supported, without assigning private intent to the sender.",
      "Do not convert success to failure or invent a mocking author.", "A short natural answer.") },
  { id: "achievement-negative", covers: ["picture-irony"], speaker, bitmap: "terrible",
    input: "\u4e00\u53e5\u8bdd\u89e3\u91ca\u8fd9\u56fe",
    quote: quote("\u6211\u521a\u7834\u4e86\u4e2a\u4eba\u7eaa\u5f55", P5_FIXTURE.userId),
    rubric: rubric("Personal record belongs to the explicit quoted author.",
      "New personal record remains success; TERRIBLE JOB is negative wording with a supported contrast, not proof of hostility.",
      "Explain possible joking irony without inventing a failed attempt, comfort or mocking motive.",
      "Keep confirmed outcome; psychological attribution needs explicit source text.", "One short sentence, no picture inventory.") },
  { id: "failed-restart", covers: ["failed-step"], speaker, bitmap: null,
    input: "\u91cd\u542f\u8bd5\u4e86\u8fd8\u662f\u4e0d\u884c\uff0c\u4e0b\u4e00\u6b65\u5462\uff1f",
    quote: quote("\u5148\u91cd\u542f\u518d\u8bd5", P5_FIXTURE.botId),
    rubric: rubric("Address the person who tried the explicitly quoted restart advice.",
      "Restart has been attempted and failed; decisive new error detail is absent.",
      "Acknowledge failed step and ask only the decisive missing error detail or give one supported next step.",
      "Do not repeat restart, invent a cause/parameter or declare success.", "One useful short next question/action, no checklist.") },
  { id: "image-without-context", covers: ["missing-source", "picture-irony"], speaker, bitmap: "good",
    input: "\u8fd9\u56fe\u662f\u4ec0\u4e48\u610f\u601d\uff1f",
    rubric: rubric("No outcome, preceding quote or explicit author intent was supplied.",
      "Only GOOD JOB is visible: explain literal words but the ironic/literal direction is unknown.",
      "Do not manufacture surrounding conversation, a failure/success, praise/irony direction or motive.",
      "Unknown direction stays unknown; at most ask for the missing context.", "Short literal explanation plus bounded uncertainty, no motive enumeration.") },
  { id: "explicit-comfort-intent", covers: ["identity-quote", "picture-irony"], speaker, bitmap: "good",
    input: "\u4e00\u53e5\u8bdd\u89e3\u91ca\u8fd9\u56fe",
    quote: quote("\u5c0f\u6797\u8bf4\u8003\u8bd5\u6ca1\u8fc7\uff1b\u6211\u53d1\u8fd9\u56fe\u662f\u60f3\u5b89\u6170\u4ed6\uff0c\u4e0d\u662f\u5728\u5632\u7b11\u4ed6\u3002", P5_FIXTURE.peerId),
    rubric: rubric("Peer 60151 explicitly states their own comforting intent toward Lin; do not attribute it to current 60150.",
      "Exam failure remains failure; comforting intent is a stated source claim, not independently verified psychology.",
      "May mention comfort only because explicit text supplies it; do not replace that statement with invented sarcasm/hostility.",
      "Do not generalize this intent to the no-context or other picture cases.", "One short sentence with clear attribution.") },
  { id: "current-correction-topic", covers: ["current-priority", "memory-correction"], speaker, bitmap: null,
    input: "\u4ee5\u540e\u53eb\u6211\u5c0f\u590f\uff1b\u5148\u4e0d\u804a\u4e0b\u8f7d\u4e86\uff0c17 \u52a0 25 \u662f\u591a\u5c11\uff1f",
    turns: P5_FIXTURE.failedTurns, background: ["speaker=\u5c0f\u6797 uid=60150: \u6211\u4e4b\u524d\u53eb\u5c0f\u6797\u3002"],
    rubric: rubric("Use current preferred name Xia, not old Lin.", "17 + 25 = 42; current nickname is explicit, not a persisted-note claim.",
      "Answer arithmetic; do not continue download troubleshooting.", "Current naming correction overrides old nickname.", "Brief acknowledgement and answer, no follow-up question.") },
  { id: "same-name-quote", covers: ["identity-quote"], speaker, bitmap: null,
    input: "\u4ed6\u8bf4\u7684\u662f\u6211\u4e5f\u5df2\u7ecf\u4fee\u597d\u4e86\u5417\uff1f",
    quote: quote("\u6211\u6362\u4e86\u663e\u793a\u5668\u7ebf\uff0c\u8fd8\u662f\u9ed1\u5c4f\u3002"),
    rubric: rubric("Address current 60150; quoted same-name 60151 is a different person.",
      "Peer only reports that changing cable did not solve black screen; user's own result is unknown.",
      "Answer the attribution question without inventing a successful repair or personal experience.", "No correction supplied; do not invent one.", "One or two useful short sentences.") },
]);

// Consumer contract for the parent's private true-API runner. No image description,
// stable system prompt, current input frame or paid executor is included in history.
export async function getP5QualityFixtures() {
  const fixtures = [];
  for (const probe of P5_MODEL_PROBES) {
    const packet = await buildP5ProbePacket(probe, { includeImageDescription: false });
    fixtures.push({ id: probe.id, history: packet.history, input: probe.input, bitmap: probe.bitmap,
      rubric: { ...probe.rubric } });
  }
  return fixtures;
}

export const P5_REVIEW_POLICY = Object.freeze({
  method: "human", scale: { 0: "contradiction or material miss", 1: "partly meets the declared criterion", 2: "fully meets the declared criterion" },
  blockers: ["privacy_overreach", "private_reasoning_exposed", "wrong_recipient", "duplicate_send", "fabricated_execution"],
  acceptance: "Parent predeclares evidence-v4 gray rules. No blocker; every applicable dimension needs input/output evidence, not a keyword count. N/A requires a written reason.",
  paidExecution: "Parent only, after final commit, with a separately persisted hard physical-attempt/token budget; this module has no replay executor.",
});

export async function buildP5ProbePacket(probe, options = {}) {
  const { buildModelPrompt } = await import("../bridge/system-prompts/compose.mjs");
  const { buildCurrentInput, buildQuotedMessageBlock, buildUnavailableQuoteBlock, buildGroupBackgroundBlock } =
    await import("../bridge/context/messages.mjs");
  const { selectConversationThread } = await import("../bridge/context/conversation-selection.mjs");
  const { formatConversationThreadLayers } = await import("../bridge/cognition/thread-manager.mjs");
  const { assignContextGroups } = await import("../bridge/context/source-groups.mjs");
  const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
  const { buildImageContextMessage } = await import("../bridge/system-prompts/image-context.mjs");
  const layers = [];
  if (probe.quote) {
    const source = probe.quote.source;
    layers.push({ role: "user", contextPriority: 100, contextAtomic: true,
      content: source.state === "unavailable" ? buildUnavailableQuoteBlock()
        : buildQuotedMessageBlock(probe.quote.text, probe.quote.speaker, source),
      contextSources: source.state === "unavailable" ? [] : [{ kind: "quote", reason: "reply_chain", verified: true,
        userId: source.userId, messageId: source.messageId, at: source.at }] });
  }
  const thread = selectConversationThread({ scope: "synthetic", turns: probe.turns || [] }, { userMsg: probe.input });
  for (const layer of formatConversationThreadLayers(thread)) layers.push({ role: "user", content: layer.content,
    contextPriority: 88, contextAtomic: true });
  if (probe.background) layers.push({ role: "user", content: buildGroupBackgroundBlock(probe.background), contextPriority: 40, contextAtomic: true });
  if (probe.bitmap && options.includeImageDescription !== false) layers.push({
    ...buildImageContextMessage("Visible text: " + P5_BITMAP_LABELS[probe.bitmap] + "."), contextPriority: 95 });
  const currentInput = buildCurrentInput(probe.speaker.name, probe.input, probe.speaker.userId, { hasQuote: Boolean(probe.quote) });
  const mode = probe.replyMode === "interjection" ? "interjection" : "group-at";
  const bounded = enforceContextBudget(assignContextGroups(layers), currentInput, { mode });
  const prompt = buildModelPrompt({ replyMode: probe.replyMode || "chat", mood: "\u6b63\u5e38" });
  const messages = [{ role: "system", content: prompt.system }, prompt.dynamicMessage,
    ...bounded.messages, { role: "user", content: currentInput }];
  return { messages, history: bounded.messages, budget: bounded.budget, sources: bounded.sources, promptMetadata: prompt.metadata,
    fingerprint: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    evidenceKind: probe.bitmap && options.includeImageDescription !== false ? "synthetic_text_and_descriptions" : "synthetic_text_only",
    callsModel: false, sendsMessage: false };
}

export function createP5ProbeRecord(probe, packet, candidateCommit = null) {
  return { schema: 1, caseId: probe.id, synthetic: true, covers: [...probe.covers], inputFingerprint: packet.fingerprint,
    evidenceKind: packet.evidenceKind, promptMetadata: { ...packet.promptMetadata }, candidateCommit,
    rubric: { ...probe.rubric }, baseline: unobservedAnswer(), candidate: unobservedAnswer(),
    review: { method: "human", status: "unreviewed", reviewer: null, evidence: [],
      scores: Object.fromEntries(Object.keys(probe.rubric).map(key => [key, null])),
      blockers: Object.fromEntries(P5_REVIEW_POLICY.blockers.map(key => [key, "unknown"])), verdict: "not_verified" } };
}

function unobservedAnswer() {
  return { status: "not_run", cleanedFinalText: null, provider: null, position: null, model: null, requestedReasoningMode: null,
    effectiveReasoningMode: null, at: null, inputFingerprint: null, evidence: [],
    calls: { logical: null, transportAttempts: null, primary: null, fallback: null, toolRounds: null },
    usage: { promptTokens: null, cachedTokens: null, cacheCreationTokens: null, completionTokens: null, reasoningTokens: null,
      totalTokens: null, durationMs: null, reported: { prompt: false, cache: false, cacheCreation: false, completion: false,
        reasoning: false, total: false, duration: false }, attempts: [] } };
}
