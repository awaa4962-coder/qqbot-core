import { safeContextText } from "../context/messages.mjs";

export function buildImageContextMessage(description, options = {}) {
  const clean = description ? safeContextText(description, 800) : "";
  if (!clean) {
    return {
      role: "user",
      content: [
        "[当前图片识别状态]",
        "图片数量=" + Math.max(1, Number(options.imageCount || 1)),
        "视觉识别失败。不能声称看到了具体人物、文字、动作或梗。",
      ].join("\n"),
    };
  }
  return {
    role: "user",
    content: [
      "[当前图片客观描述]",
      clean,
      "理解要求：客观描述只是候选证据；表情包的实际意思必须结合被回复消息和最近对话判断。",
    ].join("\n"),
  };
}

export function appendImageContext(history, description, options = {}) {
  const items = Array.isArray(history) ? history.slice() : [];
  items.push(buildImageContextMessage(description, options));
  return items;
}
