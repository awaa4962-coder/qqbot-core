import { log, logE } from "../logger.mjs";
import {
  MODEL_TASKS,
  callTaskRawProvider,
} from "../model-router.mjs";
import { buildOutputPacket } from "../output-pipeline.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { buildLocalSummaryFallback } from "./fallback.mjs";
import { buildGroupSummaryPrompt, summarySystemPrompt } from "./prompt.mjs";

async function callMiMoSummary(prompt) {
  return await callTaskRawProvider(MODEL_TASKS.GROUP_SUMMARY, "primary", {
    task: MODEL_TASKS.GROUP_SUMMARY,
    systemPrompt: summarySystemPrompt(),
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2048,
    timeoutMs: 60000,
  });
}

async function callDeepSeekSummary(prompt) {
  return await callTaskRawProvider(MODEL_TASKS.GROUP_SUMMARY, "fallback", {
    task: MODEL_TASKS.GROUP_SUMMARY,
    systemPrompt: summarySystemPrompt(),
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2048,
    temperature: 0.7,
    timeoutMs: 60000,
  });
}

function parseSummaryPacket(raw, provider) {
  const packet = buildOutputPacket(raw, { provider });
  log("group summary " + provider + " packet:", JSON.stringify({
    ok: packet.ok,
    finishReason: packet.finishReason,
    risks: packet.risks,
    lengths: packet.lengths,
  }));
  return packet.ok ? packet.text : null;
}

export async function generateGroupSummaryResult(messages, options = {}) {
  if (!messages.length) return { text: null, provider: "none", digest: null };
  const lowMessageLimit = Number(options.lowMessageLimit ?? 8);
  const digest = options.digest || buildSummaryDigest(messages);
  if (messages.length < lowMessageLimit) {
    return {
      text: buildLocalSummaryFallback(messages, { ...options, digest }),
      provider: "local-low-data",
      digest,
    };
  }

  const prompt = buildGroupSummaryPrompt(messages, { ...options, digest });
  const callMimo = options.callMiMoSummary || callMiMoSummary;
  const callDeepSeek = options.callDeepSeekSummary || callDeepSeekSummary;
  try {
    const mimoRaw = await callMimo(prompt);
    const mimoText = parseSummaryPacket(mimoRaw, "mimo");
    if (mimoText) return { text: mimoText, provider: "mimo", digest };
  } catch (error) {
    logE("group summary MiMo failed:", error.message);
  }

  try {
    const dsRaw = await callDeepSeek(prompt);
    const dsText = dsRaw ? parseSummaryPacket(dsRaw, "deepseek") : null;
    if (dsText) return { text: dsText, provider: "deepseek", digest };
  } catch (error) {
    logE("group summary DeepSeek failed:", error.message);
  }
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
