import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CFG } from "../config.mjs";
import { users, saveUsers, flushSavesSync } from "../storage.mjs";
import { getUserPreferences, parseStylePreference, sanitizeDisplayName, setUserDisplayName, setUserStylePreference } from "../user-preferences.mjs";
import { createMemoryNoteService, memoryNotesSnapshot, memoryNotesOwnedRevision, applyMemoryNoteAction } from "../memory-profile/notes.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../memory-profile/generation.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { containsSensitiveText } from "../privacy.mjs";
import { readJsonFile } from "../persistence/json-file.mjs";
import { autonomousPreparationAllowed } from "./preparation-policy.mjs";

const ACTION_KEYS = Object.freeze({ set_name: ["value"], set_style: ["value"],
  memory_create: ["title", "text", "ttlDays"], memory_update: ["noteId", "text"], memory_remove: ["noteId"] });
const OPTIONAL = new Set(["ttlDays"]);
const ID = /^[1-9]\d{0,19}$/;
const MESSAGE_ID = /^(?:0|-?[1-9]\d{0,19})$/;
const HASH = /^[a-f0-9]{64}$/;
const NOTE_ID = /^[a-f0-9]{12}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]|\[CQ:|<\/?(?:think(?:ing)?|analysis|reasoning|system|developer)\b|reasoning_content|chain.of.thought|思维链|隐藏推理|```|\b(?:basic|bearer|digest|negotiate|ntlm)\s+\S+|\b(?:file|https?):|[a-z]:[\\/]|(?:^|[\s=:"'([{])(?:\/|\\\\|\.{1,2}[\\/]|~[\\/])|(?:忽略|绕过).{0,12}(?:规则|指令)|ignore.{0,20}instructions/iu;
const ACK = Object.freeze({ set_name: "已更新你的称呼。", set_style: "已更新你的回复风格。",
  memory_create: "已保存你的这条记忆。", memory_update: "已更新你的这条记忆。", memory_remove: "已删除你的这条记忆。" });
const DEFAULTS = { saveUsers, flushSavesSync, setUserDisplayName, setUserStylePreference,
  memoryNotesSnapshot, applyMemoryNoteAction, readPrivacy: summaryPrivacy };

// The parent binds the immutable operation to its one-time confirmation store; no execute tool is exposed here.
export function createPersonalChangeAdapter(options = {}) {
  const injected = process.env.NODE_ENV === "test";
  const store = injected && Object.hasOwn(options, "users") ? options.users : users;
  const services = Object.fromEntries(Object.entries(DEFAULTS).map(([key, implementation]) =>
    [key, injected && typeof options[key] === "function" ? options[key] : implementation]));
  const customStore = store !== users;
  const seen = new Set();

  function prepare(args, runtime) {
    try {
      const input = parseArguments(args);
      const guard = runtimeGuard(runtime);
      guard.check();
      const state = readState(input.action, guard);
      const parameters = normalizeParameters(input.action, input.parameters);
      validateNoteTarget(input.action, parameters, state.snapshot);
      if (guard.autonomous ? !autonomousPreparationAllowed(guard.userMessage, "personal")
        : !explicitIntent(input.action, parameters, guard.userMessage, state.snapshot)) reject("explicit_intent_required");
      const operation = { domain: "personal", action: input.action, parameters, baseline: state.baseline,
        preview: preview(input.action, parameters) };
      guard.check();
      if (JSON.stringify(operation).length > 4096) reject("invalid_arguments");
      return { status: "ready", operation };
    } catch (error) { return preparationFailure(safeReason(error)); }
  }

  function commit(value, runtime) {
    let started = false;
    try {
      const operation = parseOperation(value);
      const guard = runtimeGuard(runtime);
      guard.check();
      const state = readState(operation.action, guard);
      if (state.baseline.revision !== operation.baseline.revision ||
          state.baseline.sourceIdentity !== operation.baseline.sourceIdentity) reject("conflict");
      validateNoteTarget(operation.action, operation.parameters, state.snapshot);
      guard.check();
      // Existing setters intentionally invalidate the old context. Only pre-write checks use that context.
      started = true;
      const result = operation.action.startsWith("memory_")
        ? writeNote(operation, guard.scope, state.snapshot, guard.messageId, services)
        : writePreference(operation, guard.scope.userId, store, services);
      if (result !== true) return failure("unknown", "persistence_unknown");
      return { ok: true, status: "applied", text: ACK[operation.action] };
    } catch (error) {
      // A service may have renamed a durable file before throwing. Never roll back or replay here.
      return failure(started ? "unknown" : "not_applied", started ? "persistence_unknown" : safeReason(error));
    }
  }

  function readState(action, guard) {
    const cfg = guard.cfg;
    const memory = action.startsWith("memory_");
    const filename = sourceFile(cfg, memory, customStore, options);
    const privacy = privacyBaseline(services, guard);
    const snapshot = memory ? ownNoteSnapshot(services, guard.scope) : undefined;
    const ownedRevision = memory && !customStore ? memoryNotesOwnedRevision(guard.scope) : null;
    // Saver checkpoints and automatically refreshed aliases are not edits to the reviewed personal fields.
    const current = memory ? [snapshot.items, ownedRevision] : preferenceRevision(store, guard.scope.userId);
    if (!customStore) {
      const disk = checkedDisk(filename, seen);
      const diskCurrent = memory ? validateProfileDisk(disk, guard.scope, privacy[1]) : hash(preferenceRevision(disk, guard.scope.userId));
      if (diskCurrent !== (memory ? ownedRevision : hash(current))) reject("conflict");
    }
    const sourceIdentity = hash([path.resolve(filename), path.resolve(cfg.dataRoot), guard.scope, memory ? "notes" : "preferences"]);
    return { snapshot, baseline: { sourceIdentity, revision: hash([current, privacy, getMemoryPrivacyGeneration()]) } };
  }

  return { prepare, commit };
}

function sourceFile(cfg, memory, customStore, options) {
  if (customStore && ["saveUsers", "flushSavesSync"].some(key => typeof options[key] !== "function")) reject("storage_unavailable");
  if (!customStore && ["memoryFile", "memoryProfileFile", "dataRoot"].some(key => cfg[key] !== CFG[key])) reject("storage_unavailable");
  const filename = memory ? cfg.memoryProfileFile : cfg.memoryFile;
  if (typeof filename !== "string" || !filename || typeof cfg.dataRoot !== "string" || !cfg.dataRoot) reject("storage_unavailable");
  return filename;
}

function privacyBaseline(services, guard) {
  const privacy = services.readPrivacy({ root: path.join(guard.cfg.dataRoot, ".qqfriend", "summaries") });
  if (!plain(privacy) || !plain(privacy.users) || !Number.isSafeInteger(privacy.epoch) || privacy.epoch < 0) reject("storage_unavailable");
  const cutoff = privacy.users[guard.scope.userId] ?? 0;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) reject("storage_unavailable");
  return [privacy.epoch, cutoff];
}

function ownNoteSnapshot(services, scope) {
  const snapshot = services.memoryNotesSnapshot({ userId: scope.userId, groupId: scope.groupId });
  if (!snapshot?.ok || snapshot.userId !== scope.userId || snapshot.groupId !== scope.groupId ||
      typeof snapshot.revision !== "string" || !HASH.test(snapshot.revision) || !Array.isArray(snapshot.items)) reject("storage_unavailable");
  return snapshot;
}

function preferenceRevision(store, uid) {
  if (!plain(store)) reject("storage_unavailable");
  const user = store[uid];
  if (user !== undefined && (!plain(user) || (user.preferences !== undefined && !plain(user.preferences)))) reject("storage_unavailable");
  return [getUserPreferences(uid, store), getUserMemoryGeneration(uid)];
}

function validateProfileDisk(value, scope, cutoff) {
  if (["userProfiles", "groupProfiles", "userGroupProfiles"].some(key => value[key] !== undefined && !plain(value[key]))) reject("storage_unavailable");
  return createMemoryNoteService({ profiles: value, available: () => true,
    readPrivacy: () => ({ users: { [scope.userId]: cutoff } }) }).ownedRevision(scope);
}

function runtimeGuard(runtime) {
  if (!runtime || !plain(runtime.scope) || runtime.scope.surface !== "group" || !plain(runtime.cfg) ||
      typeof runtime.assertCurrent !== "function" || typeof runtime.isPermitted !== "function" || !(runtime.signal instanceof AbortSignal)) reject("guard_unavailable");
  const scope = Object.freeze({ surface: "group", userId: decimal(runtime.scope.userId, ID), groupId: decimal(runtime.scope.groupId, ID) });
  const messageId = decimal(runtime.messageId, MESSAGE_ID);
  const userMessage = runtime.userMessage;
  const autonomous = runtime.autonomous === true;
  if (typeof userMessage !== "string" || !userMessage.trim() || userMessage.length > 8192) reject("invalid_arguments");
  const cfg = runtime.cfg;
  const configuration = hash(cfg);
  const signal = runtime.signal;
  const assertCurrent = runtime.assertCurrent;
  const isPermitted = runtime.isPermitted;
  function checkBinding() {
    if (runtime.cfg !== cfg || hash(cfg) !== configuration || runtime.signal !== signal ||
        runtime.assertCurrent !== assertCurrent || runtime.isPermitted !== isPermitted ||
        runtime.scope?.surface !== scope.surface || String(runtime.scope?.userId) !== scope.userId ||
        String(runtime.scope?.groupId) !== scope.groupId || runtime.userMessage !== userMessage ||
        decimal(runtime.messageId, MESSAGE_ID) !== messageId || (runtime.autonomous === true) !== autonomous) reject("stale_request");
  }
  function check() {
    if (signal.aborted) reject("cancelled");
    checkBinding();
    try { if (assertCurrent() === false) reject("stale_request"); }
    catch { reject("stale_request"); }
    if (!Array.isArray(cfg.agentWriteGroupWhitelist) || !cfg.agentWriteGroupWhitelist.some(group => String(group) === scope.groupId)) reject("not_allowed");
    if (isPermitted(scope) !== true) reject("not_allowed");
    if (signal.aborted) reject("cancelled");
    checkBinding();
  }
  return { scope, cfg, userMessage, messageId, autonomous, check };
}

function parseArguments(value) {
  const args = record(value);
  if (typeof args.action !== "string" || !Object.hasOwn(ACTION_KEYS, args.action)) reject("invalid_arguments");
  const keys = ACTION_KEYS[args.action];
  if (Object.keys(args).some(key => key !== "action" && !keys.includes(key)) ||
      keys.some(key => !OPTIONAL.has(key) && !Object.hasOwn(args, key))) reject("invalid_arguments");
  return { action: args.action, parameters: Object.fromEntries(keys.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])) };
}

function normalizeParameters(action, value) {
  const input = record(value);
  if (typeof action !== "string" || !Object.hasOwn(ACTION_KEYS, action) ||
      Object.keys(input).some(key => !ACTION_KEYS[action].includes(key))) reject("invalid_arguments");
  const args = parseArguments({ ...input, action });
  const p = args.parameters;
  if (action === "set_name") {
    safeText(p.value, 64);
    const clean = sanitizeDisplayName(p.value);
    if (!clean.ok) reject("invalid_arguments");
    return { value: clean.value };
  }
  if (action === "set_style") {
    safeText(p.value, 120);
    const parsed = parseStylePreference(p.value);
    if (!parsed.ok || parsed.unknown.length) reject("invalid_arguments");
    return { value: p.value.trim() };
  }
  if (action === "memory_create") {
    return normalizeNewNote(p);
  }
  if (typeof p.noteId !== "string" || !NOTE_ID.test(p.noteId)) reject("invalid_arguments");
  if (action === "memory_update") safeText(p.text, 300);
  return { noteId: p.noteId, ...(action === "memory_update" ? { text: p.text } : {}) };
}

function normalizeNewNote(p) {
  safeText(p.title, 32); safeText(p.text, 300);
  if (Object.hasOwn(p, "ttlDays") && (!Number.isInteger(p.ttlDays) || p.ttlDays < 1 || p.ttlDays > 90)) reject("invalid_arguments");
  return { title: p.title, text: p.text, ...(Object.hasOwn(p, "ttlDays") ? { ttlDays: p.ttlDays } : {}) };
}

function parseOperation(value) {
  const op = record(value);
  if (Object.keys(op).length !== 5 || Object.keys(op).some(key => !["domain", "action", "parameters", "baseline", "preview"].includes(key)) || op.domain !== "personal") reject("invalid_arguments");
  const parameters = normalizeParameters(op.action, op.parameters);
  const baseline = parseBaseline(op.baseline);
  if (typeof op.preview !== "string" || op.preview !== preview(op.action, parameters) || op.preview.length > 1200 ||
      Object.keys(parameters).some(key => parameters[key] !== op.parameters[key]) || JSON.stringify(op).length > 4096) reject("invalid_arguments");
  return { domain: "personal", action: op.action, parameters, baseline, preview: op.preview };
}

function parseBaseline(value) {
  const baseline = record(value);
  if (Object.keys(baseline).length !== 2 || typeof baseline.revision !== "string" || typeof baseline.sourceIdentity !== "string" ||
      !HASH.test(baseline.revision) || !HASH.test(baseline.sourceIdentity) ||
      !Object.hasOwn(baseline, "revision") || !Object.hasOwn(baseline, "sourceIdentity")) reject("invalid_arguments");
  return baseline;
}

function explicitIntent(action, p, message, snapshot) {
  const text = message.trim().replace(/^@[^\s@]{1,32}\s+/, "").replace(/^(?:请)?(?:帮我)?\s*/, "");
  if (/[\p{Cc}\p{Cf}]/u.test(text) || /\[CQ:|```|<\/?(?:think|analysis|system|developer)\b/iu.test(text)) return false;
  if (action === "set_name") {
    const match = /^(?:叫我|称呼我|把我的称呼改为|call me\s+|set my name to\s+)(.+)$/iu.exec(text);
    return Boolean(match && sanitizeDisplayName(match[1]).value === p.value);
  }
  if (action === "set_style") {
    const match = /^(?:回复风格\s*|(?:把)?我的回复风格(?:改为|设为|设置为|[：:])\s*|set my (?:reply )?style to\s+)(.+)$/iu.exec(text);
    return Boolean(match && match[1].trim() === p.value);
  }
  if (action === "memory_create") {
    const match = /^(?:记住[：:\s]*|remember\s+)(.+)$/iu.exec(text);
    return Boolean(match && match[1].includes(p.text));
  }
  return existingNoteIntent(action, p, text, snapshot);
}

