import { log, logE } from "../logger.mjs";
import {
  MODEL_TASKS,
  callTaskProviderResult,
} from "../model-router.mjs";
import { buildOutputPacket } from "../output-pipeline.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { buildLocalSummaryFallback } from "./fallback.mjs";
import { buildGroupSummaryPrompt, summarySystemPrompt } from "./prompt.mjs";

const SUMMARY_TEMPERATURE = 0.3;
const SUMMARY_PRIMARY_MAX_TOKENS = 8192;
const SUMMARY_RECOVERY_MAX_TOKENS = 3072;

async function callPrimarySummary(prompt) {
  return await callSummarySlot("primary", prompt, {
    maxTokens: SUMMARY_PRIMARY_MAX_TOKENS,
  });
}

async function callFallbackSummary(prompt) {
  return await callSummarySlot("fallback", prompt, {
    maxTokens: SUMMARY_RECOVERY_MAX_TOKENS,
    reasoningMode: "economy",
  });
}

async function callSummarySlot(position, prompt, options = {}) {
  return await callTaskProviderResult(MODEL_TASKS.GROUP_SUMMARY, position, {
    task: MODEL_TASKS.GROUP_SUMMARY,
    systemPrompt: summarySystemPrompt(),
    messages: [{ role: "user", content: prompt }],
    maxTokens: options.maxTokens || SUMMARY_RECOVERY_MAX_TOKENS,
    temperature: SUMMARY_TEMPERATURE,
    timeoutMs: 120000,
  }, {
    reasoningMode: options.reasoningMode,
  });
}

function parseSummaryPacket(raw, provider, position) {
  const packet = buildOutputPacket(raw, { provider });
  log("group summary " + position + " packet:", JSON.stringify({
    provider,
    ok: packet.ok,
    finishReason: packet.finishReason,
    risks: packet.risks,
    lengths: packet.lengths,
  }));
  return packet.ok ? normalizeSummaryPresentation(packet.text) : null;
}

export async function generateGroupSummaryResult(messages, options = {}) {
  if (!messages.length) return { text: null, provider: "none", digest: null };
  const lowMessageLimit = Number(options.lowMessageLimit ?? 8);
  const digest = options.digest || buildSummaryDigest(messages, options);
  if (digest.effectiveMessageCount < lowMessageLimit) {
    return {
      text: buildLocalSummaryFallback(messages, { ...options, digest }),
      provider: "local-low-data",
      digest,
    };
  }

  const prompt = buildGroupSummaryPrompt(messages, { ...options, digest });
  const primaryCall = options.callPrimarySummary || callPrimarySummary;
  const fallbackCall = options.callFallbackSummary || callFallbackSummary;
  const primary = await trySummarySlot(primaryCall, prompt, "primary", "deepseek");
  if (primary) return { ...primary, digest };

  const fallback = await trySummarySlot(fallbackCall, prompt, "fallback", "mimo");
  if (fallback) return { ...fallback, digest };

  return {
    text: buildLocalSummaryFallback(messages, { ...options, digest }),
    provider: "local-fallback",
    digest,
  };
}

export async function generateGroupSummary(messages, options = {}) {
  const result = await generateGroupSummaryResult(messages, options);
  return result.text;
}

async function trySummarySlot(call, prompt, position, providerHint) {
  try {
    const value = await call(prompt);
    const result = normalizeCallResult(value, providerHint);
    if (!result.raw) {
      logE("group summary " + position + " unavailable:", result.error || "empty response");
      return null;
    }
    const text = parseSummaryPacket(result.raw, result.provider, position);
    return text ? { text, provider: result.provider } : null;
  } catch (error) {
    logE("group summary " + position + " failed:", error.message);
    return null;
  }
}

function normalizeCallResult(value, providerHint) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "raw")) {
    return {
      raw: value.ok === false ? null : value.raw,
      provider: String(value.provider || value.raw?.provider || providerHint),
      error: value.error || "",
    };
  }
  return {
    raw: value || null,
    provider: String(value?.provider || providerHint),
    error: "",
  };
}

function normalizeSummaryPresentation(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .split("\n")
    .filter(line => !isInternalProcessingLine(line))
    .map(normalizeSummaryLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isInternalProcessingLine(line) {
  const value = String(line || "").replace(/\s+/g, "");
  return /(?:未进入|不纳入)(?:本次)?(?:有效)?(?:讨论|分析|统计|日报)/.test(value) ||
    /(?:已被?|已经)(?:过滤|剔除|排除)/.test(value) ||
    /(?:过滤数量|证据编号|内部质量信息)/.test(value);
}

function normalizeSummaryLine(line) {
  let value = String(line || "")
    .replace(/老太婆/g, "老人")
    .replace(/(?:死妈|傻逼|草泥马|操你|艹你|他妈的|妈的|\bbyd\b)/gi, "粗口")
    .replace(/(?:讼棍|哈基民)/g, "攻击性称呼");
  if (/^\s*结果[:：].*结案/.test(value) && !/(?:未|没有|尚未|无法|口头|不代表)/.test(value)) {
    value = "结果：聊天以口头表态收尾，记录中没有足够信息确认现实处理结果。";
  }
  return value;
}
