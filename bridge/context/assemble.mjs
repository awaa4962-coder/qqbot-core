import { buildLayeredReplyContext } from "../context-retriever.mjs";
import { enforceContextBudget } from "./budget.mjs";
import { deriveReplyMode, isPassiveMode } from "./policy.mjs";

export function buildReplyContextPacket(options = {}) {
  const mode = deriveReplyMode(options);
  const uid = String(options.uid || options.userId || "");
  const groupId = String(options.groupId || options.group_id || "");
  const layered = buildLayeredReplyContext({
    ...options,
    uid,
    groupId,
    isPassiveInterjection: isPassiveMode(mode),
  });
  const imageContextBudget = isPassiveMode(mode) && options.hasImages
    ? { maxChars: 1800, maxMessages: 6, maxMessageChars: 900 }
    : {};
  const bounded = enforceContextBudget(layered.history, layered.currentInput, {
    mode,
    ...imageContextBudget,
    ...(options.contextBudget || {}),
  });
  const messages = bounded.messages;
  return {
    mode,
    messages,
    history: messages,
    currentInput: layered.currentInput,
    mood: layered.mood,
    memory: layered.memory,
    thread: buildThreadMetadata(layered.thread),
    metadata: {
      uid,
      groupId,
      hasQuotedMessage: Boolean(options.replyText),
      mentionedUsers: Array.isArray(options.mentions)
        ? options.mentions.filter(item => !item.isBot && !item.isAll).map(item => String(item.qq))
        : [],
      userName: options.userName || options.nickname || "",
      hasImages: Boolean(options.hasImages),
      imageCount: Number(options.imageCount || 0),
    },
    budget: bounded.budget,
  };
}

function buildThreadMetadata(thread) {
  if (!thread) return null;
  return {
    scope: thread.scope,
    topic: thread.topic,
    turnCount: thread.turnCount,
    updatedAt: thread.updatedAt,
    expiresAt: thread.expiresAt,
    privacy: thread.privacy,
  };
}
