import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CFG } from "../config.mjs";
import { VERSION } from "../version.mjs";
import { callTaskApi } from "../api-providers/gateway.mjs";
import { enforceContextBudget } from "../context/budget.mjs";
import { buildCurrentInput, buildGroupBackgroundBlock, buildQuotedMessageBlock, formatSpeakerLine } from "../context/messages.mjs";
import { formatConversationThreadBlock } from "../cognition/thread-manager.mjs";
import { buildChatSystemPrompt } from "../system-prompts/chat.mjs";
import { buildImageContextMessage } from "../system-prompts/image-context.mjs";
import { buildOutputPacket } from "../output-pipeline.mjs";
import { REPLAY_CASES } from "./replay-cases.mjs";
import { selectConversationThread, selectGroupConversation, selectionSource } from "../context/conversation-selection.mjs";
import { retrieveRelevantUserMemories } from "../context-retriever.mjs";

const REVIEWS = new Set(["unreviewed", "better", "same", "worse", "off_topic", "wrong_person", "over_persona"]);
const DAILY_LIMIT = 20;

export function buildReplayPacket(example) {
  const layers = [];
  if (example.quote) layers.push({ role: "user", content: buildQuotedMessageBlock(example.quote, "示例发言人"), contextPriority: 100 });
  const thread = selectConversationThread({ scope: "synthetic", turns: example.turns }, { userMsg: example.input });
  if (thread) layers.push({ role: "user", content: formatConversationThreadBlock(thread), contextPriority: 88 });
  if (example.background) layers.push({ role: "user", content: buildGroupBackgroundBlock(example.background), contextPriority: 40 });
  if (example.image !== undefined) layers.push({ ...buildImageContextMessage(example.image), contextPriority: 95 });
  appendReplayRetrieval(layers, example);
  const currentInput = buildCurrentInput("示例用户", example.input, "11");
  const bounded = enforceContextBudget(layers, currentInput, { mode: "group-at" });
  const messages = [
    { role: "system", content: buildChatSystemPrompt({ mood: "正常" }) },
    ...bounded.messages,
    { role: "user", content: currentInput },
  ];
  return {
    messages, budget: bounded.budget, sources: bounded.sources,
    fingerprint: createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16),
  };
}

function appendReplayRetrieval(layers, example) {
  if (example.memoryRows) {
    const memories = retrieveRelevantUserMemories("11", example.input, {
      users: { "11": { chats: example.memoryRows } }, groupId: "synthetic",
    });
    layers.push({ role: "user", contextPriority: 70,
      content: "[当前发言人相关记忆]\n" + memories.map(formatSpeakerLine).join("\n"),
      contextSources: memories.map(item => selectionSource(item, "memory", item.matchReason, item.score)),
    });
  }
  if (example.groupRows) {
    const selected = selectGroupConversation(example.groupRows, {
      userMsg: example.input, replyText: example.quote, replyToMessageId: example.replyToMessageId, now: 5000,
    });
    layers.push({ role: "user", contextPriority: 40,
      content: buildGroupBackgroundBlock(selected.items.map(item => formatSpeakerLine(item.message))),
      contextSources: selected.items.map(item => selectionSource(item.message, "group", item.reason, item.score)),
    });
  }
}

export function runReplayChecks() {
  const checks = REPLAY_CASES.map(example => {
    const packet = buildReplayPacket(example);
    return {
      id: example.id, name: example.name,
      ok: packet.budget.chars <= packet.budget.maxChars &&
        packet.messages.at(-1).content.includes(example.input) &&
        packet.messages.at(-1).content.includes("reply_target=当前发言人") && replaySelectionMatches(example, packet),
    };
  });
  checks.push({ id: "reasoning-only", name: "推理字段不能成为正文", ok: !buildOutputPacket({ content: "", reasoning_content: "private synthetic reasoning" }).ok });
  checks.push({ id: "final-only", name: "只采用最终正文", ok: buildOutputPacket({ content: "答案是 42。", reasoning_content: "private synthetic reasoning" }).text === "答案是 42。" });
  return { ok: checks.every(item => item.ok), checks, callsModel: false, sendsMessage: false };
}

function replaySelectionMatches(example, packet) {
  const sourceIds = new Set(packet.sources.map(item => item.messageId));
  return (example.expectedSources || []).every(id => sourceIds.has(id)) &&
    (example.excludedSources || []).every(id => !sourceIds.has(id)) &&
    (!example.excludedContext || !JSON.stringify(packet.messages).includes(example.excludedContext));
}

