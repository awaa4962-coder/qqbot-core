// bridge/reply.mjs — 回复编排（aiReply + processEvent + privateReply）
import { CFG, LONG_GROUPS } from "./config.mjs";
import { log, logE, canProcessEvent, incProcessingCount, decProcessingCount } from "./logger.mjs";
import { logGroupMsg, getUser } from "./storage.mjs";
import { recentHistoryWeighted, recentGroupChat, recentHistory, getLatestChangelog } from "./context.mjs";
import { getFiles, describeFiles, fetchFileContent, sendMsg, sendPrivateMsg } from "./napcat.mjs";
import { tryMiMo } from "./model-mimo.mjs";
import { tryDeepSeek } from "./model-ds.mjs";
import { generateProfile } from "./profile.mjs";
import {
  parseIncomingEvent,
  resolveReplyContext,
  pullRecentImages,
  handleLinkPreview,
  handleMiniApp,
  shouldInterject,
} from "./reply-handlers.mjs";

export async function aiReply(group_id, userId, userMsg, userName, imageUrls, replyTo, replyText, isAtMe) {
  if (isAtMe === undefined) isAtMe = true;
  const gid = String(group_id);
  const uid = String(userId);

  getUser(uid, userName);

  const histResult = recentHistoryWeighted(uid, group_id);
  const history = histResult.history;
  const mood = histResult.mood;

  let extraHistory = [];
  if (replyText) {
    extraHistory.push({ role: "user", content: "[回复了 " + userName + " 的消息: " + replyText.slice(0, 200) + "]" });
  }
  const fullHistory = [].concat(extraHistory, history);

  const groupRecent = recentGroupChat(group_id, 20);
  if (groupRecent.length) {
    const groupCtx = groupRecent.map(function (m) { return m.content; }).join("\n");
    fullHistory.push({ role: "user", content: "[近期群聊记录]:\n" + groupCtx });
  }

  let reply = await tryMiMo(userMsg, userName, fullHistory, imageUrls, group_id, isAtMe, mood);
  if (!reply) {
    log("MiMo failed, fallback to DeepSeek");
    reply = await tryDeepSeek(userMsg, userName, fullHistory, group_id, isAtMe, mood);
  }

  if (!reply) {
    reply = "啊，我现在有点卡卡的，等我缓一下再回复你~ 🤔";
  }

  await sendMsg(group_id, reply, replyTo);
  logGroupMsg(group_id, "夜星", reply, CFG.selfUin, "assistant");
  log("aiReply done for", userName, "in", gid);

  generateProfile(uid).catch(function (e) { logE("profile update failed for", uid, ":", e.message); });
}

// ── processEvent：群聊/私聊事件入口 ──
export async function processEvent(ev) {
  if (!canProcessEvent() || !ev) return;

  const ctx = parseIncomingEvent(ev);

  if (CFG.botBlacklist.includes(ctx.user_id)) return;

  incProcessingCount();
  try {
    // ── 私聊 ──
    if (ctx.message_type === "private") {
      await handlePrivateMessage(ctx);
      return;
    }

    // ── 群消息 ──
    if (ctx.message_type === "group") {
      await handleGroupMessage(ctx, ev.message);
      return;
    }
  } finally {
    decProcessingCount();
  }
}

// ── 私聊处理 ──
async function handlePrivateMessage(ctx) {
  if (!CFG.friendWhitelist.includes(ctx.user_id)) {
    log("private msg from non-whitelist:", ctx.user_id);
    return;
  }

  if (ctx.files.length) {
    const fileDesc = describeFiles(ctx.files);
    let fileContent = "";
    for (const f of ctx.files) {
      const content = await fetchFileContent(f);
      if (content) fileContent += content + "\n";
    }
    const fullMsg = ctx.text + " " + fileDesc + (fileContent ? "\n[文件内容]:\n" + fileContent : "");
    const reply = await tryDeepSeek(fullMsg, ctx.nickname, [], null, true, "");
    if (reply) {
      await sendPrivateMsg(ctx.user_id, reply);
      log("private file reply sent to", ctx.user_id);
    }
    return;
  }

  if (ctx.text || ctx.images.length) {
    const fullMsg = ctx.text + (ctx.images.length ? " [图片" + ctx.images.length + "张]" : "");
    const reply = await tryDeepSeek(fullMsg, ctx.nickname, [], null, true, "");
    if (reply) {
      await sendPrivateMsg(ctx.user_id, reply);
      log("private reply sent to", ctx.user_id);
    }
  }
}

