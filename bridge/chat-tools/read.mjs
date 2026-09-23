import { CFG } from "../config.mjs";
import { users } from "../storage.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { memoryNotesSnapshot, memoryCorrectionSnapshot } from "../memory-profile/notes.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { compareRelevance, retrievalFeatures } from "../context/relevance.mjs";
import { normalizeCommand } from "../commands/normalize.mjs";
import { buildCapabilityCatalog } from "../capabilities/catalog.mjs";
import { safeModelIdentity } from "../capabilities/self-context.mjs";
import { readApiProviderHealth } from "../api-providers/health.mjs";
import { peekJmRuntimeHealth } from "../jm/runtime.mjs";
import { getCachedNapCatReadiness } from "../napcat-readiness.mjs";
import { VERSION } from "../version.mjs";

const DAY = 86400000;
const MAX_JSON_CHARS = 1800;
const RECALL_KEYS = new Set(["query", "days", "limit", "kind"]);
const NO_KEYS = new Set();
const NOTE_ID = /^[a-f0-9]{12}$/;
const COMMAND = /^(?:\[command\]|\[\u5df2\u6309\u7528\u6237\u8bf7\u6c42\u6e05\u9664\]|(?:\u6211\u7684\u8bb0\u5fc6|\u8bb0\u5fc6\u5e2e\u52a9|\u8bb0\u4f4f|\u7ea0\u6b63\u8bb0\u5fc6|\u5220\u9664\u8bb0\u5fc6)(?=\s|$))/u;

// Scope and options are backend-owned; only args may come from a model call.
export function recallMemory(scope, args = {}, options = {}) {
  const result = memoryResult(scope);
  const request = recallArguments(args);
  if (!request) return failure(result, "invalid_arguments", "invalid_arguments");
  const cfg = options.cfg ?? CFG;
  const access = authorize(scope, cfg);
  if (!access.scope) return failure(result, "denied", access.reason);
  try {
    const now = readNow(options);
    const cutoff = readCutoff(access.scope, options);
    const noteScope = { userId: access.scope.userId, groupId: access.scope.groupId };
    const snapshot = (options.snapshot ?? memoryNotesSnapshot)(noteScope);
    const corrections = (options.corrections ?? memoryCorrectionSnapshot)(noteScope);
    assertSnapshots(snapshot, corrections);
    const context = { ...access.scope, ...request, now, cutoff, features: retrievalFeatures(request.query),
      commandOptions: { requireMention: true, selfUin: cfg.selfUin, botNames: cfg.botNames ?? [] } };
    const notes = snapshot.items.filter(item => sameScope(item, context));
    const excluded = excludedSources(notes, corrections, context.currentMessageId);
    const candidates = request.kind === "history" ? [] : noteCandidates(notes, corrections, context);
    candidates.push(...readHistoryCandidates(options, excluded, context));
    return packMemory(result, candidates, request.limit);
  } catch {
    return failure(result, "unavailable", "memory_unavailable");
  }
}

export function readBotStatus(scope, args = {}, options = {}) {
  const result = { status: "ok", scope: publicScope(scope), capabilities: [] };
  if (!onlyKeys(args, NO_KEYS)) return failure(result, "invalid_arguments", "invalid_arguments");
  const cfg = options.cfg ?? CFG;
  const access = authorize(scope, cfg);
  if (!access.scope) return failure(result, "denied", access.reason);
  try {
    readCutoff(access.scope, options);
    const now = readNow(options);
    const modelHealth = options.modelHealth ?? readApiProviderHealth();
    // Always supply the peek result: the catalog's default JM reader can start a probe.
    const jmHealth = options.jmHealth ?? peekJmRuntimeHealth();
    const napcat = options.napcatHealth ?? getCachedNapCatReadiness();
    const napcatHealth = freshNapcat(napcat, now) ? "ready" : "unknown";
    const catalog = buildCapabilityCatalog({ cfg, ...access.scope, admins: [], modelHealth, jmHealth,
      stickerSettings: options.stickerSettings });
    result.capabilities = catalog.capabilities
      .filter(item => item.permission === "user" && item.state.permitted === true && item.state.enabled === true)
      .map(item => publicCapability(item, napcatHealth));
    result.version = VERSION;
    result.napcat = { health: napcatHealth };
    if (options.provider && Object.hasOwn(options.provider, "model")) {
      result.requestedModel = safeModelIdentity(options.provider.model);
    }
    return result;
  } catch {
    return failure(result, "unavailable", "status_unavailable");
  }
}

function plainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function onlyKeys(value, allowed) {
  return plainObject(value) && Reflect.ownKeys(value).every(key =>
    allowed.has(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

function recallArguments(args) {
  if (!onlyKeys(args, RECALL_KEYS) || typeof args.query !== "string") return null;
  const query = args.query.trim();
  const { days = 30, limit = 4, kind = "both" } = args;
  if (!query || args.query.length > 160 || !Number.isInteger(days) || days < 1 || days > 90) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 6 || !["both", "notes", "history"].includes(kind)) return null;
  return { query: query.normalize("NFKC").toLowerCase(), days, limit, kind };
}

function numericId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value);
  return /^[1-9]\d{0,19}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : "";
}

function messageId(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return "";
  return /^-?\d{1,20}$/.test(String(value)) ? String(value) : "";
}

function normalizeScope(scope) {
  if (!plainObject(scope) || !["group", "private"].includes(scope.surface)) return null;
  const userId = numericId(scope.userId);
  const groupId = scope.surface === "private" ? "private" : numericId(scope.groupId);
  if (!userId || !groupId) return null;
  if (scope.surface === "private" && ![undefined, null, "private"].includes(scope.groupId)) return null;
  const currentMessageId = scope.currentMessageId === undefined ? "" : messageId(scope.currentMessageId);
  if (scope.currentMessageId !== undefined && !currentMessageId) return null;
  return { surface: scope.surface, userId, groupId, currentMessageId };
}

function authorize(value, cfg) {
  const scope = normalizeScope(value);
  if (!scope) return { reason: "invalid_scope" };
  if (!Array.isArray(cfg?.botBlacklist)) return { reason: "permission_unknown" };
  if (includesId(cfg.botBlacklist, scope.userId) || numericId(cfg.selfUin) === scope.userId) return { reason: "permission_denied" };
  const permitted = scope.surface === "group" ? includesId(cfg.groupWhitelist, scope.groupId) : includesId(cfg.friendWhitelist, scope.userId);
  return permitted ? { scope } : { reason: "permission_denied" };
}

function includesId(list, id) { return Array.isArray(list) && list.some(value => numericId(value) === id); }
function publicScope(scope) { return scope?.surface === "private" ? "private" : "current_group"; }
function memoryResult(scope) { return { status: "empty", scope: publicScope(scope), items: [], memorySources: [] }; }
function failure(result, status, reason) { return { ...result, status, reason }; }

function readNow(options) {
  const now = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  if (!timestamp(now)) throw new Error("invalid_time");
  return now;
}

function readCutoff(scope, options) {
  const privacy = (options.readPrivacy ?? summaryPrivacy)();
  if (!plainObject(privacy?.users)) throw new Error("privacy_unavailable");
  if (privacy.epoch !== undefined && (!Number.isSafeInteger(privacy.epoch) || privacy.epoch < 0)) throw new Error("privacy_unavailable");
  const cutoff = Object.hasOwn(privacy.users, scope.userId) ? privacy.users[scope.userId] : 0;
  if (cutoff !== 0 && !timestamp(cutoff)) throw new Error("privacy_unavailable");
  return cutoff;
}

function timestamp(value) { return Number.isSafeInteger(value) && value > 0 && value < 8640000000000000; }
function inWindow(at, context) { return timestamp(at) && at > context.cutoff && at <= context.now && at >= context.now - context.days * DAY; }
function sameScope(item, context) { return item && numericId(item.userId) === context.userId && String(item.groupId) === context.groupId; }

function assertSnapshots(snapshot, corrections) {
  if (!snapshot || snapshot.ok === false || !Array.isArray(snapshot.items)) throw new Error("invalid_notes");
  if (!(corrections?.excludedMessageIds instanceof Set) || !(corrections.revisions instanceof Map)) throw new Error("invalid_corrections");
}

function excludedSources(notes, corrections, currentMessageId) {
  const excluded = new Set([...corrections.excludedMessageIds].map(messageId).filter(Boolean));
  if (currentMessageId) excluded.add(currentMessageId);
  // Even expired or out-of-window explicit commands must not reappear as raw history.
  for (const note of notes) {
    for (const id of [note.source?.messageId, ...(Array.isArray(note.replacedSources) ? note.replacedSources : [])]) {
      if (messageId(id)) excluded.add(messageId(id));
    }
  }
  return excluded;
}

function validNote(note, corrections, context) {
  if (typeof note.id !== "string" || !NOTE_ID.test(note.id) || !Number.isSafeInteger(note.revision) || note.revision < 1) return false;
  if (note.state !== "active" || !inWindow(note.source?.at, context) || !timestamp(note.expiresAt) || note.expiresAt <= context.now) return false;
  if (corrections.revisions.get(note.id) !== note.revision) return false;
  return validNoteSource(note, corrections, context);
}