function existingNoteIntent(action, p, text, snapshot) {
  const verb = action === "memory_update" ? "(?:更新|修改|纠正)" : "(?:删除|移除|忘掉)";
  const pattern = new RegExp("^(?:" + verb + "(?:我的)?记忆\\s*|" + (action === "memory_update" ? "update" : "delete") + " my memory\\s+)" + p.noteId + "(?:[，,:：\\s]+(.*))?$", "iu");
  const match = pattern.exec(text);
  if (!match) return false;
  if (action === "memory_remove") return !match[1] || /^(?:请删除|delete)$/iu.test(match[1]);
  return Boolean(match[1]?.includes(p.text) || (match[1] === "已核对原文，保留原文" &&
    snapshot.items.some(item => item.id === p.noteId && item.text === p.text)));
}

function validateNoteTarget(action, p, snapshot) {
  if (!action.startsWith("memory_")) return;
  if (action === "memory_create") {
    if (snapshot.items.some(item => item.state === "active" && item.title === p.title) || snapshot.items.filter(item => item.state === "active").length >= 32) reject("conflict");
  } else if (!snapshot.items.some(item => item.id === p.noteId && (action === "memory_remove" || item.state === "active"))) reject("conflict");
}

function writePreference(op, uid, store, services) {
  const setter = op.action === "set_name" ? services.setUserDisplayName : services.setUserStylePreference;
  if (setter(uid, op.parameters.value, { users: store, skipSave: true })?.ok !== true) return false;
  services.saveUsers();
  return services.flushSavesSync({ durable: true }) === true;
}

