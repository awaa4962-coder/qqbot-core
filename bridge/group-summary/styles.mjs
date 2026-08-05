export const SUMMARY_STYLES = Object.freeze({
  casual: {
    id: "casual",
    label: "标准分析",
    length: "450-800 字",
    maxTopics: 3,
    prompt: "优先呈现事实、讨论结果和未解决事项，语言自然但不进行娱乐化扩写。",
  },
  short: {
    id: "short",
    label: "简明分析",
    length: "200-400 字",
    maxTopics: 2,
    prompt: "只保留最重要的讨论及其结果；信息不足时宁可明确说未形成结论。",
  },
  technical: {
    id: "technical",
    label: "技术分析",
    length: "500-900 字",
    maxTopics: 4,
    prompt: "优先说明故障现象、排查过程、已验证结果、剩余风险和下一步，但不得补写记录中不存在的结论。",
  },
});

const STYLE_ALIASES = Object.freeze({
  casual: "casual",
  "轻松": "casual",
  "轻松版": "casual",
  "默认": "casual",
  short: "short",
  "简短": "short",
  "简短版": "short",
  technical: "technical",
  tech: "technical",
  "技术": "technical",
  "技术版": "technical",
});

export function normalizeSummaryStyle(value = "casual") {
  const key = String(value || "casual").trim().toLowerCase();
  return STYLE_ALIASES[key] || null;
}

export function getSummaryStyle(value = "casual") {
  const id = normalizeSummaryStyle(value) || "casual";
  return SUMMARY_STYLES[id];
}

export function listSummaryStyles() {
  return Object.values(SUMMARY_STYLES);
}
