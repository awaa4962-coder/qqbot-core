import { createHash, randomBytes } from "node:crypto";
import { memoryProfiles, memoryProfilesAvailable, saveMemoryProfiles, flushMemoryProfilesSync } from "./store.mjs";
import { invalidateMemoryPrivacyGeneration } from "./generation.mjs";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { users, groupChats } from "../storage.mjs";

const DAY = 86400000;
const MAX_ITEMS = 32;
const MAX_TOTAL = 2048;
const MAX_RETRACTIONS = 8192;
const ID = /^[a-f0-9]{12}$/;
const KINDS = new Set(["user_statement", "operator_note"]);
export const MEMORY_NOTE_LIMITS = Object.freeze({ maxItems: MAX_ITEMS, maxTextChars: 300, maxTitleChars: 32, ttlDays: 90 });

export function createMemoryNoteService(options = {}) {
  const profiles = options.profiles || memoryProfiles;
  const available = options.available || memoryProfilesAvailable;
  const now = options.now || Date.now;
  const invalidate = options.invalidate || invalidateMemoryPrivacyGeneration;
  const persist = options.persist || (() => saveMemoryProfiles() && flushMemoryProfilesSync());
  const readPrivacy = options.readPrivacy || summaryPrivacy;

  function root() {
    if (!available()) throw memoryError("记忆文件暂不可读，已停止修改。", 503);
    const value = profiles.notes === undefined ? { schema: 1, revision: 0, items: [] } : profiles.notes;
    validateRoot(value);
    return { ...value, retractions: value.retractions || [] };
  }

  function snapshot(scope) {
    const normalized = normalizeNoteScope(scope);
    const value = root();
    return projectSnapshot(value, normalized, now(), privacyCutoff(normalized, readPrivacy));
  }

  function act(payload, context = {}) {
    const scope = normalizeNoteScope(payload);
    const previous = root();
    const cutoff = privacyCutoff(scope, readPrivacy);
    if (payload.revision !== snapshotRevision(previous, scope, cutoff)) throw memoryError("记忆已变化，请刷新后重新修改。", 409);
    const time = now();
    if (time <= cutoff) throw memoryError("隐私清理刚完成，请稍后重新保存。", 409);
    const next = { schema: 1, revision: previous.revision + 1, retractions: [...previous.retractions],
      items: previous.items.filter(item => !sameScope(item, scope) || item.source.at > cutoff).map(item => ({ ...item })) };
    const index = next.items.findIndex(item => item.id === payload.id && sameScope(item, scope));
    applyAction(next, index, scope, payload, context, time);
    // Commit through the existing saver so an older debounced write cannot overwrite this edit.
    profiles.notes = next;
    try {
      if (!persist()) throw memoryError("记忆未保存，请检查存储后重试。", 503);
    } catch {
      profiles.notes = previous;
      throw memoryError("记忆未保存，请检查存储后重试。", 503);
    }
    invalidate();
    return projectSnapshot(next, scope, time, cutoff);
  }

  function clear(filter, settings = {}) {
    const previous = root();
    const items = previous.items.filter(item => !matchesClear(item, filter));
    const retractions = previous.retractions.filter(item => !matchesClear(item, filter));
    if (items.length === previous.items.length && retractions.length === previous.retractions.length) {
      if (settings.persist && !persist()) throw memoryError("记忆清理未能落盘，请管理员检查。", 503);
      return false;
    }
    profiles.notes = { schema: 1, revision: previous.revision + 1, items, retractions };
    invalidate();
    if (settings.persist && !persist()) throw memoryError("记忆清理未能落盘，请管理员检查。", 503);
    return true;
  }

  function prune(time = now()) {
    const previous = root();
    const items = previous.items.filter(item => item.expiresAt + 7 * DAY > time);
    const retractions = previous.retractions.filter(item => time - item.at < DAY || (options.hasSource || hasStoredSource)(item));
    if (items.length === previous.items.length && retractions.length === previous.retractions.length) return false;
    profiles.notes = { schema: 1, revision: previous.revision + 1, items, retractions };
    invalidate();
    return true;
  }
  function corrections(scope) {
    const normalized = normalizeNoteScope(scope);
    const value = root();
    const own = projectSnapshot(value, normalized, now(), privacyCutoff(normalized, readPrivacy)).items.filter(item => item.state === "active");
    const excluded = value.retractions.filter(item => item.groupId === normalized.groupId &&
      (normalized.groupId !== "private" || item.userId === normalized.userId));
    return { excludedMessageIds: new Set(excluded.map(item => item.messageId)),
      replacedSources: excluded.filter(item => item.userId === normalized.userId),
      revisions: new Map(own.map(item => [item.id, item.revision])), correctedAt: Math.max(0, ...own.filter(item => item.revision > 1).map(item => item.updatedAt)) };
  }
  return { snapshot, act, clear, prune, corrections };
}

