import {
  MODEL_PROVIDERS,
  callRawModelProvider,
} from "../../model-router.mjs";
import { buildOutputPacket } from "../../output-pipeline.mjs";
import { normalizeMemeKey } from "./schema.mjs";

const SYSTEM_PROMPT = [
  "你是中文网络梗资料审核器。",
  "你只能依据请求中提供的网页证据判断，不能凭印象补全，也不能创造不存在的含义、出处或用法。",
  "普通热搜、人名、事件名、作品名、广告词和一次性句子不是网络梗。",
  "证据无法证明存在稳定的网络含义和用法时，isMeme 必须为 false。",
  "isMeme 为 true 时，evidenceIndexes 必须列出直接支持判断的证据序号；不能引用不相关页面。",
  "只输出 JSON 数组，不要解释，不要输出思考过程。",
  "每项结构：",
  '{"term":"原词","isMeme":true,"canonicalName":"规范名","aliases":[],"meaning":"不超过120字","usage":"不超过120字","examples":[],"evidenceIndexes":[0,1],"confidence":0.0,"reason":"不超过80字"}',
].join("\n");

export async function verifyMemeEvidenceBatch(candidates = [], options = {}) {
  const normalized = normalizeCandidates(candidates);
  if (!normalized.length) return [];
  const requestReview = options.requestReview || requestEvidenceReview;

  const primary = await requestReview(MODEL_PROVIDERS.PRIMARY, normalized, options);
  const parsedPrimary = parseEvidenceReview(primary, normalized, MODEL_PROVIDERS.PRIMARY);
  if (parsedPrimary) return parsedPrimary;

  const fallback = await requestReview(MODEL_PROVIDERS.FALLBACK, normalized, options);
  return parseEvidenceReview(fallback, normalized, MODEL_PROVIDERS.FALLBACK) || [];
}

async function requestEvidenceReview(provider, candidates, options = {}) {
  try {
    return await callRawModelProvider(provider, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildEvidencePrompt(candidates) }],
      maxTokens: Number(options.maxTokens || 1200),
      temperature: 0.1,
      timeoutMs: Number(options.timeoutMs || 30000),
      options: {
        allowTools: false,
        thinking: { type: "disabled" },
      },
    });
  } catch {
    return null;
  }
}

function buildEvidencePrompt(candidates) {
  const payload = candidates.map(candidate => ({
    term: candidate.term,
    trendPlatforms: candidate.platforms,
    evidence: candidate.evidence.map(item => ({
      index: candidate.evidence.indexOf(item),
      title: item.title,
      snippet: item.snippet,
      url: item.url,
    })),
  }));
  return [
    "逐项审核下面的候选词。",
    "只可使用 evidence 中的内容；没有明确解释或实际用法就拒绝。",
    JSON.stringify(payload),
  ].join("\n");
}

export function parseEvidenceReview(raw, candidates, provider = "") {
  const text = rawText(raw, provider);
  if (!text) return null;
  const items = parseReviewItems(text);
  if (!items) return null;

  const known = new Map(candidates.map(item => [normalizeMemeKey(item.term), item]));
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeMemeKey(item?.term);
    const candidate = known.get(key);
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    output.push(normalizeReviewItem(item, candidate.term, provider, candidate.evidence.length));
  }
  return output;
}

function parseReviewItems(text) {
  try {
    const value = JSON.parse(stripJsonFence(text));
    const items = Array.isArray(value) ? value : value?.results;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function normalizeReviewItem(item, originalTerm, provider, evidenceCount) {
  return {
    term: originalTerm,
    isMeme: item?.isMeme === true,
    canonicalName: clean(item?.canonicalName || originalTerm, 40),
    aliases: cleanList(item?.aliases, 12, 40),
    meaning: clean(item?.meaning, 120),
    usage: clean(item?.usage, 120),
    examples: cleanList(item?.examples, 5, 160),
    evidenceIndexes: normalizeEvidenceIndexes(item?.evidenceIndexes, evidenceCount),
    confidence: clamp(item?.confidence),
    reason: clean(item?.reason, 80),
    provider,
  };
}

function normalizeEvidenceIndexes(value, evidenceCount) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item >= 0 && item < evidenceCount))]
    .slice(0, 8);
}

function rawText(raw, provider) {
  if (typeof raw === "string") return raw.trim();
  if (!raw) return "";
  const packet = buildOutputPacket(raw, { provider });
  return packet.ok ? String(packet.text || "").trim() : "";
}

function stripJsonFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => ({
      term: clean(item?.term, 40),
      platforms: cleanList(item?.platforms, 8, 40),
      evidence: (Array.isArray(item?.evidence) ? item.evidence : [])
        .map(source => ({
          title: clean(source?.title, 160),
          snippet: clean(source?.snippet, 280),
          url: clean(source?.url, 500),
        }))
        .filter(source => source.title && source.snippet && source.url)
        .slice(0, 8),
    }))
    .filter(item => item.term && item.evidence.length);
}

function cleanList(value, limit, itemLimit) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map(item => clean(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function clean(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Number(number.toFixed(3))));
}
