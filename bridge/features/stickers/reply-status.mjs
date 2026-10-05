export const STICKER_REPLY_STAGES = Object.freeze([
  "skipped", "selected", "shadow", "cancelled", "knownfailed", "unknown", "partial", "sent",
]);
export const STICKER_REPLY_COUNTER_LIMIT = 1_000_000;

const stages = new Set(STICKER_REPLY_STAGES);
const reasons = new Set(["unknown_reason","sticker_off","mode_off","catalog_unavailable","no_text_reply","serious_context","private_disabled","group_disabled","group_not_allowed","cooldown","chance_miss","no_candidates","no_match","model_no_match","selected","shadow","shadow_mode","sent","send_failed","send_unknown","send_partial","send_cancelled","invalid_sticker","sticker_unavailable","sticker_changed","policy_changed","policy_guard_unavailable","selection_failed","reply_failed","privacy_changed","task_cancelled","permission_changed","preferences_changed","memory_expired","memory_unavailable","reply_superseded","reply_expired","reply_capacity","bridge_stopping","reply_duplicate","delivery_state_unavailable","recipient_mismatch","no_reply","chance_missed","chance_disabled","chance_selected","eligible","entry_group_only","selection_none","selection_invalid","selection_selected"]);
const legacyReasons = new Map([
  ["\u529f\u80fd\u5df2\u5173\u95ed", "sticker_off"],
  ["\u8868\u60c5\u76ee\u5f55\u6682\u4e0d\u53ef\u8bfb", "catalog_unavailable"],
  ["\u6ca1\u6709\u6587\u5b57\u56de\u590d", "no_text_reply"],
  ["\u4e25\u8083\u6216\u7cfb\u7edf\u573a\u666f", "serious_context"],
  ["\u79c1\u804a\u8868\u60c5\u5df2\u5173\u95ed", "private_disabled"],
  ["\u7fa4\u804a\u8868\u60c5\u5df2\u5173\u95ed", "group_disabled"],
  ["\u7fa4\u4e0d\u5728\u8868\u60c5\u767d\u540d\u5355", "group_not_allowed"],
  ["\u51b7\u5374\u4e2d", "cooldown"],
  ["\u6982\u7387\u672a\u547d\u4e2d", "chance_miss"],
  ["\u6ca1\u6709\u8bed\u4e49\u53ef\u9760\u7684\u5019\u9009", "no_candidates"],
  ["\u6a21\u578b\u9009\u62e9\u65e0\u5339\u914d", "model_no_match"],
  ["\u6a21\u578b\u4ece\u8bed\u4e49\u5019\u9009\u4e2d\u9009\u4e2d", "selected"],
]);
const receipts = new Set(["none", "sent", "partial", "unknown"]);
const counts = Object.fromEntries(STICKER_REPLY_STAGES.map(stage => [stage, 0]));
let last = null;

export function normalizeStickerReplyReason(value) {
  if (typeof value !== "string") return "unknown_reason";
  return reasons.has(value) ? value : legacyReasons.get(value) || "unknown_reason";
}

export function recordStickerReplyStage(stage, reasonCode, physicalReceipt = "none") {
  const safeStage = stages.has(stage) ? stage : "unknown";
  counts[safeStage] = Math.min(STICKER_REPLY_COUNTER_LIMIT, counts[safeStage] + 1);
  last = {
    stage: safeStage,
    reasonCode: normalizeStickerReplyReason(reasonCode),
    physicalReceipt: receipts.has(physicalReceipt) ? physicalReceipt : "unknown",
  };
}

export function getStickerReplyStatus() {
  return { scope: "process", counterLimit: STICKER_REPLY_COUNTER_LIMIT,
    counts: { ...counts }, last: last ? { ...last } : null };
}

export function resetStickerReplyStatusForTest() {
  for (const stage of STICKER_REPLY_STAGES) counts[stage] = 0;
  last = null;
}
