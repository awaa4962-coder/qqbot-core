const DEFAULT_REPEAT_WINDOW_MS = 20 * 60 * 1000;

const COMMAND_RE = /^(?:[/\\]\s*)?(?:help|status|ping|version|runtime|admin\b|jm\b|日报(?:帮助|预览|发送)?|群报|词云|资源|梗库|更新(?:列表)?|帮助|状态|测试|版本|管理|运行|好感度|关系|熟悉度|my-status|my-profile|隐私|忘记我)(?:\s|$)/i;
const NON_TEXT_RE = /^(?:\[非文本消息\]|\[图片\]|\[表情\]|\[文件\])$/i;
const PURE_NOISE_RE = /^[\p{P}\p{S}\s]+$/u;

export function prepareSummaryEvidence(messages = [], options = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const repeatWindowMs = positiveNumber(options.repeatWindowMs, DEFAULT_REPEAT_WINDOW_MS);
  const ordered = items
    .map((message, index) => ({ message, index, ts: normalizedTimestamp(message?.ts, index) }))
    .sort((left, right) => left.ts - right.ts || left.index - right.index);
  const evidenceMessages = [];
  const recentByKey = new Map();
  const repeatEvents = [];
  const metrics = {
    botMessageCount: 0,
    commandMessageCount: 0,
    noiseMessageCount: 0,
    repeatMessageCount: 0,
  };

  for (const entry of ordered) {
    const item = entry.message || {};
    const text = normalizeEvidenceText(item.text);
    if (isSummaryBotMessage(item, options)) {
      metrics.botMessageCount++;
      continue;
    }
    if (isSummaryCommandText(text)) {
      metrics.commandMessageCount++;
      continue;
    }
    if (isSummaryNoiseText(text)) {
      metrics.noiseMessageCount++;
      continue;
    }

    const repeatKey = buildRepeatKey(text);
    const previous = repeatKey ? recentByKey.get(repeatKey) : null;
    if (previous && entry.ts - previous.lastTs <= repeatWindowMs) {
      metrics.repeatMessageCount++;
      previous.lastTs = entry.ts;
      previous.count++;
      previous.speakers.add(summaryUserKey(item));
      continue;
    }

    const normalized = { ...item, text };
    evidenceMessages.push(normalized);
    if (repeatKey) {
      const event = {
        startTs: entry.ts,
        lastTs: entry.ts,
        count: 1,
        speakers: new Set([summaryUserKey(item)]),
      };
      recentByKey.set(repeatKey, event);
      repeatEvents.push(event);
    }
  }

  return {
    messages: evidenceMessages,
    metrics,
    repeatEvents: repeatEvents
      .filter(event => event.count > 1)
      .sort((left, right) => right.count - left.count || left.startTs - right.startTs)
      .slice(0, 5)
      .map(event => ({
        count: event.count,
        speakerCount: event.speakers.size,
        startTs: event.startTs,
        endTs: event.lastTs,
      })),
  };
}

export function isSummaryBotMessage(message, options = {}) {
  if (message?.isBot === true || message?.isSelf === true) return true;
  const selfUin = String(options.selfUin || "").trim();
  if (!selfUin) return false;
  return summaryUserKey(message) === selfUin;
}

export function isSummaryCommandText(value) {
  let text = normalizeEvidenceText(value);
  text = text.replace(/^\[CQ:at,[^\]]+\]\s*/i, "");
  text = text.replace(/^@[\p{L}\p{N}_-]+\s*/u, "");
  return COMMAND_RE.test(text.trim());
}

export function isSummaryNoiseText(value) {
  const text = normalizeEvidenceText(value);
  return !text || NON_TEXT_RE.test(text) || PURE_NOISE_RE.test(text);
}

export function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function summaryUserKey(message) {
  return String(
    message?.uid ??
    message?.userId ??
    message?.user_id ??
    message?.nickname ??
    "unknown"
  );
}

function buildRepeatKey(text) {
  const key = text
    .replace(/\[CQ:[^\]]+\]/gi, "")
    .replace(/@[\p{L}\p{N}_-]+/gu, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/([\p{L}\p{N}])\1{2,}/gu, "$1$1")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return key.length >= 2 ? key.slice(0, 160) : "";
}

function normalizedTimestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