function validNoteSource(note, corrections, context) {
  if (note.kind === "operator_note") return note.source.kind === "operator" && note.source.messageId === "";
  if (note.kind !== "user_statement" || note.source.kind !== "user_command" || !messageId(note.source.messageId)) return false;
  const id = messageId(note.source.messageId);
  return id !== context.currentMessageId && !corrections.excludedMessageIds.has(id);
}

function noteCandidates(notes, corrections, context) {
  const candidates = [];
  for (const note of notes) {
    if (!validNote(note, corrections, context)) continue;
    const text = cleanText(note.text, 300);
    const title = cleanText(note.title, 32);
    const score = relevance(title + " " + text, context);
    if (!text || !title || !score) continue;
    candidates.push({ priority: note.revision > 1 ? 2 : 1, score, item: {
      kind: note.kind, text, title, source: { noteId: note.id, revision: note.revision,
        messageId: messageId(note.source.messageId), at: note.source.at, expiresAt: note.expiresAt },
    } });
  }
  return candidates;
}

function readHistoryCandidates(options, excluded, context) {
  // Private logs and legacy/global profiles are deliberately never accessed.
  if (context.surface !== "group" || context.kind === "notes") return [];
  const chats = (options.users ?? users)[context.userId]?.chats ?? [];
  if (!Array.isArray(chats)) throw new Error("invalid_history");
  const candidates = [];
  for (const chat of chats) {
    if (!historySourceUsable(chat, context) || excluded.has(messageId(chat.messageId))) continue;
    if ([chat.replyToMessageId, chat.turnId].some(id => id !== undefined && excluded.has(messageId(id)))) continue;
    const text = cleanText(chat.text, 300);
    const commandText = normalizeCommand(text, context.commandOptions);
    const score = relevance(text, context);
    if (!text || COMMAND.test(commandText) || !score) continue;
    candidates.push({ priority: 0, score, item: {
      kind: "historical_message", text, source: { messageId: messageId(chat.messageId), at: chat.ts },
    } });
  }
  return candidates;
}

function historySourceUsable(chat, context) {
  if (!chat || String(chat.group) !== context.groupId || !messageId(chat.messageId) || !inWindow(chat.ts, context)) return false;
  if (chat.memoryCommand || chat.retracted || chat.deleted || chat.recalled) return false;
  if ([chat.uid, chat.userId, chat.user_id].some(id => id !== undefined && numericId(id) !== context.userId)) return false;
  return chat.receivedAt === undefined || (timestamp(chat.receivedAt) && chat.receivedAt > context.cutoff && chat.receivedAt <= context.now);
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  const text = redactSensitiveText(value.normalize("NFKC")).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 3).join("") + "..." : text;
}

function relevance(text, context) {
  return text.toLowerCase().includes(context.query) ? 10 : compareRelevance(context.features, retrievalFeatures(text)).score;
}

function packMemory(result, candidates, limit) {
  const seenText = new Set();
  const seenId = new Set();
  candidates.sort((a, b) => b.priority - a.priority || b.score - a.score || b.item.source.at - a.item.source.at);
  for (const { item } of candidates) {
    const textKey = item.text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
    const { noteId, revision, messageId: id } = item.source;
    if (!textKey || seenText.has(textKey) || (id && seenId.has(id)) || (noteId && seenId.has(noteId))) continue;
    const next = { ...result, status: "ok", items: [...result.items, item],
      memorySources: noteId ? [...result.memorySources, { noteId, revision }] : result.memorySources };
    // Drop whole records, including their revision dependency, rather than slicing JSON.
    if (JSON.stringify(next).length > MAX_JSON_CHARS) continue;
    result = next;
    seenText.add(textKey);
    if (id) seenId.add(id);
    if (noteId) seenId.add(noteId);
    if (result.items.length >= limit) break;
  }
  return result;
}

function freshNapcat(value, now) {
  const at = typeof value?.checkedAt === "string" ? Date.parse(value.checkedAt) : NaN;
  return value?.ready === true && value.loggedIn === true && value.userMatches === true &&
    value.stale !== true && Number.isFinite(at) && at <= now && now - at < 5000;
}

function publicCapability(item, napcatHealth) {
  if (item.id === "system.health") return { name: item.name, status: napcatHealth === "ready" ? "available" : "unknown", health: napcatHealth };
  const health = ["configured", "ready"].includes(item.state.health) ? item.state.health : "unknown";
  const unhealthy = ["configuration_error", "degraded"].includes(item.state.health) || (item.id === "resources.jm" && health === "unknown");
  return { name: item.name, status: unhealthy ? "unknown" : item.status, health };
}
