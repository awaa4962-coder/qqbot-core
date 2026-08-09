import { validateSafeUrl } from "../../safe-url.mjs";

const DEFAULT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1200;
const DIRECT_ASSET_RE = /\.(?:7z|apk|avi|csv|docx?|exe|gif|jpe?g|m4a|mkv|mov|mp3|mp4|pdf|png|rar|tar|webm|webp|xlsx?|zip)$/i;
const BLOCKED_MEDIA_HOST_RE = /(?:^|\.)(?:gchat\.qpic\.cn|multimedia\.nt\.qq\.com\.cn|qpic\.cn)$/i;
const TRACKING_PARAM_RE = /^(?:utm_.+|spm|from|source|ref|referrer|share_.+|shareid|share_id|timestamp|ts)$/i;
const LOW_VALUE_TITLE_RE = /^(?:access denied|attention required|error|forbidden|home|index|just a moment|loading|not found|security check|untitled|安全验证|无标题|页面不存在|访问被拒绝|首页)$/i;

const recentByGroup = new Map();

export function inspectAutoPreview(rawText, options = {}) {
  const extracted = extractPreviewUrls(rawText);
  const hadLink = extracted.rawCount > 0;
  if (!hadLink) return decision(false, "no_link", null, false);
  if (options.isLongGroup) return decision(false, "long_group", null, true);
  if (options.isAtMe) return decision(false, "mentioned", null, true);
  if (String(rawText || "").length > MAX_MESSAGE_LENGTH) {
    return decision(false, "long_message", null, true);
  }
  if (extracted.urls.length !== 1) {
    return decision(false, extracted.urls.length ? "multiple_links" : "unsafe_link", null, true);
  }

  const candidate = extracted.urls[0];
  if (BLOCKED_MEDIA_HOST_RE.test(candidate.host)) return decision(false, "media_host", candidate, true);
  if (DIRECT_ASSET_RE.test(candidate.pathname)) return decision(false, "direct_asset", candidate, true);
  if (wasRecentlyPreviewed(options.groupId, candidate.key, options)) {
    return decision(false, "duplicate", candidate, true);
  }
  return decision(true, "ready", candidate, true);
}

export function extractPreviewUrls(rawText) {
  const matches = String(rawText || "").match(/https?:\/\/[^\s<>"']+/giu) || [];
  const urls = [];
  const seen = new Set();
  for (const match of matches) {
    const rawUrl = trimTrailingPunctuation(match);
    const checked = validateSafeUrl(rawUrl);
    if (!checked.ok || checked.url.username || checked.url.password) continue;
    const key = normalizedPreviewKey(checked.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push({
      url: checked.url.href,
      key,
      host: checked.url.hostname.toLowerCase(),
      pathname: checked.url.pathname,
    });
  }
  return { rawCount: matches.length, urls };
}

export function previewAddsValue(preview, rawText) {
  if (!preview) return false;
  if (preview.bvid) return true;
  const title = cleanText(preview.title);
  if (title.length < 3 || LOW_VALUE_TITLE_RE.test(title)) return false;

  const visibleText = cleanText(String(rawText || "").replace(/https?:\/\/[^\s<>"']+/giu, ""));
  if (!visibleText) return true;
  const titleKey = comparisonKey(title);
  const messageKey = comparisonKey(visibleText);
  const titleRepeated = titleKey.length >= 4 && (messageKey.includes(titleKey) || titleKey.includes(messageKey));
  const descriptionKey = comparisonKey(preview.description);
  const descriptionAddsValue = descriptionKey.length >= 8 && !messageKey.includes(descriptionKey);
  return !titleRepeated || descriptionAddsValue || Boolean(preview.image);
}

export function markAutoPreviewSent(groupId, candidate, options = {}) {
  const key = typeof candidate === "string" ? candidate : candidate?.key;
  if (!key) return;
  const now = Number(options.now || Date.now());
  const groupKey = String(groupId || "default");
  const history = recentByGroup.get(groupKey) || new Map();
  purgeExpired(history, now, dedupeWindow(options));
  history.set(key, now);
  recentByGroup.set(groupKey, history);
  trimHistory(history);
  trimGroups();
}

export function resetAutoPreviewPolicy() {
  recentByGroup.clear();
}

function wasRecentlyPreviewed(groupId, key, options) {
  const now = Number(options.now || Date.now());
  const history = recentByGroup.get(String(groupId || "default"));
  if (!history) return false;
  const windowMs = dedupeWindow(options);
  purgeExpired(history, now, windowMs);
  const sentAt = history.get(key);
  return sentAt !== undefined && now - sentAt <= windowMs;
}

function normalizedPreviewKey(input) {
  const url = new URL(input.href);
  url.hash = "";
  const entries = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM_RE.test(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );
  url.search = "";
  for (const [name, value] of entries) url.searchParams.append(name, value);
  return url.href;
}

function trimTrailingPunctuation(value) {
  return String(value || "").replace(/[.,!?;:'"，。！？；：、》」』】）]+$/u, "");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function comparisonKey(value) {
  return cleanText(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function decision(ok, reason, candidate, hadLink) {
  return { ok, reason, candidate, hadLink };
}

function dedupeWindow(options) {
  const value = Number(options.dedupeWindowMs || DEFAULT_DEDUPE_WINDOW_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DEDUPE_WINDOW_MS;
}

function purgeExpired(history, now, windowMs) {
  for (const [key, timestamp] of history) {
    if (now - timestamp > windowMs) history.delete(key);
  }
}

function trimHistory(history) {
  while (history.size > 100) history.delete(history.keys().next().value);
}

function trimGroups() {
  while (recentByGroup.size > 200) recentByGroup.delete(recentByGroup.keys().next().value);
}
