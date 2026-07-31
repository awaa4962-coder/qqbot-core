import { CFG } from "./config.mjs";
import { stripBotMention } from "./admin-commands.mjs";
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
import { extractLinkPreview } from "./search.mjs";
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

export async function handleLinkPreview(gid, rawText, isLongGroup) {
  if (isLongGroup) return { sent: false, isBili: false };
  if (typeof rawText !== "string" || !rawText) return { sent: false, isBili: false };

  const biliResult = await sendFirstBilibiliPreview(gid, rawText);
  if (biliResult.sent) return biliResult;

  const genericSent = await sendFirstGenericPreview(gid, rawText);
  return { sent: genericSent, isBili: false };
}

export async function handleExplicitLinkPreviewCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = parseExplicitLinkPreviewCommand(ctx.text || ctx.rawText, {
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
  if (!parsed) return false;

  const previewer = options.previewer || extractLinkPreview;
  const sender = options.sender || sendMsg;
  const imageSender = options.imageSender || sendMsgWithImage;
  const preview = await previewer(parsed.url);
  if (!preview) {
    await sender(ctx.group_id, "Link preview failed or was blocked.", options.replyToId);
    return true;
  }

  if (preview.image) await imageSender(ctx.group_id, preview.text, preview.image);
  else await sender(ctx.group_id, preview.text, options.replyToId);
  return true;
}

export function parseExplicitLinkPreviewCommand(text, options = {}) {
  const command = stripBotMention(text, options.selfUin, options.botNames)
    .replace(/^[/\\]+/, "")
    .trim();
  const match = command.match(/^(?:preview|link preview|link|预览|链接预览)\s+(https?:\/\/\S+)/i);
  return match ? { url: match[1] } : null;
}

async function sendFirstBilibiliPreview(gid, rawText) {
  const biliRegex = /https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[a-zA-Z0-9]+|https?:\/\/b23\.tv\/[a-zA-Z0-9]+/g;
  const matches = rawText.match(biliRegex) || [];
  for (const url of matches) {
    const preview = await extractLinkPreview(url);
    if (preview) {
      await sendMsgWithImage(gid, preview.text, preview.image);
      log("bili preview sent for", preview.bvid || url);
      return { sent: true, isBili: true };
    }
  }
  return { sent: false, isBili: false };
}

async function sendFirstGenericPreview(gid, rawText) {
  const urls = rawText.match(/https?:\/\/[^\s]+/g) || [];
  for (const url of urls) {
    if (url.includes("bilibili.com") || url.includes("b23.tv")) continue;
    const preview = await extractLinkPreview(url);
    if (preview) {
      await sendMsgWithImage(gid, preview.text, preview.image);
      log("generic link preview sent");
      return true;
    }
  }
  return false;
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
      await (bili.image ? sendMsgWithImage(gid, bili.text, bili.image) : sendMsg(gid, bili.text));
      log("miniApp bili preview sent");
      return true;
    }
  }

  await sendMsg(gid, formatMiniAppReply(detail, url));
  log("miniApp preview sent");
  return true;
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