function applyAction(root, index, scope, payload, context, now) {
  if (payload.action === "remove") {
    if (index < 0) throw memoryError("这条记忆不存在或不属于当前范围。", 404);
    retainRetraction(root, root.items[index], now);
    root.items.splice(index, 1);
    return;
  }
  if (!["create", "update"].includes(payload.action)) throw memoryError("不支持的记忆操作。");
  if (payload.action === "update" && index < 0) throw memoryError("这条记忆不存在或不属于当前范围。", 404);
  const previous = index >= 0 ? root.items[index] : null;
  if (payload.action === "create" && payload.id) throw memoryError("新建记忆不能覆盖已有编号。");
  const entry = buildNote(scope, payload, context, previous, now);
  if (root.items.some(item => sameScope(item, scope) && item.id !== previous?.id && item.title === entry.title && item.expiresAt > now)) {
    throw memoryError("已有同标题记忆，请选择它进行纠正。", 409);
  }
  if (previous) { retainRetraction(root, previous, now); root.items[index] = entry; }
  else {
    root.items = root.items.filter(item => item.expiresAt > now);
    if (root.items.length >= MAX_TOTAL || root.items.filter(item => sameScope(item, scope)).length >= MAX_ITEMS) {
      throw memoryError("记忆数量已达上限，请先删除或整理旧条目。", 409);
    }
    root.items.push(entry);
  }
}

function retainRetraction(root, previous, now) {
  for (const messageId of [...previous.replacedSources, previous.source.messageId].filter(Boolean)) {
    if (root.retractions.some(item => sameScope(item, previous) && item.messageId === messageId)) continue;
    if (root.retractions.length >= MAX_RETRACTIONS) throw memoryError("纠正来源记录已达上限，请管理员先检查存储；本次没有覆盖旧记忆。", 409);
    root.retractions.push({ userId: previous.userId, groupId: previous.groupId, noteId: previous.id, messageId, at: now });
  }
}

function hasStoredSource(item) {
  return (users[item.userId]?.chats || []).some(chat => String(chat.group) === item.groupId && String(chat.messageId) === item.messageId) ||
    (groupChats[item.groupId] || []).some(chat => String(chat.messageId) === item.messageId);
}

function buildNote(scope, payload, context, previous, now) {
  assertNoteTime(previous, now);
  const source = noteSource(context, now);
  const days = payload.ttlDays === undefined ? 30 : Number(payload.ttlDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw memoryError("有效期应为 1 到 90 天。");
  const title = cleanNoteText(payload.title ?? previous?.title, 32);
  const text = cleanNoteText(payload.text, 300);
  return {
    id: previous?.id || randomBytes(6).toString("hex"), ...scope, title, text,
    kind: source.kind === "user_command" ? "user_statement" : "operator_note", source,
    replacedSources: priorSources(previous),
    revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now,
    updatedAt: now, expiresAt: now + days * DAY,
  };
}

function assertNoteTime(previous, now) {
  if (!Number.isSafeInteger(now) || now <= 0 || (previous && now < previous.updatedAt)) throw memoryError("系统时间早于旧修订或无效，请校准后重试，本次未覆盖记忆。", 409);
}

function noteSource(context, now) {
  const kind = context.origin === "user_command" ? "user_command" : "operator";
  const messageId = kind === "user_command" ? sourceMessageId(context.messageId) : "";
  if (kind === "user_command" && !messageId) throw memoryError("缺少消息来源，本次没有保存记忆。");
  return { kind, messageId, at: now };
}
function priorSources(previous) { return previous ? [...new Set([...previous.replacedSources, previous.source.messageId].filter(Boolean))].slice(-8) : []; }

function cleanNoteText(value, limit) {
  if (typeof value !== "string") throw memoryError("标题和内容不能为空。");
  const text = value.normalize("NFKC").replace(/\p{Cc}/gu, " ").trim();
  if (!text || text.length > limit) throw memoryError("标题最多 32 字，内容最多 300 字，且不能为空。");
  if (containsSensitiveText(text) || redactSensitiveText(text) !== text) throw memoryError("内容含敏感信息，未保存。请先去掉凭据或隐私信息。");
  return text;
}

export function normalizeNoteScope(value = {}) {
  const userId = positiveId(value.userId);
  const groupId = value.groupId === "private" ? "private" : positiveId(value.groupId);
  if (!userId || !groupId) throw memoryError("请选择群聊或私聊范围，并填写有效 QQ 号。");
  return { userId, groupId };
}

function positiveId(value) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return "";
  const text = String(value);
  return /^[1-9]\d{0,19}$/.test(text) ? text : "";
}
function sourceMessageId(value) { return typeof value === "string" || Number.isSafeInteger(value) ? (/^-?\d{1,20}$/.test(String(value)) ? String(value) : "") : ""; }
function sameScope(a, b) { return a.userId === b.userId && a.groupId === b.groupId; }
function matchesClear(item, filter) { return (filter.userId && item.userId === String(filter.userId)) || (filter.groupId && item.groupId === String(filter.groupId)); }
function snapshotRevision(root, scope, cutoff) { return createHash("sha256").update(JSON.stringify([root.revision, scope, cutoff, root.items.filter(item => sameScope(item, scope))])).digest("hex"); }

