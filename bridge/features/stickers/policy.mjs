import { CFG } from "../../config.mjs";
import { getStickerSettings } from "./catalog-store.mjs";
import { resolveStickerAllowedGroups } from "./scope.mjs";

const lastSent = new Map();
const SERIOUS_RE = /急救|报警|自杀|自残|死亡|去世|住院|法律责任|报错|异常|失败|密钥|密码|管理员|日报|更新日志|版本|命令|诊断/;
const STRONG_RE = /哈哈|笑死|绷不住|无语|离谱|震惊|卧槽|生气|哈气|哭了|委屈|好耶|谢谢|确实|没错/;

export function evaluateStickerPolicy(context = {}, options = {}) {
  const settings = options.settings || getStickerSettings();
  const now = Number(options.now || Date.now());
  const mode = settings.mode || "steady";
  const preflight = evaluatePreflight(context, mode);
  if (preflight) return preflight;
  const scope = resolveScope(context, settings);
  if (!scope.ok) return blocked(scope.reason, mode);
  const cooldownBlock = evaluateCooldown(scope.key, settings, now, mode);
  return cooldownBlock || evaluateChance(context, settings, scope.key, mode, options.random);
}

export function recordStickerCooldown(scopeKey, now = Date.now()) {
  if (scopeKey) lastSent.set(String(scopeKey), Number(now));
}

export function resetStickerPolicyForTest() {
  lastSent.clear();
}

function blocked(reason, mode, chance = 0) {
  return { ok: false, mode, chance, strong: false, scopeKey: "", reason };
}

function evaluatePreflight(context, mode) {
  if (!CFG.stickerEnabled || mode === "off") return blocked("功能已关闭", mode);
  if (!String(context.assistantText || "").trim()) return blocked("没有文字回复", mode);
  const fullText = String(context.userMessage || "") + " " + String(context.assistantText || "");
  return SERIOUS_RE.test(fullText) ? blocked("严肃或系统场景", mode) : null;
}

function resolveScope(context, settings) {
  if (context.private === true) {
    return settings.privateEnabled
      ? { ok: true, key: "private:" + String(context.userId || "") }
      : { ok: false, reason: "私聊表情已关闭" };
  }
  if (!settings.groupEnabled) return { ok: false, reason: "群聊表情已关闭" };
  const groupId = Number(context.groupId || 0);
  const allowedGroups = resolveStickerAllowedGroups(settings);
  return allowedGroups.includes(groupId)
    ? { ok: true, key: "group:" + groupId }
    : { ok: false, reason: "群不在表情白名单" };
}

function evaluateCooldown(scopeKey, settings, now, mode) {
  const elapsed = now - Number(lastSent.get(scopeKey) || 0);
  return elapsed < Number(settings.cooldownMs || 0)
    ? blocked("冷却中", mode)
    : null;
}

function evaluateChance(context, settings, scopeKey, mode, random) {
  const text = String(context.userMessage || "") + " " + String(context.assistantText || "");
  const strong = STRONG_RE.test(text);
  const configuredChance = strong ? settings.strongChance : settings.chance;
  const chance = Number(configuredChance || 0) * (context.isPassive ? 0.7 : 1);
  const roll = Number((random || Math.random)());
  if (roll >= chance) return blocked("概率未命中", mode, chance);
  return {
    ok: true,
    mode,
    chance,
    strong,
    scopeKey,
    reason: strong ? "强语境命中" : "普通概率命中",
  };
}