// ── 群聊处理 ──
async function handleGroupMessage(ctx, rawMessage) {
  if (ctx.user_id === CFG.selfUin) return;
  if (!CFG.groupWhitelist.includes(ctx.group_id)) {
    log("msg from non-whitelist group:", ctx.group_id);
    return;
  }

  if (ctx.images.length) {
    log("IMG detected in", ctx.group_id, ":", ctx.images.length,
      "urls:", JSON.stringify(ctx.images.map(function (u) { return u.slice(0, 80); })));
  }

  logGroupMsg(ctx.group_id, ctx.nickname, ctx.text || "[非文本消息]",
    ctx.user_id, "member", ctx.images.length ? ctx.images : null);

  // 解析被回复消息
  const replyText = await resolveReplyContext(ctx);
  const replyToId = ctx.replyData?.id || ctx.message_id;

  // 链接预览（非文理群）
  const isLong = requireLongGroup ? requireLongGroup(ctx.group_id) : false;
  const { sent: biliSent, isBili } = await handleLinkPreview(ctx.group_id, ctx.rawText, isLong);
  let previewSent = biliSent;

  // 小程序卡片
  if (!biliSent) {
    previewSent = await handleMiniApp(rawMessage, ctx.group_id, isLong);
  }

  // 预览已发送且非@ → 结束
  if (previewSent && !ctx.isAtMe) return;

  // @ 我处理
  if (ctx.isAtMe) {
    // 近期图片拉取
    const recentImgs = pullRecentImages(ctx.group_id);
    if (recentImgs.length) ctx.images.push(...recentImgs);

    // changelog 快速响应
    if (ctx.text.includes("更新日志") || ctx.text.includes("更新记录") || ctx.text === "changelog") {
      const cl = getLatestChangelog();
      await sendMsg(ctx.group_id, "📋 夜星更新日志喵～\n\n" + cl, replyToId);
      logGroupMsg(ctx.group_id, "夜星", "[changelog]", CFG.selfUin, "assistant");
      return;
    }

    log("at detected, processing AI reply...");
    await aiReply(ctx.group_id, ctx.user_id, ctx.text, ctx.nickname, ctx.images, replyToId, replyText, true);
    return;
  }

  // 纯文件兜底
  if (!ctx.text && ctx.files.length && !ctx.images.length) {
    const fileDesc = describeFiles(ctx.files);
    await sendMsg(ctx.group_id, ctx.nickname + " 发了文件: " + fileDesc);
    return;
  }

  // 随机插话（20%）
  if (shouldInterject(ctx.text, false, previewSent)) {
    log("random interjection triggered");
    await aiReply(ctx.group_id, ctx.user_id, ctx.text, ctx.nickname, ctx.images, null, "", false);
  }
}

// ── 长群判断 ──
function requireLongGroup(groupId) {
  return LONG_GROUPS.includes(String(groupId));
}

export async function privateReply(userId, text) {
  const uid = Number(userId);
  if (!CFG.friendWhitelist.includes(uid)) {
    log("privateReply: user not in whitelist:", uid);
    return;
  }
  const reply = await tryDeepSeek(text, "朋友", [], null, true, "");
  if (reply) {
    await sendPrivateMsg(uid, reply);
    log("privateReply sent to", uid);
  }
}

export async function tryDeepSeekFriend(userId, userMsg) {
  const uid = Number(userId);
  const u = getUser(uid, "");
  const history = recentHistory(uid, 20);
  const reply = await tryDeepSeek(userMsg, u?.alias || "朋友", history, null, true, "");
  return reply || "抱歉，我现在有点不在状态...";
}
