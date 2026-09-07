const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
let featureCache = new WeakMap();
const STOP_WORDS = new Set("这个 那个 这些 那些 还是 依旧 仍然 然后 刚才 之前 现在 今天 昨天 明天 怎么 怎么办 为什么 如何 什么 哪个 一下 一点 一个 已经 没有 可以 不能 不行 好了 继续 问题 事情 感觉 觉得 真的 就是 不是 知道 还有 需要 能不能 你们 我们 他们 请问 一直 而且 但是 帮我 with the and this that have still please again about would could should just cannot failed".split(" "));
const CONCEPTS = [
  ["download", /下载|拉文件|拉取文件|下不动|download/i],
  ["archive", /解压|压缩包|压缩文件|分卷|archive|\b(?:zip|rar|7z)\b/i],
  ["jm", /漫画|\bjm(?:comic)?\b/i],
  ["driver", /驱动|driver/i],
  ["network", /网络|断网|联网|掉线|连不上|连接失败|network|disconnect/i],
  ["restart", /重启|重新启动|重新拉起|restart|reboot/i],
  ["reply", /不回消息|不回复|没回复|不回信息|自动回复|插话|沉默|回复异常/i],
  ["memory", /上下文|记忆|历史记录|context|memory/i],
  ["profile", /画像|称呼|昵称|profile|nickname/i],
  ["summary", /日报|群报|每日总结|daily.?summary/i],
  ["image", /图片|识图|照片|截图|image|picture|photo/i],
  ["model", /模型|mimo|deepseek|\bllm\b/i],
  ["error", /报错|错误|异常|出错|error|exception/i],
];

export function normalizeConversationText(value) {
  return String(value || "").slice(0, 2000).normalize("NFKC").toLowerCase()
    .replace(/\[CQ:[^\]]*\]|https?:\/\/\S+|@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

export function currentTopicText(value) {
  const text = normalizeConversationText(value);
  const switchMatch = text.match(/^(?:先?不(?:聊|说|谈)[^,，。;；]{0,50}|换个话题|另外问(?:一下)?|说点别的)[,，。:：;；\s]+(.+)$/u);
  return { text: switchMatch ? switchMatch[1].trim() : text, switched: Boolean(switchMatch) };
}

export function isContinuation(value) {
  return /^(?:还是|依旧|仍然|继续|然后|刚才|之前|这个|那个|它|又|没用|不行|好了|可以了|再试|怎么办|下一步|continue\b|still\b|what next\b)/i.test(normalizeConversationText(value));
}

export function retrievalFeatures(value) {
  const text = currentTopicText(value).text;
  const tokens = new Set();
  for (const part of segmenter.segment(text)) {
    const token = part.segment;
    if (!part.isWordLike || token.length < 2 || token.length > 30 || STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
    tokens.add(token);
    if (tokens.size >= 40) break;
  }
  return { tokens, concepts: new Set(CONCEPTS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id)) };
}

export function compareRelevance(query, candidate) {
  const left = typeof query === "string" ? retrievalFeatures(query) : query;
  const right = typeof candidate === "string" ? retrievalFeatures(candidate) : candidate;
  const sharedTokens = [...left.tokens].filter(token => right.tokens.has(token));
  const sharedConcepts = [...left.concepts].filter(concept => right.concepts.has(concept));
  // Generic error words alone cannot establish that two discussions are related.
  const specific = sharedTokens.filter(token => !/^(?:错误|异常|报错|失败|error|exception)$/.test(token));
  const concepts = sharedConcepts.filter(concept => concept !== "error");
  const score = specific.length ? Math.min(8, specific.length * 2) + Math.min(4, concepts.length * 2) : Math.min(4, concepts.length * 2);
  return { score, reason: specific.length ? "keywords" : concepts.length ? "synonyms" : "none" };
}

export function messageFeatures(message) {
  const text = String(message.text || "");
  const cached = featureCache.get(message);
  if (cached?.text === text) return cached.features;
  const features = retrievalFeatures(text);
  featureCache.set(message, { text, features });
  return features;
}

export function clearMessageFeatureCache() { featureCache = new WeakMap(); }
