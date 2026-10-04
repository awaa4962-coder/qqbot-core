import crypto from "node:crypto";
import { perceptualImageHash } from "../../knowledge/memes/image-context.mjs";
import { log, logE } from "../../logger.mjs";
import { fetchSafeBuffer } from "../../safe-url.mjs";
import { callVisionText } from "../../vision-provider.mjs";
import { buildStickerAnalysisPrompt } from "../../system-prompts/stickers.mjs";
import {
  applyStickerAnalysis,
  findStickerByFingerprint,
  listPendingStickerAnalysis,
  markStickerAnalysisFailure,
} from "./catalog-store.mjs";
import { normalizeStickerTags } from "./schema.mjs";
import { loadStickerPreview } from "./preview.mjs";
import { createStickerPrivacyGuard } from "./privacy.mjs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let analysisPromise = null;

export async function analyzePendingStickers(options = {}) {
  if (analysisPromise) return analysisPromise;
  analysisPromise = runPendingAnalysis(options).finally(() => {
    analysisPromise = null;
  });
  return analysisPromise;
}

export async function analyzeStickerEntry(entry, options = {}) {
  const privacyGuard = options.privacyGuard || createStickerPrivacyGuard();
  const check = () => { privacyGuard(); options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  check();
  const download = options.download
    ? () => options.download(entry.url, { signal: options.signal, assertCurrent: check })
    : () => downloadStickerEntry(entry, { ...options, assertCurrent: check });
  const describe = options.describe || describeStickerWithVision;
  const data = await download();
  check();
  const fingerprint = await perceptualImageHash(data.buffer);
  check();
  const md5 = crypto.createHash("md5").update(data.buffer).digest("hex");
  const existing = findStickerByFingerprint(fingerprint, entry.id, { md5 });
  if (existing) {
    return {
      fingerprint,
      md5,
      description: existing.description,
      tags: existing.tags,
      reused: true,
    };
  }

  const modelResult = await describe({
    buffer: data.buffer,
    mimeType: data.mimeType,
    url: entry.url,
  }, { ...options, assertCurrent: check });
  check();
  const normalized = normalizeAnalysis(modelResult);
  if (!normalized.description) throw new Error("视觉模型没有返回可用描述");
  return { fingerprint, md5, ...normalized, reused: false };
}

export function normalizeAnalysis(value) {
  if (value && typeof value === "object") {
    const description = cleanDescription(value.description || value.summary);
    return {
      description,
      tags: ensureTags(value.tags, description),
    };
  }
  const text = String(value || "").trim();
  const parsed = parseJsonObject(text);
  if (parsed) return normalizeAnalysis(parsed);
  const description = cleanDescription(text);
  return {
    description,
    tags: ensureTags([], description),
  };
}

export function inferStickerTags(text) {
  const value = String(text || "");
  const rules = [
    ["无语", /无语|白眼|沉默|看傻|嫌弃|无奈/],
    ["吐槽", /吐槽|阴阳|嘲讽|反问|锐评/],
    ["惊讶", /惊讶|震惊|吓|目瞪口呆|不可思议/],
    ["开心", /开心|高兴|欢呼|笑容|庆祝/],
    ["搞笑", /搞笑|爆笑|大笑|滑稽|乐|绷不住/],
    ["生气", /生气|愤怒|哈气|炸毛|恼火/],
    ["难过", /难过|伤心|哭|委屈|落泪/],
    ["害羞", /害羞|脸红|扭捏/],
    ["安慰", /安慰|抱抱|摸头|别难过/],
    ["撒娇", /撒娇|卖萌|可怜巴巴/],
    ["感谢", /感谢|谢谢|感激/],
    ["鼓励", /鼓励|加油|支持|可以的/],
    ["赞同", /赞同|同意|点头|确实|没错/],
  ];
  return rules.filter(([, pattern]) => pattern.test(value)).map(([tag]) => tag);
}

async function runPendingAnalysis(options) {
  const privacyGuard = createStickerPrivacyGuard();
  const check = () => { privacyGuard(); options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  const entries = listPendingStickerAnalysis({
    limit: options.limit || 6,
    now: options.now,
  });
  let analyzed = 0;
  let reused = 0;
  let failed = 0;
  try {
    check();
    for (const entry of entries) {
      try {
        check();
        const result = await analyzeStickerEntry(entry, { ...options, privacyGuard });
        check();
        applyStickerAnalysis(entry.id, result, { now: options.now });
        check();
        if (result.reused) reused++;
        else analyzed++;
      } catch (error) {
        check();
        if (analysisCancellation(error, options.signal)) throw error;
        failed++;
        markStickerAnalysisFailure(entry.id, error, { now: options.now });
        logE("sticker analysis failed:", entry.id, error.message);
      }
    }
    check();
  } catch (error) {
    const cancelled = analysisCancellation(error, options.signal);
    if (!cancelled) throw error;
    return { ...cancelled, requested: entries.length, analyzed, reused, failed };
  }
  if (entries.length) log("sticker analysis batch:", analyzed, "analyzed,", reused, "reused,", failed, "failed");
  return { requested: entries.length, analyzed, reused, failed };
}

function analysisCancellation(error, signal) {
  if (error?.code === "STICKER_PRIVACY_CHANGED") {
    return { ok: false, error: "资料已更新，旧表情分析已停止", cancelled: true, reason: "privacy_changed" };
  }
  if (signal?.aborted || error?.name === "AbortError" || error?.code === "CHAT_CANCELLED" ||
      (error?.code === "MODEL_TASK_BUDGET" && error.message === "task_cancelled")) {
    return { ok: false, error: "表情分析已取消", cancelled: true, reason: "task_cancelled" };
  }
  return null;
}

async function downloadStickerEntry(entry, options) {
  options.assertCurrent();
  const preview = await loadStickerPreview(entry.id, {
    timeoutMs: 12000,
    maxBytes: MAX_IMAGE_BYTES,
    fetchImage: async (url, downloadOptions) => {
      options.assertCurrent();
      const data = await (options.fetchImage || fetchSafeBuffer)(url, { ...downloadOptions, signal: options.signal });
      options.assertCurrent();
      return data;
    },
  });
  options.assertCurrent();
  if (!preview.ok) throw new Error("表情图片下载失败或被安全策略拦截");
  return preview;
}

async function describeStickerWithVision(image, options = {}) {
  const dataUrl = "data:" + image.mimeType + ";base64," + image.buffer.toString("base64");
  const request = {
    ...buildStickerAnalysisPrompt(dataUrl),
    maxTokens: 220,
    temperature: 0.2,
    timeoutMs: 30000,
    thinking: { type: "disabled" },
    tools: [],
  };
  const result = await callVisionText(request, options);
  if (!result.ok) throw new Error("视觉模型输出不可用");
  return result.text;
}

function parseJsonObject(text) {
  const value = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function cleanDescription(value) {
  return [...String(value || "")]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function ensureTags(tags, description) {
  const normalized = normalizeStickerTags(tags);
  const inferred = inferStickerTags(description);
  const result = [...new Set(normalized.concat(inferred))].slice(0, 8);
  return result.length ? result : ["其他"];
}
