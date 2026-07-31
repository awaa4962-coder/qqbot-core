// bridge/duplicate-message.mjs - in-memory guard against repeater pollution.

const WINDOW_MS = 5 * 60 * 1000;
const SAME_USER_REPEAT_MS = 45 * 1000;
const MAX_KEYS_PER_GROUP = 300;
const MIN_NORMALIZED_LENGTH = 2;

const groupBuckets = new Map();

export function observeGroupDuplicate(event = {}, options = {}) {
  const text = normalizeDuplicateText(event.text);
  if (!shouldCheckDuplicate(text, event, options)) return duplicateResult(false, text, 0, 0, "bypass");

  const now = Number(options.now || event.now || Date.now());
  const { groupId, uid } = duplicateIdentity(event);
  if (!groupId || !uid) return duplicateResult(false, text, 0, 0, "missing_identity");

  const bucket = getGroupBucket(groupId);
  pruneBucket(bucket, now);

  const hits = bucket.get(text) || [];
  const decision = decideDuplicate(hits, uid, now);

  hits.push({ uid, ts: now });
  bucket.set(text, hits.slice(-20));
  trimBucket(bucket);

  return duplicateResult(decision.duplicate, text, hits.length - 1, decision.previousUsers, decision.reason);
}

export function normalizeDuplicateText(value) {
  return String(value || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .toLowerCase()
    .slice(0, 160);
}

export function resetDuplicateMessageState() {
  groupBuckets.clear();
}

function shouldBypassDuplicateGuard(event, options) {
  return Boolean(
    options.bypass ||
    event.isAtMe ||
    event.hasImages ||
    event.hasFiles ||
    looksLikeUserCommand(event.text),
  );
}

function shouldCheckDuplicate(text, event, options) {
  return Boolean(text && text.length >= MIN_NORMALIZED_LENGTH && !shouldBypassDuplicateGuard(event, options));
}

function duplicateIdentity(event) {
  return {
    groupId: String(event.groupId || event.group_id || ""),
    uid: String(event.uid || event.userId || event.user_id || ""),
  };
}

function decideDuplicate(hits, uid, now) {
  const sameUserRecent = hits.some(item => item.uid === uid && now - item.ts <= SAME_USER_REPEAT_MS);
  const previousUsers = new Set(hits.map(item => item.uid).filter(Boolean)).size;
  if (sameUserRecent) return { duplicate: true, reason: "same_user_repeat", previousUsers };
  if (hits.length >= 2) return { duplicate: true, reason: "group_repeat", previousUsers };
  return { duplicate: false, reason: "", previousUsers };
}

function looksLikeUserCommand(text) {
  return /^[/\\]?\s*(help|status|ping|version|runtime|admin|jm\b|日报|词云|梗库|帮助|状态|测试|版本|管理)/i
    .test(String(text || "").trim());
}

function getGroupBucket(groupId) {
  let bucket = groupBuckets.get(groupId);
  if (!bucket) {
    bucket = new Map();
    groupBuckets.set(groupId, bucket);
  }
  return bucket;
}

function pruneBucket(bucket, now) {
  for (const [key, hits] of bucket.entries()) {
    const kept = hits.filter(item => now - item.ts <= WINDOW_MS);
    if (kept.length) bucket.set(key, kept);
    else bucket.delete(key);
  }
}

function trimBucket(bucket) {
  while (bucket.size > MAX_KEYS_PER_GROUP) {
    const key = bucket.keys().next().value;
    if (!key) return;
    bucket.delete(key);
  }
}

function duplicateResult(duplicate, key, previousCount, previousUsers, reason) {
  return {
    duplicate,
    key,
    previousCount,
    previousUsers,
    reason,
  };
}
