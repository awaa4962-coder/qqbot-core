const MODES = new Set(["steady", "shadow", "off"]);
const CAPTURE_MODES = new Set(["auto", "observe", "off"]);
const DEFAULT_TAG = "其他";

export const STICKER_TAGS = Object.freeze([
  "开心",
  "难过",
  "生气",
  "害羞",
  "安慰",
  "无语",
  "搞笑",
  "惊讶",
  "撒娇",
  "感谢",
  "鼓励",
  "赞同",
  "吐槽",
  DEFAULT_TAG,
]);

export function createEmptyStickerCatalog(settings = {}) {
  return {
    schemaVersion: 2,
    revision: 1,
    updatedAt: null,
    lastSyncedAt: null,
    identitySalt: "",
    settings: normalizeStickerSettings(settings),
    entries: [],
    stats: {
      syncs: 0,
      analyzed: 0,
      reused: 0,
      sent: 0,
      sendFailures: 0,
      captured: 0,
      captureDuplicates: 0,
      captureRejected: 0,
      cloudAdded: 0,
      cloudFailures: 0,
    },
  };
}

export function normalizeStickerSettings(value = {}, defaults = {}) {
  const source = value && typeof value === "object" ? value : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  return {
    mode: normalizeMode(source.mode ?? fallback.mode),
    groupEnabled: normalizeBoolean(source.groupEnabled, fallback.groupEnabled, true),
    privateEnabled: normalizeBoolean(source.privateEnabled, fallback.privateEnabled, true),
    chance: boundedNumber(source.chance, fallback.chance, 0.1, 0, 1),
    strongChance: boundedNumber(source.strongChance, fallback.strongChance, 0.25, 0, 1),
    cooldownMs: boundedInteger(source.cooldownMs, fallback.cooldownMs, 300000, 0, 86400000),
    allowedGroups: normalizeNumberList(source.allowedGroups ?? fallback.allowedGroups),
    captureMode: normalizeCaptureMode(source.captureMode ?? fallback.captureMode),
    captureDailyLimit: boundedInteger(source.captureDailyLimit, fallback.captureDailyLimit, 20, 0, 200),
    captureCatalogLimit: boundedInteger(source.captureCatalogLimit, fallback.captureCatalogLimit, 300, 1, 2000),
    captureMinConfidence: boundedNumber(source.captureMinConfidence, fallback.captureMinConfidence, 0.82, 0, 1),
    captureMinDistinctSenders: boundedInteger(
      source.captureMinDistinctSenders,
      fallback.captureMinDistinctSenders,
      2,
      1,
      20
    ),
  };
}

export function normalizeStickerEntry(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: cleanText(source.id, 80),
    source: cleanText(source.source || "qq-favorite", 40),
    url: cleanUrl(source.url),
    fingerprint: cleanText(source.fingerprint, 128),
    description: cleanText(source.description, 240),
    tags: normalizeStickerTags(source.tags),
    enabled: source.enabled !== false,
    allowedGroups: normalizeNumberList(source.allowedGroups),
    indexed: source.indexed === true,
    manual: source.manual === true,
    emojiId: cleanText(source.emojiId, 120),
    packageId: cleanText(source.packageId, 120),
    key: cleanText(source.key, 500),
    resId: cleanText(source.resId, 300),
    md5: normalizeMd5(source.md5),
    summary: cleanText(source.summary, 120),
    captureState: normalizeCaptureState(source.captureState),
    classification: normalizeClassification(source.classification),
    confidence: boundedNumber(source.confidence, 0, 0, 0, 1),
    seenCount: boundedInteger(source.seenCount, 0, 1, 1, Number.MAX_SAFE_INTEGER),
    distinctSenderCount: boundedInteger(source.distinctSenderCount, 0, 0, 0, Number.MAX_SAFE_INTEGER),
    senderHashes: normalizeStringList(source.senderHashes, 80, 40),
    sourceGroups: normalizeNumberList(source.sourceGroups),
    cloudManaged: source.cloudManaged === true,
    cloudAddedAt: normalizeTimestamp(source.cloudAddedAt),
    lastObservedAt: normalizeTimestamp(source.lastObservedAt),
    firstSeenAt: normalizeTimestamp(source.firstSeenAt),
    lastSeenAt: normalizeTimestamp(source.lastSeenAt),
    analyzedAt: normalizeTimestamp(source.analyzedAt),
    lastSentAt: normalizeTimestamp(source.lastSentAt),
    sendCount: boundedInteger(source.sendCount, 0, 0, 0, Number.MAX_SAFE_INTEGER),
    analysisAttempts: boundedInteger(source.analysisAttempts, 0, 0, 0, 100),
    nextAnalysisAt: normalizeTimestamp(source.nextAnalysisAt),
    lastError: cleanText(source.lastError, 160),
  };
}

export function normalizeStickerTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,，、;；]+/);
  const result = [];
  for (const item of list) {
    const tag = cleanText(item, 20);
    if (tag && !result.includes(tag)) result.push(tag);
    if (result.length >= 8) break;
  }
  return result;
}

export function normalizeNumberList(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,，、;；]+/);
  return [...new Set(list
    .map(item => Number(item))
    .filter(item => Number.isSafeInteger(item) && item > 0))];
}

export function publicStickerEntry(entry) {
  const normalized = normalizeStickerEntry(entry);
  const { senderHashes: _senderHashes, ...safe } = normalized;
  return {
    ...safe,
    key: normalized.key ? "configured" : "",
  };
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MODES.has(mode) ? mode : "steady";
}

function normalizeCaptureMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return CAPTURE_MODES.has(mode) ? mode : "observe";
}

function normalizeCaptureState(value) {
  const state = String(value || "").trim().toLowerCase();
  return new Set(["favorite", "candidate", "pending-cloud", "active", "cloud-failed", "retired"])
    .has(state)
    ? state
    : "favorite";
}

function normalizeClassification(value) {
  const kind = String(value || "").trim().toLowerCase();
  return new Set(["sticker", "photo", "screenshot", "other", "unknown"]).has(kind)
    ? kind
    : "unknown";
}

function normalizeMd5(value) {
  const md5 = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(md5) ? md5 : "";
}

function normalizeStringList(value, maxItems, maxLength) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map(item => cleanText(item, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function cleanUrl(value) {
  const url = cleanText(value, 2000);
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function cleanText(value, maxLength) {
  return stripControlCharacters(String(value || "")).trim().slice(0, maxLength);
}

function stripControlCharacters(value) {
  return [...value]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeBoolean(value, fallback, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function boundedInteger(value, fallback, defaultValue, min, max) {
  const candidate = firstFinite(value, fallback, defaultValue);
  return Math.round(Math.min(max, Math.max(min, candidate)));
}

function boundedNumber(value, fallback, defaultValue, min, max) {
  const candidate = firstFinite(value, fallback, defaultValue);
  return Math.min(max, Math.max(min, candidate));
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}
