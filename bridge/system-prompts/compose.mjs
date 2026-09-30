import { createHash } from "node:crypto";
import { LONG_GROUPS } from "../config.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { buildPersonaInstruction } from "../persona-style.mjs";
import { buildChatSystemPrompt } from "./chat.mjs";
import { buildInterjectionSystemPrompt } from "./interjection.mjs";
import { imagePolicyFromOptions, IMAGE_POLICY_EVIDENCE } from "./image-policy.mjs";

export function buildModelPrompt(options = {}) {
  const passive = options.replyMode === "interjection";
  const policyOptions = { ...options, imagePolicy: imagePolicyFromOptions(options) };
  const system = passive ? buildInterjectionSystemPrompt(policyOptions) : buildChatSystemPrompt(policyOptions);
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
      promptVersion: (passive ? "interjection-v7" : "chat-v12") +
        (policyOptions.imagePolicy === IMAGE_POLICY_EVIDENCE ? "-image-evidence-v5" : ""),
      promptFingerprint: createHash("sha256").update(system).digest("hex").slice(0, 16),
      staticChars: system.length,
      dynamicChars: content.length,
    },
  };
}

export function measurePromptText(messages = []) {
  return measurePromptComposition(messages).inputTextChars;
}

export function measurePromptComposition(messages = [], tools = []) {
  const counts = { systemTextChars: 0, userTextChars: 0, assistantTextChars: 0, toolTextChars: 0,
    otherTextChars: 0, imageParts: 0, toolDeclarations: Array.isArray(tools) ? tools.length : 0,
    toolSchemaChars: Array.isArray(tools) && tools.length ? JSON.stringify(tools).length : 0 };
  for (const message of messages) {
    counts[roleCountKey(message.role)] += messageTextChars(message.content);
    if (Array.isArray(message.content)) counts.imageParts += message.content.filter(item => item?.type === "image_url").length;
    for (const call of message.tool_calls || []) counts.toolTextChars += String(call.function?.arguments || "").length;
  }
  return { ...counts, inputTextChars: counts.systemTextChars + counts.userTextChars + counts.assistantTextChars +
    counts.toolTextChars + counts.otherTextChars };
}

function roleCountKey(role) {
  switch (role) {
    case "system": return "systemTextChars";
    case "user": return "userTextChars";
    case "assistant": return "assistantTextChars";
    case "tool": return "toolTextChars";
    default: return "otherTextChars";
  }
}

function messageTextChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.filter(item => item?.type === "text")
    .reduce((sum, item) => sum + String(item.text || "").length, 0);
}
