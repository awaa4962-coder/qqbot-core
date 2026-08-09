import { CFG } from "./config.mjs";
import { prepareCommandText } from "./commands/normalize.mjs";
import { log } from "./logger.mjs";
import { groupChats } from "./storage.mjs";
import { normalizeMsg, cleanText } from "./context/messages.mjs";
import { mentionedUsers, parseMentions } from "./mentions/index.mjs";
import {
  getImages,
  getImageSegments,
  getFiles,
  getReplyData,
  fetchReplyData,
  sendMsg,
  sendMsgWithImage,
} from "./napcat.mjs";
import { isSuccessfulOutbound } from "./cognition/outcome.mjs";
import {
  extractLinkPreview,
  inspectAutoPreview,
  markAutoPreviewSent,
  previewAddsValue,
  recordLinkPreviewSkip,
  resolvePreviewImage,
} from "./services/link-preview/index.mjs";
import {
  buildInterjectionFallback,
  buildInterjectionDecision as buildInterjectionDecisionByPolicy,
  classifyInterjectionTrigger,
  shouldInterject as shouldInterjectByPolicy,
} from "./interjection-policy.mjs";

const interjectionState = {
  lastGroupAt: new Map(),
  lastUserAt: new Map(),
  groupMessagesSinceInterjection: new Map(),
};

export function parseIncomingEvent(ev) {
  const sender = ev.sender || {};
  const text = cleanText(ev.message);
  const images = getImages(ev.message);
  const rawText = ev.raw_message || text || "";
  const isGroup = ev.message_type === "group";
  const mentions = isGroup ? parseMentions(ev.message, rawText, { selfUin: CFG.selfUin }) : [];
  const isAtMe = isGroup && mentions.some(item => item.isBot);

  return {
    post_type: ev.post_type,
    message_type: ev.message_type,
    user_id: Number(ev.user_id),
    group_id: ev.group_id ? Number(ev.group_id) : null,
    message_id: ev.message_id,
    sender,
    nickname: sender.card || sender.nickname || "群友",
    text,
    images,
    imageSegments: getImageSegments(ev.message),
    rawText,
    isAtMe,
    mentions,
    mentionedUsers: mentionedUsers(mentions),
    files: getFiles(ev.message),
    replyData: isGroup ? getReplyData(ev.message) : null,
  };
}

export async function resolveReplyContext(ctx) {
  if (!ctx.replyData) return "";
  const replyInfo = await fetchReplyData(ctx.replyData);
  if (replyInfo.images.length) {
    ctx.images.push(...replyInfo.images);
    log("pulled", replyInfo.images.length, "images from replied message");
  }
  return replyInfo.text;
}

export function pullRecentImages(groupId) {
  const recentMsgs = groupChats[String(groupId)] || [];
  const cutoff = Date.now() - 300000;
  const urls = [];
  for (let i = recentMsgs.length - 1; i >= 0; i--) {
    const m = recentMsgs[i];
    if (m.ts < cutoff) break;
    if (m.imageUrls?.length) urls.push(...m.imageUrls);
  }
  if (urls.length) log("pulled", urls.length, "recent images into context");
  return urls;
}

export async function handleLinkPreview(gid, rawText, isLongGroup, options = {}) {
  const decision = inspectAutoPreview(rawText, {
    groupId: gid,
    isLongGroup,
    isAtMe: options.isAtMe,
    now: options.now,
    dedupeWindowMs: options.dedupeWindowMs,
  });
  if (!decision.ok) {
    if (decision.hadLink) recordLinkPreviewSkip(decision.reason);
    return previewResult(false, false, decision.hadLink, decision.reason);
  }

  const previewer = options.previewer || extractLinkPreview;
  let preview = null;
  try {
    preview = await previewer(decision.candidate.url);
  } catch {}
  if (!preview) {
    recordLinkPreviewSkip("unavailable");
    return previewResult(false, false, true, "unavailable");
  }
  if (!previewAddsValue(preview, rawText, decision.candidate)) {
    recordLinkPreviewSkip("low_value");
    return previewResult(false, Boolean(preview.bvid), true, "low_value");
  }

  const sendResult = await sendPreview(gid, preview, options);
  const sent = isSuccessfulOutbound(sendResult);
  if (sent) {
    markAutoPreviewSent(gid, decision.candidate, options);
    log(preview.bvid ? "bili preview sent" : "generic link preview sent", decision.candidate.host);
  }
  return previewResult(sent, Boolean(preview.bvid), true, sent ? "sent" : "send_failed");
}

export async function handleExplicitLinkPreviewCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = options.parsedCommand || parseExplicitLinkPreviewCommand(ctx.text || ctx.rawText, {
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
  if (!parsed) return false;

  const previewer = options.previewer || extractLinkPreview;
  const sender = options.sender || sendMsg;
  const preview = await previewer(parsed.url);
  if (!preview) {
    await sender(ctx.group_id, "链接预览失败，网页不可访问或被安全规则拦截。", options.replyToId);
    return true;
  }

  await sendPreview(ctx.group_id, preview, options);
  return true;
}

export function parseExplicitLinkPreviewCommand(text, options = {}) {
  const command = prepareCommandText(text, {
    ...options,
    requireMention: options.requireMention ?? true,
  });
  const match = command.match(/^(?:preview|link preview|link|预览|链接预览)\s+(https?:\/\/\S+)/i);
  return match ? { url: match[1] } : null;
}

export async function handleMiniApp(message, gid, isLongGroup) {
  if (isLongGroup) return false;

  for (const detail of parseMiniAppPayloads(message)) {
    if (await sendMiniAppPreview(detail, gid)) return true;
  }
  return false;
}

function parseMiniAppPayloads(message) {
  const details = [];
  const jsonItems = normalizeMsg(message).filter(function(m) { return m.type === "json"; });
  for (const item of jsonItems) {
    const detail = parseMiniAppPayload(item);
    if (detail) details.push(detail);
  }
  return details;
}

function parseMiniAppPayload(item) {
  try {
    const data = JSON.parse(item.data?.data || "{}");
    if (data?.app !== "com.tencent.miniapp_01") return null;
    return data?.meta?.detail_1 || null;
  } catch {
    return null;
  }
}

function extractMiniAppUrl(detail) {
  return detail.qqdocurl || detail.preview || "";
}

function formatMiniAppReply(detail, url) {
  const title = detail.title || "";
  const desc = detail.desc || "";
  const miniText = "📱 " + title + (desc ? " - " + desc : "");
  return url ? miniText + "\n🔗 " + url : miniText;
}

async function sendMiniAppPreview(detail, gid) {
  const url = extractMiniAppUrl(detail);
  if (url && (url.includes("bilibili.com") || url.includes("b23.tv"))) {
    const bili = await extractLinkPreview(url);
    if (bili) {
      await sendPreview(gid, bili);
      log("miniApp bili preview sent");
      return true;
    }
  }

  await sendMsg(gid, formatMiniAppReply(detail, url));
  log("miniApp preview sent");
  return true;
}

async function sendPreview(groupId, preview, options = {}) {
  const sender = options.sender || sendMsg;
  const imageSender = options.imageSender || sendMsgWithImage;
  const imageResolver = options.imageResolver || resolvePreviewImage;
  const image = preview.image ? await imageResolver(preview.image) : null;
  if (image) return imageSender(groupId, preview.text, image);
  return sender(groupId, preview.text, options.replyToId);
}

function previewResult(sent, isBili, hadLink, reason) {
  return { sent, isBili, hadLink, reason };
}

export function shouldInterject(text, ctxOrIsAtMe, previewSent) {
  const ctx = typeof ctxOrIsAtMe === "object" && ctxOrIsAtMe !== null
    ? ctxOrIsAtMe
    : { isAtMe: ctxOrIsAtMe, previewSent };
  return shouldInterjectByPolicy(text, ctx, interjectionState);
}

export function buildInterjectionDecision(text, ctx = {}) {
  return buildInterjectionDecisionByPolicy(text, ctx, interjectionState);
}

export function buildSafeInterjectionReply(text) {
  return buildInterjectionFallback(text, "model_failed");
}

export { classifyInterjectionTrigger };
