import crypto from "node:crypto";
import sharp from "sharp";
import { callTaskApi } from "../../api-providers/gateway.mjs";
import { perceptualImageHash } from "../../knowledge/memes/image-context.mjs";
import { buildOutputPacket } from "../../output-pipeline.mjs";
import { inferStickerTags } from "./analyzer.mjs";
import { normalizeStickerTags } from "./schema.mjs";

const KINDS = new Set(["sticker", "photo", "screenshot", "other", "unknown"]);

export async function classifyStickerCandidate(image = {}, options = {}) {
  const buffer = Buffer.isBuffer(image.buffer) ? image.buffer : null;
  if (!buffer?.length) throw new Error("候选图片为空");
  const metadata = await sharp(buffer, { animated: true }).metadata();
  const fingerprint = await perceptualImageHash(buffer);
  const md5 = crypto.createHash("md5").update(buffer).digest("hex");
  const hardReject = hardRejectReason(metadata);
  if (hardReject) {
    return {
      classification: "other",
      confidence: 1,
      description: hardReject,
      tags: ["其他"],
      fingerprint,
      md5,
      metadata: publicMetadata(metadata),
    };
  }

  try {
    const classify = options.classify || classifyWithVision;
    const model = normalizeClassification(await classify({
      buffer,
      mimeType: image.mimeType,
      metadata,
    }));
    return {
      ...model,
      fingerprint,
      md5,
      metadata: publicMetadata(metadata),
    };
  } catch {
    return {
      ...heuristicClassification(metadata, buffer.length),
      fingerprint,
      md5,
      metadata: publicMetadata(metadata),
    };
  }
}

export function normalizeClassification(value) {
  const source = typeof value === "string" ? parseJsonObject(value) || {} : value || {};
  const classification = KINDS.has(String(source.kind || source.classification || "").toLowerCase())
    ? String(source.kind || source.classification).toLowerCase()
    : "unknown";
  const description = String(source.description || source.summary || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const tags = [...new Set(
    normalizeStickerTags(source.tags).concat(inferStickerTags(description))
  )].slice(0, 8);
  return {
    classification,
    confidence: Math.max(0, Math.min(1, Number(source.confidence || 0))),
    description,
    tags: tags.length ? tags : ["其他"],
  };
}

async function classifyWithVision(image) {
  const dataUrl = "data:" + image.mimeType + ";base64," + image.buffer.toString("base64");
  const request = {
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: [
          "判断这张群聊图片是不是适合当聊天表情包。不要替用户回复。",
          "kind 只能是 sticker、photo、screenshot、other、unknown。",
          "sticker 指用于表达情绪、态度、反应或梗的表情图；普通照片和普通截图不能算 sticker。",
          "输出严格 JSON：{\"kind\":\"sticker\",\"confidence\":0.95,\"description\":\"不超过60字的聊天含义\",\"tags\":[\"1到4个标签\"]}。",
          "无法确认人物身份时不要猜；不要输出分析过程。",
        ].join("\n"),
      }, {
        type: "image_url",
        image_url: { url: dataUrl },
      }],
    }],
    maxTokens: 240,
    temperature: 0.1,
    timeoutMs: 30000,
    thinking: { type: "disabled" },
    tools: [],
  };
  let result = await callTaskApi("vision", "primary", request);
  if (!result.ok) result = await callTaskApi("vision", "fallback", request);
  if (!result.ok) throw new Error(result.error || "视觉分类不可用");
  const packet = buildOutputPacket(result.raw, { provider: result.provider });
  if (!packet.ok) throw new Error("视觉分类输出不可用");
  return packet.text;
}

function hardRejectReason(metadata) {
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return "无法读取图片尺寸";
  if (width < 24 || height < 24) return "图片尺寸过小";
  if (width > 4096 || height > 4096 || width * height > 12_000_000) return "图片尺寸过大";
  return "";
}

function heuristicClassification(metadata, bytes) {
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const ratio = width / Math.max(1, height);
  const animated = Number(metadata.pages || 1) > 1;
  const stickerLike = ratio >= 0.35 && ratio <= 2.8 && width <= 1200 && height <= 1200 && bytes <= 3 * 1024 * 1024;
  return {
    classification: stickerLike ? "unknown" : "other",
    confidence: animated && stickerLike ? 0.68 : stickerLike ? 0.45 : 0.7,
    description: animated && stickerLike ? "疑似动态聊天表情，等待更多使用证据" : "视觉模型未确认",
    tags: ["其他"],
  };
}

function publicMetadata(metadata) {
  return {
    width: Number(metadata.width || 0),
    height: Number(metadata.height || 0),
    pages: Number(metadata.pages || 1),
    format: String(metadata.format || ""),
  };
}

function parseJsonObject(text) {
  const value = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}
