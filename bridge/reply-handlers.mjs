// bridge/reply-handlers.mjs — processEvent 拆分后的独立处理函数
import { CFG, LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { groupChats } from "./storage.mjs";
import { normalizeMsg, cleanText, getLatestChangelog } from "./context.mjs";
import { getImages, getFiles, describeFiles, getReplyData, fetchReplyData, sendMsg, sendMsgWithImage } from "./napcat.mjs";
import { extractLinkPreview } from "./search.mjs";

/**
 * 解析 OneBot 事件为标准化上下文（纯函数，无副作用）
 */
export function parseIncomingEvent(ev) {
  const sender = ev.sender || {};
  const text = cleanText(ev.message);
  const images = getImages(ev.message);
  const rawText = ev.raw_message || text || "";
  const isGroup = ev.message_type === "group";
  const isAtMe = isGroup &&
    (rawText.includes(String(CFG.selfUin)) || rawText.includes("[CQ:at,qq=" + CFG.selfUin + "]"));

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
    rawText,
    isAtMe,
    files: getFiles(ev.message),
    replyData: isGroup ? getReplyData(ev.message) : null,
  };
}

/**
 * 拉取被回复消息的内容（有副作用：可能追加图片到 ctx.images）
 */
export async function resolveReplyContext(ctx) {
  if (!ctx.replyData) return "";
  const replyInfo = await fetchReplyData(ctx.replyData);
  if (replyInfo.images.length) {
    ctx.images.push(...replyInfo.images);
    log("pulled", replyInfo.images.length, "images from replied message");
  }
  return replyInfo.text;
}

/**
 * 拉取近期图片（5分钟内的群聊图片）
 */
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

/**
 * 处理链接预览（B站 + 通用）
 * @returns {{sent: boolean, isBili: boolean}}
 */
export async function handleLinkPreview(gid, rawText, isLongGroup) {
  if (isLongGroup) return { sent: false, isBili: false };

  // B站链接
  const biliRegex = /https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[a-zA-Z0-9]+|https?:\/\/b23\.tv\/[a-zA-Z0-9]+/g;
  const biliMatches = rawText.match(biliRegex);
  if (biliMatches) {
    for (const url of biliMatches) {
      const preview = await extractLinkPreview(url);
      if (preview) {
        await sendMsgWithImage(gid, preview.text, preview.image);
        log("bili preview sent for", preview.bvid || url);
        return { sent: true, isBili: true };
      }
    }
  }

  // 通用链接
  const urlRegex = /https?:\/\/[^\s]+/g;
  const urls = rawText.match(urlRegex);
  if (urls) {
    for (const url of urls) {
      if (url.includes("bilibili.com") || url.includes("b23.tv")) continue;
      const preview = await extractLinkPreview(url);
      if (preview) {
        await sendMsgWithImage(gid, preview.text, preview.image);
        log("通用链接预览已发送");
        return { sent: true, isBili: false };
      }
    }
  }

  return { sent: false, isBili: false };
}

/**
 * 处理QQ小程序卡片
 * @returns {boolean} 是否发送了预览
 */
export async function handleMiniApp(message, gid, isLongGroup) {
  if (isLongGroup) return false;

  const jsonItems = normalizeMsg(message).filter(m => m.type === "json");
  for (const j of jsonItems) {
    try {
      const data = JSON.parse(j.data?.data || "{}");
      if (data?.app === "com.tencent.miniapp_01" && data?.meta?.detail_1) {
        const title = data.meta.detail_1.title || "";
        const desc = data.meta.detail_1.desc || "";
        const url = data.meta.detail_1.qqdocurl || data.meta.detail_1.preview || "";

        if (url && (url.includes("bilibili.com") || url.includes("b23.tv"))) {
          const bili = await extractLinkPreview(url);
          if (bili) {
            await (bili.image ? sendMsgWithImage(gid, bili.text, bili.image) : sendMsg(gid, bili.text));
            log("miniApp bili preview sent");
            return true;
          }
        }

        const miniText = "📱 " + title + (desc ? " - " + desc : "");
        await sendMsg(gid, url ? miniText + "\n🔗 " + url : miniText);
        log("miniApp preview sent");
        return true;
      }
    } catch { /* 非标准JSON，跳过 */ }
  }
  return false;
}

/**
 * 判断群聊中是否应随机插话
 */
export function shouldInterject(text, isAtMe, previewSent) {
  if (isAtMe || previewSent) return false;
  if (!text || text.length <= 5) return false;
  return Math.random() < 0.20;
}