export function createReplayService(options = {}) {
  const filename = options.filename || path.join(CFG.dataRoot, ".qqfriend", "diagnostics", "replay.json");
  const callModel = options.callModel || callTaskApi;
  const now = options.now || Date.now;
  let busy = false;

  function load() {
    try {
      if (fs.statSync(filename).size > 256 * 1024) throw new Error("回放记录过大");
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (value.schema !== 1 || !value.cases || typeof value.cases !== "object") throw new Error("回放记录格式异常");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, cases: {}, day: "", runs: 0 };
      throw new Error("回放记录读取失败，请检查服务器数据目录", { cause: error });
    }
  }

  function save(value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = filename + ".tmp." + process.pid;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, filename);
  }

  function snapshot() {
    const saved = load();
    return {
      version: VERSION, synthetic: true, busy, dailyLimit: DAILY_LIMIT,
      todayRuns: saved.day === dayKey(now()) ? saved.runs : 0,
      cases: REPLAY_CASES.map(example => ({
        ...example, packet: buildReplayPacket(example),
        baseline: publicAnswer(saved.cases[example.id]?.baseline),
        candidate: publicAnswer(saved.cases[example.id]?.candidate),
        review: safeReview(saved.cases[example.id]?.review),
      })),
    };
  }

  async function act(payload = {}) {
    if (payload.action === "check") return runReplayChecks();
    const example = REPLAY_CASES.find(item => item.id === payload.caseId);
    if (!example) throw new Error("请选择已有的合成样例");
    if (busy) throw new Error("已有回放正在生成，请稍后再试");
    if (payload.action === "generate") {
      busy = true;
      try { return await generate(example); } finally { busy = false; }
    }
    const saved = load();
    const entry = saved.cases[example.id];
    if (!entry?.candidate) throw new Error("请先生成候选回复");
    if (payload.action === "baseline") entry.baseline = { ...entry.candidate };
    else if (payload.action === "review" && REVIEWS.has(payload.review)) entry.review = payload.review;
    else throw new Error("不支持的回放操作");
    save(saved);
    return snapshot();
  }

  async function generate(example) {
    const saved = load();
    const day = dayKey(now());
    const runs = saved.day === day ? Number(saved.runs || 0) : 0;
    if (runs >= DAILY_LIMIT) throw new Error("今天已完成 20 次回放生成，请明天再试");
    // Reserve the attempt before network access so restarts cannot bypass the limit.
    Object.assign(saved, { day, runs: runs + 1 });
    save(saved);
    const packet = buildReplayPacket(example);
    const answer = await generateAnswer(packet, callModel);
    const entry = saved.cases[example.id] || {};
    entry.candidate = { ...answer, fingerprint: packet.fingerprint, version: VERSION, at: new Date(now()).toISOString() };
    entry.review = "unreviewed";
    saved.cases[example.id] = entry;
    save(saved);
    return snapshot();
  }

  return { snapshot, act };
}

async function generateAnswer(packet, callModel) {
  for (const position of ["primary", "fallback"]) {
    let result;
    try {
      result = await callModel("group_chat", position, {
        messages: packet.messages, maxTokens: 1200, temperature: 0.2, tools: [], timeoutMs: 45000,
      }, { reasoningMode: "economy" });
    } catch { continue; }
    const output = result.ok ? buildOutputPacket(result.raw, { provider: result.provider }) : null;
    if (output?.ok) return {
      text: output.text.slice(0, 5000), provider: safeProvider(result.provider), position,
      durationMs: Math.max(0, Number(result.durationMs || 0)),
    };
  }
  throw new Error("主模型和备用模型都未产生可用正文，已有对照保留");
}

function safeProvider(value) {
  return /^[a-z][a-z0-9_-]{0,47}$/i.test(value || "") && !/^sk-/i.test(value) ? value : "configured";
}

function publicAnswer(value) {
  if (!value) return null;
  return {
    text: String(value.text || "").slice(0, 5000), provider: safeProvider(value.provider),
    position: value.position === "fallback" ? "fallback" : "primary",
    fingerprint: String(value.fingerprint || "").slice(0, 16),
    version: String(value.version || "").slice(0, 64), at: String(value.at || "").slice(0, 32),
    durationMs: Math.max(0, Number(value.durationMs || 0)),
  };
}

function safeReview(value) { return REVIEWS.has(value) ? value : "unreviewed"; }
function dayKey(timestamp) { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10); }

export const replayService = createReplayService();
