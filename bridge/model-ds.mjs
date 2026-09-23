// Private/file chat and group fallback; task routes select the actual provider.
import { LONG_GROUPS } from "./config.mjs";
import { logE } from "./logger.mjs";
import { buildModelPrompt } from "./system-prompts/compose.mjs";
import { runScopedChat } from "./chat-tools/runner.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { chatError } from "./chat-outcome.mjs";
import { selectPersonaCue } from "./persona-style.mjs";

function buildDeepSeekMessages(userMsg, userName, history, options) {
  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);
  const currentInput = typeof options.currentInput === 'string' ? options.currentInput : buildCurrentInput(userName, userMsg, options.currentUserId);
  msgs.push({ role: 'user', content: currentInput });
  return msgs;
}

function resolveDeepSeekMaxTokens(groupId, isAtMe) {
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  return isAtMe ? (isLong ? 1024 : 1536) : 150;
}

export async function tryDeepSeek(userMsg, userName, history, groupId, isAtMe, mood, options = {}) {
  return (await tryDeepSeekResult(userMsg, userName, history, groupId, isAtMe, mood, options)).text;
}

export async function tryDeepSeekResult(userMsg, userName, history, groupId, isAtMe, mood, options = {}) {
  if (isAtMe === undefined) isAtMe = true;
  const maxTok = resolveDeepSeekMaxTokens(groupId, isAtMe);
  const msgs = buildDeepSeekMessages(userMsg, userName, history, options);

  const personaCue = options.personaCue || selectPersonaCue(userMsg, {
    replyMode: options.replyMode || "chat",
  });
  const prompt = buildModelPrompt({
    ...options,
    personaCue, groupId, mood,
  });

  try {
    const privateRequest = isPrivateModelRequest(groupId);
    const task = options.task || (privateRequest ? "private_chat" : "group_chat");
    const request = {
      messages: [{ role: 'system', content: prompt.system }, prompt.dynamicMessage, ...msgs],
      maxTokens: maxTok,
      temperature: 0.7,
      timeoutMs: 30000,
      usageContext: buildDeepSeekUsageContext(options, task, privateRequest),
      selfContext: { surface: privateRequest ? "private" : "group", groupId, userId: options.currentUserId },
      promptMetadata: prompt.metadata,
    };
    return await runScopedChat(request, { ...options, task, userMessage: userMsg,
      position: options.position || (privateRequest ? "primary" : "fallback") });
  } catch (e) {
    logE('tryDeepSeek error:', e.message);
    return chatError("request_failed");
  }
}

function buildDeepSeekUsageContext(options, task, privateRequest) {
  return {
    userId: options.currentUserId,
    task,
    position: options.position || (privateRequest ? "primary" : "fallback"),
  };
}

function isPrivateModelRequest(groupId) {
  return groupId === null || groupId === undefined;
}
