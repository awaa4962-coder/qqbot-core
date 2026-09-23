import { VISION_IMAGE_LIMITS as LIMITS } from "./images.mjs";

// Only pixel data prepared for this turn is exempt from the text/protocol budget.
export function measureVisionRequest(request) {
  if (["messages", "input", "contents", "tools", "tool_choice"].some(key => Object.hasOwn(request.extra || {}, key))) throw invalidImage();
  assertExtraFields(request.extra);
  const trusted = new Set(request.trustedImageUrls || []);
  let imageBytes = 0;
  let images = 0;
  const messages = (request.messages || []).map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => {
      if (part?.type !== "image_url") {
        if (part && typeof part === "object" && Object.hasOwn(part, "image_url")) throw invalidImage();
        return part;
      }
      const url = part.image_url?.url;
      if (message.role !== "user" || !trusted.has(url) || typeof url !== "string") throw invalidImage();
      const bytes = jpegByteLength(url);
      if (!bytes || bytes > LIMITS.maxNormalizedBytes || ++images > LIMITS.maxImages) throw invalidImage();
      imageBytes += bytes;
      if (imageBytes > LIMITS.maxTotalNormalizedBytes) throw invalidImage();
      return { ...part, image_url: { ...part.image_url, url: "[prepared-image]" } };
    }) };
  });
  const controls = { extra: request.extra, thinking: request.thinking, reasoning: request.reasoning, toolChoice: request.toolChoice };
  const controlChars = Object.values(controls).some(value => value !== undefined && value !== null) ? JSON.stringify(controls).length : 0;
  return { chars: JSON.stringify(messages).length + JSON.stringify(request.tools || []).length + controlChars,
    images, imageBytes };
}

function assertExtraFields(extra) {
  if (extra === undefined || extra === null) return;
  const protectedKeys = ["system", "instructions", "systemInstruction", "system_instruction", "model", "max_tokens", "max_completion_tokens",
    "max_output_tokens", "generationConfig", "thinking", "reasoning", "reasoning_effort", "stream", "previous_response_id", "conversation", "cachedContent"];
  if (typeof extra !== "object" || Array.isArray(extra) || protectedKeys.some(key => Object.hasOwn(extra, key))) {
    throw Object.assign(new Error("tool_context_override"), { code: "CHAT_TOOL_STOPPED" });
  }
}

function jpegByteLength(url) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[1].length % 4 !== 0) throw invalidImage();
  return match[1].length / 4 * 3 - (match[1].match(/=+$/)?.[0].length || 0);
}

function invalidImage() { return Object.assign(new Error("image_input_budget"), { code: "CHAT_TOOL_STOPPED" }); }
