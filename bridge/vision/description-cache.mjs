import { createHash } from "node:crypto";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";

const MAX_ENTRIES = 128;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_TEXT_CHARS = 800;
const TTL_MS = 10 * 60 * 1000;
const IDENTITY_FIELDS = ["scope", "digests", "provider", "promptVersion"];
const SCOPE_FIELDS = ["surface", "userId", "groupId", "currentMessageId"];

// The caller supplies a provider snapshot and only successful, objective text.
// No identity objects are retained; configuration/privacy lifecycle stays outside.
// get returns "" on a miss; set returns whether text was stored; clear resets stats.
export function createVisionDescriptionCache({ now = Date.now } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const entries = new Map();
  let textBytes = 0;
  let hits = 0;
  let misses = 0;
  let lastNow = null;

  function remove(key) {
    textBytes -= entries.get(key).bytes;
    entries.delete(key);
  }

  function prune() {
    let current;
    try { current = now(); } catch { current = NaN; }
    const valid = typeof current === "number" && Number.isFinite(current)
      && current >= 0 && current <= Number.MAX_SAFE_INTEGER;
    // A broken or backward clock must never resurrect or prolong retained text.
    if (!valid || (lastNow !== null && current < lastNow)) {
      entries.clear();
      textBytes = 0;
    }
    lastNow = valid ? current : null;
    if (!valid) return null;
    for (const [key, entry] of entries) {
      const age = current - entry.createdAt;
      if (!Number.isFinite(age) || age < 0 || age >= TTL_MS) remove(key);
    }
    return current;
  }

  function get(identity) {
    const key = identityKey(identity);
    if (!key) return "";
    prune();
    const entry = entries.get(key);
    if (!entry) {
      misses++;
      return "";
    }
    hits++;
    // LRU changes eviction order only, never the absolute creation time.
    entries.delete(key);
    entries.set(key, entry);
    return entry.text;
  }

  function set(identity, text) {
    const key = identityKey(identity);
    if (!key) return false;
    const description = objectiveText(text);
    if (!description) return false;
    const createdAt = prune();
    if (createdAt === null) return false;
    const bytes = Buffer.byteLength(description, "utf8");
    if (entries.has(key)) remove(key);
    entries.set(key, { text: description, bytes, createdAt });
    textBytes += bytes;
    while (entries.size > MAX_ENTRIES || textBytes > MAX_TEXT_BYTES) {
      remove(entries.keys().next().value);
    }
    return true;
  }

  function clear() {
    entries.clear();
    textBytes = 0;
    hits = 0;
    misses = 0;
    lastNow = null;
  }

  function status() {
    prune();
    return { enabled: true, entries: entries.size, hits, misses,
      storesImages: false, storesChatText: false, persistent: false };
  }

  return Object.freeze({ get, set, clear, status });
}

export const visionDescriptionCache = createVisionDescriptionCache();
export function clearVisionDescriptionCache() { visionDescriptionCache.clear(); }
export function getVisionDescriptionCacheStatus() { return visionDescriptionCache.status(); }

function identityKey(value) {
  try {
    const identity = record(value, IDENTITY_FIELDS);
    const scope = normalizeScope(identity.scope);
    const digests = normalizeDigests(identity.digests);
    const provider = record(identity.provider);
    for (const field of ["id", "model", "protocol", "endpoint", "auth"]) {
      if (typeof provider[field] !== "string" || !provider[field].trim()) return "";
    }
    const promptVersion = identity.promptVersion;
    if (typeof promptVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(promptVersion)) return "";
    // Sort all provider fields, including nested task/reasoning route settings.
    // Reject lossy JSON inputs instead of silently creating fingerprint collisions.
    const canonical = canonicalJson({ scope, digests, provider, promptVersion }, { nodes: 0, chars: 0 });
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return "";
  }
}

function record(value, fields) {
  if (!value || typeof value !== "object") throw new TypeError("invalid record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("invalid record");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || (fields && !fields.includes(key))
      || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("invalid field");
    result[key] = descriptor.value;
  }
  return result;
}

function arrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("invalid array");
  if (value.length > 512 || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("invalid array");
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("invalid array item");
    result.push(descriptor.value);
  }
  return result;
}

function numericId(value) {
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError("invalid id");
  const id = String(value);
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new TypeError("invalid id");
  return id;
}

function normalizeScope(value) {
  const scope = record(value, SCOPE_FIELDS);
  // Chat-run scopes carry message metadata; it is never part of image identity.
  if (scope.currentMessageId !== undefined) {
    const messageId = scope.currentMessageId;
    if ((typeof messageId !== "string" && !Number.isSafeInteger(messageId))
      || !/^-?\d{1,20}$/.test(String(messageId))) throw new TypeError("invalid message id");
  }
  const { surface } = scope;
  if (surface !== "private" && surface !== "group") throw new TypeError("invalid surface");
  const userId = numericId(scope.userId);
  if (surface === "private") {
    if (![undefined, null, "private"].includes(scope.groupId)) throw new TypeError("invalid private group");
    return { surface, userId, groupId: "private" };
  }
  return { surface, userId, groupId: numericId(scope.groupId) };
}

function normalizeDigests(value) {
  const digests = typeof value === "string" ? [value] : arrayValues(value);
  if (!digests.length || digests.length > 3) throw new TypeError("invalid digest count");
  return digests.map(digest => {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) throw new TypeError("invalid digest");
    return digest.toLowerCase();
  });
}

function canonicalJson(value, budget, depth = 0) {
  if (++budget.nodes > 512 || depth > 16) throw new TypeError("identity too large");
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) {
    const encoded = JSON.stringify(value);
    budget.chars += encoded.length;
    if (budget.chars > 16 * 1024) throw new TypeError("identity too large");
    return encoded;
  }
  if (Array.isArray(value)) {
    return "[" + arrayValues(value).map(item => canonicalJson(item, budget, depth + 1)).join(",") + "]";
  }
  const object = record(value);
  return "{" + Object.keys(object).sort().map(key =>
    canonicalJson(key, budget, depth + 1) + ":" + canonicalJson(object[key], budget, depth + 1)).join(",") + "}";
}

function objectiveText(value) {
  if (typeof value !== "string" || containsSensitiveText(value) || redactSensitiveText(value) !== value) return "";
  // URLs/image payloads are not descriptions. Inspect the full text before capping.
  if (/\b(?:https?:\/\/|data:image\/)|\[CQ:image\b/i.test(value)) return "";
  return value.trim().slice(0, MAX_TEXT_CHARS).replace(/[\uD800-\uDBFF]$/u, "");
}
