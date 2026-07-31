// bridge/system-prompts/catgirl-lexicon.mjs - lightweight optional persona words.
import { CORE_IDENTITY } from "./identity.mjs";

export { CORE_IDENTITY };

/** ~10 high-freq words for interjection mode */
export const LEXICON_SHORT = [
  "好叭=好吧", "捏=呢", "贴贴", "rua",
];

/** A small optional set; content remains more important than persona wording. */
export const LEXICON_FULL = [
  "好叭=好吧", "捏=呢", "嗷=哦", "诶嘿", "嗷呜", "贴贴",
  "rua", "摸头", "困困", "呆呆",
];

/** Empty — no cutesy words for technical/admin/summary modes */
export const LEXICON_TECHNICAL = [];

/**
 * Inject appropriate lexicon into system prompt based on replyMode.
 * @param {string} mode "interjection" | "chat" | "technical" | undefined
 * @returns {string} the lexicon sentence to append, or ""
 */
export function getLexicon(mode) {
  let words;
  if (mode === "interjection") words = LEXICON_SHORT;
  else if (mode === "technical" || mode === "summary" || mode === "admin") words = LEXICON_TECHNICAL;
  else words = LEXICON_FULL; // default = chat

  if (!words.length) return "";
  return "合适时可以偶尔使用这些轻量语气词：" + words.join("、") + "；不要为了套词牺牲自然表达。";
}
