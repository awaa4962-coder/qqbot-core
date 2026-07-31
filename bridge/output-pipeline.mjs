import { log } from "./logger.mjs";
import { cleanThinking, isUnsafeReasoningText } from "./thinking.mjs";

const TRUNCATED_HINT = "……（这段可能被模型截断了，发“继续”我接着说）";

function asText(value) {
  return typeof value === "string" ? value : "";
}

function firstChoice(raw) {
  return raw?.choices?.[0] || null;
}

function messageFromRaw(raw) {
  if (!raw) return null;
  if (raw.message) return raw.message;
  const choice = firstChoice(raw);
  if (choice?.message) return choice.message;
  if (typeof raw.content === "string" || typeof raw.reasoning_content === "string") return raw;
  return null;
}

function finishReasonFromRaw(raw, options) {
  return options.finishReason ||
    firstChoice(raw)?.finish_reason ||
    firstChoice(raw)?.finishReason ||
    raw?.finish_reason ||
    raw?.finishReason ||
    null;
}

function usageFromRaw(raw, options) {
  return options.usage || raw?.usage || null;
}

export function extractAssistantContent(raw, options = {}) {
  const provider = options.provider || raw?.provider || "unknown";
  const msg = messageFromRaw(raw);
  const content = asText(msg?.content);
  const reasoning = asText(msg?.reasoning_content);

  if (reasoning.trim()) {
    log("output-pipeline: reasoning_content ignored (" + reasoning.length + " chars)");
  }

  return {
    content: content.trim() ? content : null,
    provider,
    finishReason: finishReasonFromRaw(raw, options),
    usage: usageFromRaw(raw, options),
    rawLength: content.length,
    reasoningLength: reasoning.length,
  };
}

export function sanitizeAssistantReply(text, _options = {}) {
  const cleaned = cleanThinking(text);
  if (!cleaned) return null;
  if (isUnsafeReasoningText(cleaned)) return null;
  return cleaned;
}

export function detectOutputRisk(text, _options = {}) {
  const risks = [];
  if (!text || typeof text !== "string" || !text.trim()) risks.push("empty");
  if (isUnsafeReasoningText(text)) risks.push("reasoning_leak");
  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{12,}/i,
    /(?:api[_-]?key|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/i,
  ];
  if (secretPatterns.some(pattern => pattern.test(text))) {
    risks.push("secret_leak");
  }
  return risks;
}

export function normalizeFinalReply(text, options = {}) {
  const cleaned = sanitizeAssistantReply(text, options);
  if (!cleaned) return null;
  if (options.finishReason === "length" && !cleaned.endsWith(TRUNCATED_HINT)) {
    return cleaned + "\n" + TRUNCATED_HINT;
  }
  return cleaned;
}

export function buildOutputPacket(raw, options = {}) {
  const meta = extractAssistantContent(raw, options);
  const lengths = {
    raw: meta.rawLength || 0,
    cleaned: 0,
    final: 0,
  };

  if (!meta.content) {
    return {
      ok: false,
      text: null,
      provider: meta.provider,
      finishReason: meta.finishReason,
      reason: meta.reasoningLength ? "empty_content_with_reasoning" : "empty_content",
      risks: meta.reasoningLength ? ["reasoning_content_only"] : ["empty"],
      lengths,
    };
  }

  const cleaned = sanitizeAssistantReply(meta.content, options);
  lengths.cleaned = cleaned ? cleaned.length : 0;
  const risks = cleaned ? detectOutputRisk(cleaned, options) : ["reasoning_leak"];
  if (!cleaned || risks.includes("reasoning_leak") || risks.includes("secret_leak")) {
    return {
      ok: false,
      text: null,
      provider: meta.provider,
      finishReason: meta.finishReason,
      reason: risks.includes("secret_leak") ? "secret_leak" : "unsafe_reasoning",
      risks,
      lengths,
    };
  }

  const finalText = normalizeFinalReply(cleaned, { ...options, finishReason: meta.finishReason });
  lengths.final = finalText ? finalText.length : 0;
  return {
    ok: Boolean(finalText),
    text: finalText,
    provider: meta.provider,
    finishReason: meta.finishReason,
    wasTruncated: meta.finishReason === "length",
    risks: [],
    lengths,
    usage: meta.usage,
  };
}
