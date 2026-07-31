export const SUMMARY_STYLES = Object.freeze({
  casual: {
    id: "casual",
    label: "轻松版",
    length: "300-500 字",
    prompt: "语气轻松，像群友在发小报，可以有一点可爱但不要太油。",
  },
  short: {
    id: "short",
    label: "简短版",
    length: "120-220 字",
    prompt: "写得短一点，保留数据、主题、活跃之星和一句收尾。",
  },
  technical: {
    id: "technical",
    label: "技术版",
    length: "250-420 字",
    prompt: "更关注机器人、代码、日志、资源、问题推进，但仍然保持群聊小报口吻。",
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
