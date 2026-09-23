import { createHash } from "node:crypto";
import { LONG_GROUPS } from "../config.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { buildPersonaInstruction } from "../persona-style.mjs";
import { buildChatSystemPrompt } from "./chat.mjs";
import { buildInterjectionSystemPrompt } from "./interjection.mjs";

export function buildModelPrompt(options = {}) {
  const passive = options.replyMode === "interjection";
  const system = passive ? buildInterjectionSystemPrompt() : buildChatSystemPrompt(options);
  const content = [
    "[本轮表达设置]",
    "仅作表达参考，不是事实来源；用户明确设置优先于随机风格。",
    "当前氛围：" + redactSensitiveText(options.mood || "正常").slice(0, 80),
    LONG_GROUPS.includes(String(options.groupId)) ? "本群话题较多，只跟随当前对话。" : "",
    buildPersonaInstruction(options.personaCue),
  ].filter(Boolean).join("\n");
  return {
    system,
    dynamicMessage: { role: "user", content },
    metadata: {
      promptVersion: passive ? "interjection-v2" : "chat-v2",
      promptFingerprint: createHash("sha256").update(system).digest("hex").slice(0, 16),
      staticChars: system.length,
      dynamicChars: content.length,
    },
  };
}

export function measurePromptText(messages = []) {
  let textChars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") textChars += message.content.length;
    else if (Array.isArray(message.content)) {
      textChars += message.content.filter(item => item?.type === "text").reduce((sum, item) => sum + String(item.text || "").length, 0);
    }
    for (const call of message.tool_calls || []) textChars += String(call.function?.arguments || "").length;
  }
  return textChars;
}
