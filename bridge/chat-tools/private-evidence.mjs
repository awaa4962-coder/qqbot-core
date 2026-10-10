import { types } from "node:util";
import { registeredContextSources, registeredContextMemorySources } from "../context/pruning.mjs";
import { normalizeMemoryDependencies } from "../context/memory-dependencies.mjs";
import { containsSensitiveText } from "../privacy.mjs";

const MAX_SCOPE_FIELDS = 32;
const MAX_SCOPE_VALUE = 160;
const MAX_PROTECTED = 512;
const MAX_PROTECTED_CHARS = 32768;
const MAX_STRING = 24000;
const PUBLIC_TOOLS = new Set(["web_search", "read_public_page", "calculate", "read_bot_status"]);
const PRIVATE_KINDS = new Set(["group", "thread", "quote", "memory", "note", "file", "attachment", "image", "recent"]);
const PUBLIC_KINDS = new Set(["current", "public", "system"]);
const NO_DATA = new Set(["empty", "denied", "unavailable", "invalid_arguments", "cancelled"]);
const MEDIA_TYPES = new Set(["image_url", "input_image", "image", "file", "input_file", "input_audio"]);
const SCOPE_LABELS = new Set(["surface", "lane", "task"]);
const IDENTIFIER = /(?:id|uin|ref|token|key|session|conversation|qq)$/i;
const OPAQUE_REF = /\b(?:cf|src|att|draft|rem|mem|task)_[a-f0-9]{12,}\b/gi;

// This is a provenance permission guard, not a replacement for public-query/URL authorization.
export function createPublicQueryGuard(options = {}) {
  let blocked = false;
  let privateContext = false;
  let current = "";
  let protectedChars = 0;
  const protectedText = new Map();
  const failClosed = () => { blocked = true; privateContext = true; return false; };

  function protect(value) {
    if (typeof value === "number") value = String(value);
    if (typeof value !== "string") return;
    const normalized = normalize(value);
    if (!normalized || protectedText.has(normalized)) return;
    if (value.length > MAX_STRING || protectedText.size >= MAX_PROTECTED || protectedChars + value.length > MAX_PROTECTED_CHARS) throw new Error("private_evidence_limit");
    protectedText.set(normalized, value);
    protectedChars += value.length;
  }

  try {
    const input = snapshot(options);
    if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("guard_options_invalid");
    current = bindCurrentInput(input.currentMessage, input.scope === undefined ? {} : input.scope, protect);
  } catch { failClosed(); }

  function trackContext(messages) {
    if (blocked) return false;
    try {
      const copies = snapshot(messages);
      if (!Array.isArray(copies) || copies.length > 128) throw new Error("context_invalid");
      for (let index = 0; index < copies.length; index++) trackMessage(messages[index], copies[index]);
      return true;
    } catch { return failClosed(); }
  }

  function trackMessage(original, message) {
    if (!message || Array.isArray(message) || typeof message !== "object") throw new Error("message_invalid");
    const sources = snapshot(registeredContextSources([original]));
    const memories = snapshot(registeredContextMemorySources([original]));
    if (!normalizeMemoryDependencies(memories)) throw new Error("memory_metadata_invalid");
    const markedPrivate = sources.some(privateSource) || memories.length > 0;
    const fromPrivate = markedPrivate || hasMedia(message);
    collectIdentifiers(message, protect);
    collectIdentifiers(sources, protect);
    collectIdentifiers(memories, protect);
    if (fromPrivate) {
      privateContext = true;
      collectStrings(message.content, value => { if (markedPrivate || normalize(value) !== current) protect(value); });
    }
  }

  function recordToolResult(name, result) {
    if (blocked) return false;
    try {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error("tool_name_invalid");
      const copy = toolResultSnapshot(result);
      collectIdentifiers(copy, protect);
      if (NO_DATA.has(copy.status)) {
        if (hasEmptyData(copy)) throw new Error("no_data_result_has_data");
        return true;
      }
      if (copy.status !== "ok") throw new Error("result_status_invalid");
      if (!PUBLIC_TOOLS.has(name) || hasPrivateMetadata(copy) || hasMedia(copy)) {
        privateContext = true;
        collectStrings(copy, protect, true);
      }
      return true;
    } catch { return failClosed(); }
  }

  function allows(query) {
    if (blocked || typeof query !== "string" || query.length > 160) return false;
    const clean = normalize(query);
    const forms = queryForms(query);
    if (clean.length < 2 || !forms || forms.some(value => /[\p{Cc}\p{Cf}]/u.test(value) || containsSensitiveText(value))) return false;
    if (forms.some(text => [...protectedText.keys()].some(value => text.includes(value)))) return false;
    return !privateContext || current.includes(clean);
  }

  return Object.freeze({ trackContext, recordToolResult,
    // A null supplier result makes public-source URL/query checks fail closed too.
    protectedValues: () => blocked ? null : Object.freeze([...protectedText.values()]),
    allows, hasPrivateContext: () => privateContext });
}

function normalize(value) { return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }

