export function estimateContextBudget(messages, currentInput = "") {
  const messageChars = (messages || []).reduce(function(total, item) {
    return total + String(item?.content || "").length;
  }, 0);
  const currentChars = String(currentInput || "").length;
  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    chars: messageChars + currentChars,
    currentInputChars: currentChars,
  };
}

const MODE_LIMITS = Object.freeze({
  "group-at": { maxChars: 6500, maxMessages: 14, maxMessageChars: 2200 },
  private: { maxChars: 5200, maxMessages: 12, maxMessageChars: 1800 },
  interjection: { maxChars: 1200, maxMessages: 3, maxMessageChars: 700 },
});

export function enforceContextBudget(messages, currentInput = "", options = {}) {
  const limits = resolveContextLimits(options.mode, options);
  const currentChars = String(currentInput || "").length;
  let remaining = Math.max(0, limits.maxChars - currentChars);
  const ranked = (Array.isArray(messages) ? messages : []).map((item, index) => ({
    index,
    priority: Number(item?.contextPriority || 50),
    role: item?.role || "user",
    content: String(item?.content || "").trim(),
  })).filter(item => item.content);
  ranked.sort((a, b) => b.priority - a.priority || b.index - a.index);

  const selected = [];
  let truncatedMessages = 0;
  for (const item of ranked) {
    if (selected.length >= limits.maxMessages || remaining < 40) break;
    const maxLength = Math.min(limits.maxMessageChars, remaining);
    const content = clipContextContent(item.content, maxLength);
    if (!content) continue;
    if (content.length < item.content.length) truncatedMessages++;
    selected.push({ index: item.index, role: item.role, content });
    remaining -= content.length;
  }
  selected.sort((a, b) => a.index - b.index);
  const bounded = selected.map(({ role, content }) => ({ role, content }));
  const measured = estimateContextBudget(bounded, currentInput);
  return {
    messages: bounded,
    budget: {
      ...measured,
      maxChars: limits.maxChars,
      maxMessages: limits.maxMessages,
      originalMessageCount: ranked.length,
      prunedMessageCount: Math.max(0, ranked.length - bounded.length),
      truncatedMessageCount: truncatedMessages,
    },
  };
}

export function resolveContextLimits(mode = "group-at", overrides = {}) {
  const base = MODE_LIMITS[mode] || MODE_LIMITS["group-at"];
  return {
    maxChars: positiveInt(overrides.maxChars, base.maxChars),
    maxMessages: positiveInt(overrides.maxMessages, base.maxMessages),
    maxMessageChars: positiveInt(overrides.maxMessageChars, base.maxMessageChars),
  };
}

function clipContextContent(content, maxLength) {
  if (maxLength <= 0) return "";
  if (content.length <= maxLength) return content;
  if (maxLength < 40) return content.slice(0, maxLength);
  const firstBreak = content.indexOf("\n");
  const header = firstBreak > 0 ? content.slice(0, Math.min(firstBreak, 80)) : "";
  if (!header || header.length + 8 >= maxLength) return content.slice(0, maxLength - 1).trimEnd() + "…";
  const tailLength = maxLength - header.length - 5;
  return header + "\n…\n" + content.slice(-tailLength).trimStart();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
