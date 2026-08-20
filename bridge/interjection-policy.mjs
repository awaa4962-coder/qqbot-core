import { normalizeInterjectionReply as normalizeReplyText } from "./thinking.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { monotonicNow } from "./runtime-clock.mjs";

const PROBABILITY = Object.freeze({
  ordinary: 0.06,
  image: 0.25,
  emotion: 0.38,
  joke: 0.32,
  question: 0.30,
  direct_but_not_at: 0.60,
  conflict: 0.18,
  admin: 0,
  sensitive: 0,
});

const GROUP_COOLDOWN_MS = 60000;
const USER_COOLDOWN_MS = 120000;
const MIN_GROUP_MESSAGES_BETWEEN = 3;

const defaultState = {
  lastGroupAt: new Map(),
  lastUserAt: new Map(),
  groupMessagesSinceInterjection: new Map(),
};

function textIncludes(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

export function classifyInterjectionTrigger(text, _ctx = {}) {
  const t = String(text || "").trim();
  if (_ctx.hasImages && t.length < 5) return "image";
  if (!t || t.length < 5) return "ordinary";
  if (textIncludes(t, [/admin/i, /runtime/i, /status/i, /禁言|管理|权限|封禁|踢人/])) return "admin";
  if (textIncludes(t, [/政治|色情|裸|自杀|恐怖|炸弹|诈骗|银行卡|身份证/])) return "sensitive";
  if (textIncludes(t, [/吵|骂|别吵|冲突|下管理|下了管理|红温|生气|气死/])) return "conflict";
  if (textIncludes(t, [/夜星|QQFriend|Yexing|机器人|猫娘|在吗|出来/])) return "direct_but_not_at";
  if (textIncludes(t, [/难受|委屈|哭|555|呜呜|红温|焦虑|烦死|累死/])) return "emotion";
  if (textIncludes(t, [/哈哈|笑死|乐|绷不住|蚌埠住|梗|抽象/])) return "joke";
  if (textIncludes(t, [/[?？]$/, /吗[?？]?$/, /怎么|为什么|咋办|如何|能不能/])) return "question";
  return "ordinary";
}

function cooldownAllows(ctx, state, now) {
  const groupId = String(ctx.groupId || ctx.group_id || "default");
  const userId = String(ctx.userId || ctx.user_id || "default");
  const lastGroupAt = state.lastGroupAt.get(groupId) || 0;
  const lastUserAt = state.lastUserAt.get(userId) || 0;
  const sinceCount = state.groupMessagesSinceInterjection.get(groupId) ?? MIN_GROUP_MESSAGES_BETWEEN;
  if (lastGroupAt && now - lastGroupAt < GROUP_COOLDOWN_MS) return false;
  if (lastUserAt && now - lastUserAt < USER_COOLDOWN_MS) return false;
  if (sinceCount < MIN_GROUP_MESSAGES_BETWEEN) return false;
  return true;
}

function markSeen(ctx, state) {
  const groupId = String(ctx.groupId || ctx.group_id || "default");
  const oldValue = state.groupMessagesSinceInterjection.get(groupId) ?? MIN_GROUP_MESSAGES_BETWEEN;
  state.groupMessagesSinceInterjection.set(groupId, oldValue + 1);
}

function markInterjected(ctx, state, now) {
  const groupId = String(ctx.groupId || ctx.group_id || "default");
  const userId = String(ctx.userId || ctx.user_id || "default");
  state.lastGroupAt.set(groupId, now);
  state.lastUserAt.set(userId, now);
  state.groupMessagesSinceInterjection.set(groupId, 0);
}

function buildEarlyBlockDecision(text, ctx) {
  if (ctx.isAtMe) return { ok: false, kind: "blocked", reason: "mentioned", probability: 0 };
  if (ctx.previewSent) return { ok: false, kind: "blocked", reason: "preview_sent", probability: 0 };

  const trimmed = String(text || "").trim();
  if (!trimmed && !ctx.hasImages) return { ok: false, kind: "empty", reason: "empty", probability: 0 };
  if (trimmed.length > 0 && trimmed.length < 5 && !ctx.hasImages) {
    return { ok: false, kind: "short", reason: "short", probability: 0 };
  }

  return null;
}

export function shouldInterject(text, ctx = {}, state = defaultState) {
  return buildInterjectionDecision(text, ctx, state).ok;
}

export function buildInterjectionDecision(text, ctx = {}, state = defaultState) {
  const earlyBlock = buildEarlyBlockDecision(text, ctx);
  if (earlyBlock) return earlyBlock;
  markSeen(ctx, state);

  const kind = classifyInterjectionTrigger(text, ctx);
  const probability = applyProbabilityFactor(PROBABILITY[kind] || 0, ctx.probabilityFactor);
  if (!probability) return { ok: false, kind, reason: "no_probability", probability };

  const now = ctx.now ?? monotonicNow();
  if (!cooldownAllows(ctx, state, now)) return { ok: false, kind, reason: "cooldown", probability };
  const random = typeof ctx.random === "function" ? ctx.random() : Math.random();
  if (random >= probability) return { ok: false, kind, reason: "random", probability };

  markInterjected(ctx, state, now);
  return { ok: true, kind, reason: "triggered", probability };
}

function applyProbabilityFactor(base, factor) {
  const value = Number(factor || 1);
  if (!Number.isFinite(value) || value <= 0) return base;
  return Math.max(0, Math.min(0.85, base * value));
}

export function buildInterjectionPrompt(text, ctx = {}) {
  const kind = classifyInterjectionTrigger(text, ctx);
  return [
    "[插话判断]",
    "trigger_type=" + kind,
    "has_images=" + Boolean(ctx.hasImages),
    "vision_available=" + Boolean(ctx.visionAvailable),
    buildCurrentInput(ctx.userName, text, ctx.userId),
    "请结合前面的被回复消息、最近对话、梗库提示和图片客观描述，找到具体回应点；接不上时输出空 reply。",
  ].join("\n");
}

export function normalizeInterjectionReply(text) {
  return normalizeReplyText(text);
}

export function buildInterjectionFallback(text, reason) {
  const kind = classifyInterjectionTrigger(text);
  if (kind === "emotion") return reason === "model_failed" ? "先缓一口气，我在听。" : "慢慢说，先别急。";
  if (kind === "conflict") return "先别把话顶太满，慢慢说清楚。";
  return null;
}