function projectSnapshot(root, scope, now, cutoff) {
  return { ok: true, ...scope, revision: snapshotRevision(root, scope, cutoff),
    items: root.items.filter(item => sameScope(item, scope) && item.source.at > cutoff).map(item => projectNote(item, now)),
    limits: MEMORY_NOTE_LIMITS, legacyInferenceIgnored: true };
}

function projectNote(item, now) {
  return { id: item.id, userId: item.userId, groupId: item.groupId, kind: item.kind,
    source: { kind: item.source.kind, messageId: item.source.messageId, at: item.source.at }, replacedSources: [...item.replacedSources],
    revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt, expiresAt: item.expiresAt,
    title: redactSensitiveText(item.title), text: redactSensitiveText(item.text), state: item.expiresAt > now ? "active" : "expired" };
}

function validateRoot(root) {
  if (!root || root.schema !== 1 || !Number.isSafeInteger(root.revision) || root.revision < 0 || !Array.isArray(root.items) || root.items.length > MAX_TOTAL) throw invalidStore();
  const ids = new Set();
  for (const item of root.items) {
    if (!validNote(item) || ids.has(item.id)) throw invalidStore();
    ids.add(item.id);
  }
  if (root.retractions !== undefined && (!Array.isArray(root.retractions) || root.retractions.length > MAX_RETRACTIONS || !root.retractions.every(validRetraction))) throw invalidStore();
}

function validRetraction(item) { return item && ID.test(item.noteId) && validScope(item) && sourceMessageId(item.messageId) === item.messageId && Number.isFinite(item.at) && item.at > 0; }

function validNote(item) {
  return item && ID.test(item.id) && validScope(item) && validText(item) && KINDS.has(item.kind) &&
    validSource(item) && validTimes(item) && Number.isSafeInteger(item.revision) && item.revision > 0 &&
    Array.isArray(item.replacedSources) && item.replacedSources.length <= 8 && item.replacedSources.every(value => sourceMessageId(value) === value);
}
function validScope(item) { return Boolean(positiveId(item.userId)) && positiveId(item.userId) === item.userId &&
  (item.groupId === "private" || (Boolean(positiveId(item.groupId)) && positiveId(item.groupId) === item.groupId)); }
function validText(item) { return typeof item.title === "string" && item.title.length > 0 && item.title.length <= 32 && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 300; }
function validSource(item) {
  const source = item.source;
  if (!source || !Number.isFinite(source.at) || source.at <= 0) return false;
  return item.kind === "user_statement" ? source.kind === "user_command" && Boolean(sourceMessageId(source.messageId))
    : source.kind === "operator" && source.messageId === "";
}
function validTimes(item) { return [item.createdAt, item.updatedAt, item.expiresAt].every(value => Number.isFinite(value) && value > 0 && value < 8640000000000000) &&
  item.expiresAt > item.updatedAt && item.expiresAt - item.updatedAt <= 90 * DAY && item.updatedAt >= item.createdAt && item.source.at === item.updatedAt; }
function invalidStore() { return memoryError("记忆条目格式异常，已停止读取和修改，请管理员检查。", 503); }
function memoryError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function privacyCutoff(scope, readPrivacy) {
  try {
    const value = readPrivacy();
    if (!value?.users || typeof value.users !== "object" || Array.isArray(value.users)) throw invalidStore();
    const cutoff = value.users[scope.userId] ?? 0;
    if (!Number.isFinite(cutoff) || cutoff < 0) throw invalidStore();
    return cutoff;
  } catch { throw memoryError("隐私状态暂不可读，已停止读取和修改记忆。", 503); }
}

export const memoryNoteService = createMemoryNoteService();
export const memoryNotesSnapshot = scope => memoryNoteService.snapshot(scope);
export const applyMemoryNoteAction = (payload, context) => memoryNoteService.act(payload, context);
export const memoryCorrectionSnapshot = scope => memoryNoteService.corrections(scope);
