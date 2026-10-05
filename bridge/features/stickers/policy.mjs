import { CFG } from "../../config.mjs";
import { getStickerSettings, stickerCatalogAvailable } from "./catalog-store.mjs";
import { resolveStickerAllowedGroups } from "./scope.mjs";
import { monotonicNow } from "../../runtime-clock.mjs";
import { registeredQuoteReading } from "../../context/pruning.mjs";

const lastSent = new Map();
const SERIOUS_RE = /急救|报警|自杀|自残|死亡|去世|住院|法律责任|密钥|私钥|密码|口令|凭据|验证码|身份证|银行卡|\b(?:api[_ -]?key|password|credentials?|authorization|bearer|(?:access|refresh|auth|id)[_ -]?token)\b|\b(?:[a-z][a-z0-9_]*_)?(?:token|secret|api[_ -]?key|client[_ -]?secret)\s*[:=]|\bsk-[a-z0-9_-]{12,}/i;
const FAULT_RE = /报错|异常|失败|故障|崩溃|闪退|打不开|连不上|无法|不能|超时|\b(?:error|exception|failed|timeout)\b/i;
const HELP_RE = /怎么办|怎么(?:修|解决|处理|排查)|如何(?:修复|解决|排查)|帮(?:我)?(?:看看|修|检查|排查)|求助|排查|诊断|修复|解决方案|错误码|\b(?:traceback|stack\s*trace|please\s+help|help\s+me|debug|troubleshoot|fix)\b/i;
const FAULT_DETAIL_RE = /\b(?:HTTP\s*[45]\d{2}|EACCES|ECONNREFUSED|ENOENT|TypeError|ReferenceError)\b|错误码\s*[:：]?\s*[a-z0-9_-]+/i;
const PRIVACY_HELP_RE = /(?:隐私|个人信息|手机号|住址|聊天记录).{0,24}(?:泄露|曝光|求助|怎么办|删除)|(?:泄露|曝光).{0,24}(?:隐私|个人信息|手机号|住址|聊天记录)/;
const STRONG_RE = /哈哈|笑死|绷不住|无语|离谱|震惊|卧槽|生气|哈气|哭了|委屈|好耶|谢谢|确实|没错/;

export function evaluateStickerPolicy(context = {}, options = {}) {
  const eligibility = checkStickerReplyEligibility(context, options);
  if (!eligibility.ok) return eligibility;
  const roll = Number((options.random || Math.random)());
  if (roll >= eligibility.chance) return blocked("概率未命中", eligibility.mode, "chance_missed", eligibility.chance);
  return { ...eligibility, reason: eligibility.strong ? "强语境命中" : "普通概率命中", reasonCode: "chance_selected" };
}

export function checkStickerReplyEligibility(context = {}, options = {}) {
  const settings = options.settings || getStickerSettings();
  const now = Number(options.now ?? monotonicNow());
  const mode = settings.mode || "steady";
  const preflight = evaluatePreflight(context, mode);
  if (preflight) return preflight;
  const scope = resolveScope(context, settings);
  if (!scope.ok) return blocked(scope.reason, mode, scope.reasonCode);
  const cooldownBlock = evaluateCooldown(scope.key, settings, now, mode);
  if (cooldownBlock) return cooldownBlock;
  const text = String(context.userMessage || "") + " " + String(context.assistantText || "");
  const strong = STRONG_RE.test(text);
  const chance = Number((strong ? settings.strongChance : settings.chance) || 0);
  if (!Number.isFinite(chance) || chance <= 0) return blocked("概率未命中", mode, "chance_disabled");
  return { ok: true, mode, chance, strong, scopeKey: scope.key, reason: "满足表情发送条件", reasonCode: "eligible" };
}

export function recordStickerCooldown(scopeKey, now = monotonicNow()) {
  if (scopeKey) lastSent.set(String(scopeKey), Number(now));
}

export function resetStickerPolicyForTest() {
  lastSent.clear();
}

function blocked(reason, mode, reasonCode, chance = 0) {
  return { ok: false, mode, chance, strong: false, scopeKey: "", reason, reasonCode };
}

function evaluatePreflight(context, mode) {
  if (!CFG.stickerEnabled || mode === "off") return blocked("功能已关闭", mode, "sticker_off");
  if (!stickerCatalogAvailable()) return blocked("表情目录暂不可读", mode, "catalog_unavailable");
  if (!String(context.assistantText || "").trim()) return blocked("没有文字回复", mode, "no_reply");
  const messages = Array.isArray(context.contextMessages) ? context.contextMessages : [];
  const quotes = registeredQuoteReading(messages).map(quote => quote.providedFrame);
  const fullText = [context.userMessage, context.assistantText, context.replyText, ...quotes].filter(Boolean).join(" ");
  const serious = SERIOUS_RE.test(fullText) || PRIVACY_HELP_RE.test(fullText) ||
    FAULT_DETAIL_RE.test(fullText) || (FAULT_RE.test(fullText) && HELP_RE.test(fullText));
  return serious ? blocked("严肃或系统场景", mode, "serious_context") : null;
}

function resolveScope(context, settings) {
  if (context.private === true) {
    return settings.privateEnabled
      ? { ok: true, key: "private:" + String(context.userId || "") }
      : { ok: false, reason: "私聊表情已关闭", reasonCode: "private_disabled" };
  }
  if (!settings.groupEnabled) return { ok: false, reason: "群聊表情已关闭", reasonCode: "group_disabled" };
  const groupId = Number(context.groupId || 0);
  const allowedGroups = resolveStickerAllowedGroups(settings);
  return allowedGroups.includes(groupId)
    ? { ok: true, key: "group:" + groupId }
    : { ok: false, reason: "群不在表情白名单", reasonCode: "group_not_allowed" };
}

function evaluateCooldown(scopeKey, settings, now, mode) {
  if (!lastSent.has(scopeKey)) return null;
  const elapsed = now - Number(lastSent.get(scopeKey) || 0);
  return elapsed < Number(settings.cooldownMs || 0)
    ? blocked("冷却中", mode, "cooldown")
    : null;
}
