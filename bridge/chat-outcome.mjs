import { buildOutputPacket } from "./output-pipeline.mjs";
import { normalizeInterjectionReply } from "./thinking.mjs";
import { chatCancellation, chatRunStopReason } from "./cognition/chat-run.mjs";

export const MODEL_FAILURE_NOTICE = "这次模型没有生成可用回复，请稍后再试。";
const ERROR_REASONS = new Set(["model_unavailable", "request_failed", "tools_unavailable", "invalid_interjection",
  "empty_content", "empty_content_with_reasoning", "unsafe_reasoning", "secret_leak", "output_budget"]);

export function chatError(reason = "model_unavailable") {
  return { kind: "error", text: null, reason: ERROR_REASONS.has(reason) ? reason : "model_unavailable" };
}

export function parseChatOutcome(raw, options = {}) {
  const packet = buildOutputPacket(raw, options);
  if (!packet.ok) return chatError(packet.reason);
  if (options.replyMode !== "interjection") return { kind: "reply", text: packet.text, reason: "reply" };
  if (packet.wasTruncated) return chatError("invalid_interjection");
  const value = packet.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (value.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { return chatError("invalid_interjection"); }
    if (!parsed || typeof parsed.reply !== "string") return chatError("invalid_interjection");
    if (!parsed.reply.trim()) return { kind: "silence", text: null, reason: "intentional_silence" };
  }
  const text = normalizeInterjectionReply(packet.text);
  return text ? { kind: "reply", text, reason: "reply" } : chatError("invalid_interjection");
}

// Legacy injected providers may still return text/null; the live router uses outcomes.
export function normalizeChatOutcome(value) {
  if (value?.kind === "cancelled") return chatCancellation(value.reason);
  if (value?.kind === "silence") return { kind: "silence", text: null, reason: "intentional_silence" };
  if (value?.kind === "error") return chatError(value.reason || "model_unavailable");
  // Typed replies have already crossed the output boundary; legacy strings have not.
  if (value?.kind === "reply" && typeof value.text === "string" && value.text.trim()) {
    const memorySources = validMemorySources(value.memorySources);
    return { kind: "reply", text: value.text, reason: "reply", ...(memorySources.length ? { memorySources } : {}) };
  }
  return typeof value === "string" && value.trim() ? parseChatOutcome({ content: value }) : chatError();
}

function validMemorySources(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => /^[a-f0-9]{12}$/.test(item?.noteId || "") && Number.isSafeInteger(item.revision) && item.revision > 0)
    .slice(0, 32).map(item => ({ noteId: item.noteId, revision: item.revision }));
}

export async function callChatSlot(call, request) {
  if (chatRunStopReason()) return chatCancellation();
  try {
    const result = await call(request);
    return chatRunStopReason() ? chatCancellation() : normalizeChatOutcome(result);
  } catch {
    return chatRunStopReason() ? chatCancellation() : chatError("request_failed");
  }
}