function bindCurrentInput(currentMessage, scope, protect) {
  if (typeof currentMessage !== "string" || !currentMessage.trim() || currentMessage.length > 1000) throw new Error("current_message_invalid");
  const bound = snapshot(scope);
  if (!bound || Array.isArray(bound) || typeof bound !== "object" || Object.keys(bound).length > MAX_SCOPE_FIELDS) throw new Error("scope_invalid");
  for (const [key, value] of Object.entries(bound)) {
    if (value !== null && typeof value === "object") throw new Error("scope_invalid");
    if (typeof value === "string" && value.length > MAX_SCOPE_VALUE) throw new Error("scope_limit");
    validateScopeScalar(key, value);
    if (!SCOPE_LABELS.has(key)) protect(value);
  }
  return normalize(currentMessage);
}

function validateScopeScalar(key, value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("scope_number_invalid");
  if (IDENTIFIER.test(key) && typeof value === "boolean") throw new Error("scope_identity_invalid");
}

function queryForms(value) {
  const forms = [normalize(value)];
  for (let pass = 0; pass < 3; pass++) {
    const previous = forms.at(-1);
    if (!/%[\da-f]{2}/i.test(previous)) return forms;
    try { forms.push(normalize(decodeURIComponent(previous))); } catch { return null; }
  }
  return /%[\da-f]{2}/i.test(forms.at(-1)) ? null : forms;
}

function toolResultSnapshot(result) {
  const copy = snapshot(result);
  if (!copy || Array.isArray(copy) || typeof copy !== "object" || typeof copy.status !== "string") throw new Error("result_invalid");
  return copy;
}

function privateSource(source) {
  if (!source || typeof source !== "object" || typeof source.kind !== "string") throw new Error("source_invalid");
  if (PRIVATE_KINDS.has(source.kind)) return true;
  if (PUBLIC_KINDS.has(source.kind)) return false;
  throw new Error("source_kind_unknown");
}

function hasPrivateMetadata(result) {
  if (result.memorySources !== undefined) {
    const memories = normalizeMemoryDependencies(result.memorySources);
    if (!memories) throw new Error("memory_metadata_invalid");
    if (memories.length) return true;
  }
  if (result.contextSources === undefined) return false;
  if (!Array.isArray(result.contextSources)) throw new Error("source_metadata_invalid");
  return result.contextSources.some(privateSource);
}

function hasEmptyData(result) {
  return ["items", "actions", "tasks", "memorySources", "contextSources", "sources"].some(key => Array.isArray(result[key]) && result[key].length > 0);
}

function hasMedia(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasMedia);
  if (MEDIA_TYPES.has(value.type)) return true;
  return Object.entries(value).some(([key, child]) => ["image_url", "input_image", "input_file"].includes(key) || hasMedia(child));
}

function collectStrings(value, protect, toolRoot = false) {
  if (typeof value === "string") { protect(value); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (toolRoot && key === "status") continue;
    if (key === "type" && (child === "text" || MEDIA_TYPES.has(child))) continue;
    collectStrings(child, protect);
  }
}

function collectIdentifiers(value, protect) {
  if (typeof value === "string") {
    for (const match of value.matchAll(OPAQUE_REF)) protect(match[0]);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (IDENTIFIER.test(key)) protect(child);
    collectIdentifiers(child, protect);
  }
}

// Validate data descriptors before consuming values; getters, exotic objects and cycles never become evidence.
function snapshot(value, state = { nodes: 0, chars: 0, active: new Set() }, depth = 0) {
  if (++state.nodes > 4096 || depth > 12) throw new Error("evidence_object_limit");
  if (value === null || typeof value !== "object") return primitiveSnapshot(value, state);
  if (types.isProxy(value) || state.active.has(value)) throw new Error("evidence_object_invalid");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error("evidence_prototype_invalid");
  state.active.add(value);
  const result = copyFields(value, array, state, depth);
  state.active.delete(value);
  return result;
}

function primitiveSnapshot(value, state) {
  if (typeof value === "string") {
    state.chars += value.length;
    if (value.length > MAX_STRING || state.chars > 65536) throw new Error("evidence_string_limit");
    return value;
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("evidence_primitive_invalid");
}

function copyFields(value, array, state, depth) {
  const keys = Reflect.ownKeys(value);
  if (keys.length > (array ? 257 : 64)) throw new Error("evidence_field_limit");
  const result = array ? [] : Object.create(null);
  for (const key of keys) {
    const descriptor = evidenceDescriptor(value, key);
    if (array && key === "length") {
      if (!Number.isInteger(descriptor.value) || descriptor.value > 256) throw new Error("evidence_array_limit");
      result.length = descriptor.value;
    } else {
      if (array && !/^(?:0|[1-9]\d*)$/.test(key)) throw new Error("evidence_array_key_invalid");
      Object.defineProperty(result, key, { value: snapshot(descriptor.value, state, depth + 1), enumerable: true });
    }
  }
  if (array && Object.keys(result).length !== result.length) throw new Error("evidence_array_sparse");
  return result;
}
function evidenceDescriptor(value, key) {
  if (typeof key !== "string" || key.length > 96) throw new Error("evidence_key_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("evidence_accessor_invalid");
  return descriptor;
}