function writeNote(op, scope, snapshot, messageId, services) {
  const { noteId, ...parameters } = op.parameters;
  const result = services.applyMemoryNoteAction({ userId: scope.userId, groupId: scope.groupId,
    action: op.action.slice(7), revision: snapshot.revision, ...parameters, ...(noteId ? { id: noteId } : {}) },
  { origin: "user_command", messageId });
  return result?.ok === true && result.userId === scope.userId && result.groupId === scope.groupId &&
    typeof result.revision === "string" && result.revision !== snapshot.revision;
}

function preview(action, p) {
  if (action === "set_name") return "将你的称呼设为：" + p.value;
  if (action === "set_style") return "将你的回复风格设为：" + p.value;
  if (action === "memory_remove") return "将删除你的记忆条目：" + p.noteId;
  if (action === "memory_update") return "将更新你的记忆条目：" + p.noteId + "；内容：" + p.text;
  return "将保存你的记忆：" + p.title + "；内容：" + p.text + "；有效期：" + (p.ttlDays ?? 30) + "天。";
}

function safeText(value, limit) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.normalize("NFKC") !== value ||
      value.length > limit || UNSAFE.test(value) || containsSensitiveText(value)) reject("invalid_arguments");
}
function checkedDisk(filename, seen) {
  const resolved = path.resolve(filename);
  try { fs.lstatSync(resolved); }
  catch (error) {
    if (error.code === "ENOENT" && !seen.has(resolved)) return {};
    reject("storage_unavailable");
  }
  seen.add(resolved);
  const missing = Symbol("missing");
  const value = readJsonFile(resolved, missing, { maxBytes: 64 * 1024 * 1024 });
  if (!plain(value)) reject("storage_unavailable");
  return value;
}
function decimal(value, pattern) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0))) reject("invalid_arguments");
  const text = String(value);
  if (!pattern.test(text)) reject("invalid_arguments");
  return text;
}
function plain(value) { return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function record(value) {
  if (!plain(value)) reject("invalid_arguments");
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        ["__proto__", "constructor", "prototype"].includes(key)) reject("invalid_arguments");
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function reject(reason) { throw Object.assign(new Error("Personal change rejected"), { personalReason: reason }); }
function safeReason(error) { return ["invalid_arguments", "guard_unavailable", "explicit_intent_required", "conflict", "not_allowed", "cancelled", "stale_request", "storage_unavailable"].includes(error?.personalReason) ? error.personalReason : "storage_unavailable"; }
function preparationFailure(reason) {
  const status = reason === "invalid_arguments" ? "invalid_arguments"
    : ["guard_unavailable", "storage_unavailable"].includes(reason) ? "unavailable" : "denied";
  return { status, reason };
}
function failure(status, reason) {
  return { ok: false, status, reason, text: status === "unknown" ? "保存结果无法确认，请检查状态；不要重复执行。" : "本次没有修改你的资料，请重新查看后发起请求。" };
}
