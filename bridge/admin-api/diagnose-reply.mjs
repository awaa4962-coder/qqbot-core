// bridge/admin-api/diagnose-reply.mjs - dry-run reply routing diagnostics.

import { CFG } from "../config.mjs";
import { parseExplicitLinkPreviewCommand, parseIncomingEvent } from "../reply-handlers.mjs";
import { buildInterjectionDecision, classifyInterjectionTrigger } from "../interjection-policy.mjs";
import {
  isAdminUser,
  isKnownCommand,
  normalizeCommand,
} from "../admin-commands.mjs";
import { parseWordcloudCommand } from "../features/wordcloud/index.mjs";
import { parseJmCommand } from "../jm-provider.mjs";
import { parseResourceTransferCommand } from "../resource-transfer.mjs";
import { getAdmissionStatus } from "../event-admission.mjs";
import { getPipelineStatus } from "../pipeline-state.mjs";

export function buildReplyDiagnosis(input = {}, options = {}) {
  const event = normalizeDiagnosticEvent(input);
  const ctx = parseIncomingEvent(event);
  const cfg = options.cfg || CFG;
  const state = buildStaticInterjectionState();
  const result = {
    ok: true,
    dryRun: true,
    safety: {
      sendsMessage: false,
      writesStorage: false,
      callsModel: false,
    },
    input: {
      messageType: ctx.message_type || null,
      groupId: ctx.group_id,
      userId: ctx.user_id,
      textLength: ctx.text.length,
      imageCount: ctx.images.length,
      fileCount: ctx.files.length,
    },
    gates: buildGateDiagnosis(ctx, cfg),
    mentions: {
      isAtMe: ctx.isAtMe,
      count: ctx.mentions.length,
      mentionedUsers: ctx.mentionedUsers,
    },
    command: buildCommandDiagnosis(ctx, cfg),
    interjection: buildInterjectionDiagnosis(ctx, state),
    runtimePressure: {
      admission: getAdmissionStatus(),
      pipeline: getPipelineStatus(),
    },
  };
  result.replyPlan = buildReplyPlan(result, ctx);
  return result;
}

export function normalizeDiagnosticEvent(input = {}) {
  if (input.event && typeof input.event === "object") return input.event;
  const messageType = resolveDiagnosticMessageType(input);
  const text = resolveDiagnosticText(input);

  return {
    post_type: "message",
    message_type: messageType,
    group_id: input.group_id ?? input.groupId ?? null,
    user_id: input.user_id ?? input.userId ?? 10000,
    message_id: input.message_id ?? input.messageId ?? 1,
    raw_message: String(input.raw_message ?? input.rawText ?? text),
    message: normalizeDiagnosticMessage(input.message, text),
    sender: normalizeDiagnosticSender(input),
  };
}

function resolveDiagnosticMessageType(input) {
  if (input.message_type || input.messageType) return input.message_type || input.messageType;
  return input.group_id || input.groupId ? "group" : "private";
}

function resolveDiagnosticText(input) {
  return input.raw_message ?? input.rawText ?? input.text ?? input.message ?? "";
}

function normalizeDiagnosticMessage(message, text) {
  if (Array.isArray(message)) return message;
  return [{ type: "text", data: { text: String(text) } }];
}

function normalizeDiagnosticSender(input) {
  return input.sender || {
    nickname: input.nickname || "diagnostic-user",
    card: input.card || "",
  };
}

function buildGateDiagnosis(ctx, cfg) {
  const isMessageEvent = ctx.message_type === "private" || ctx.message_type === "group";
  const blacklisted = cfg.botBlacklist.includes(ctx.user_id);
  const groupWhitelisted = ctx.message_type === "group" ? cfg.groupWhitelist.includes(ctx.group_id) : null;
  const privateFriendWhitelisted = ctx.message_type === "private" ? cfg.friendWhitelist.includes(ctx.user_id) : null;
  const admin = isAdminUser(ctx.user_id, cfg.adminUins);
  const allowed = isMessageEvent &&
    !blacklisted &&
    (ctx.message_type === "group" ? groupWhitelisted : (privateFriendWhitelisted || admin));
  return {
    isMessageEvent,
    blacklisted,
    groupWhitelisted,
    privateFriendWhitelisted,
    admin,
    allowed,
    blockedReasons: blockedReasons({ isMessageEvent, blacklisted, groupWhitelisted, privateFriendWhitelisted, admin }, ctx),
  };
}

function blockedReasons(gates, ctx) {
  const reasons = [];
  if (!gates.isMessageEvent) reasons.push("not_message_event");
  if (gates.blacklisted) reasons.push("bot_blacklist");
  if (ctx.message_type === "group" && gates.groupWhitelisted === false) reasons.push("group_not_whitelisted");
  if (ctx.message_type === "private" && !gates.privateFriendWhitelisted && !gates.admin) reasons.push("private_not_whitelisted");
  return reasons;
}

function buildCommandDiagnosis(ctx, cfg) {
  const requireMention = ctx.message_type === "group";
  const source = ctx.text || ctx.rawText;
  const parserOptions = {
    requireMention,
    selfUin: cfg.selfUin,
    botNames: cfg.botNames,
  };
  const normalized = normalizeCommand(ctx.text || ctx.rawText, {
    ...parserOptions,
  });
  const mentionSatisfied = ctx.message_type === "private" || ctx.isAtMe;
  const route = detectCommandRoute(ctx, source, normalized, parserOptions);
  const known = Boolean(route);
  return {
    requireMention,
    mentionSatisfied,
    normalized,
    known,
    route,
    wouldHandle: known && mentionSatisfied,
  };
}

function detectCommandRoute(ctx, source, normalized, parserOptions) {
  if (parseJmCommand(source, parserOptions)) return "jm";
  if (ctx.message_type === "group") {
    if (parseResourceTransferCommand(source, parserOptions)) return "resource_transfer";
    if (parseExplicitLinkPreviewCommand(source, parserOptions)) return "link_preview";
    if (parseWordcloudCommand(source, parserOptions)) return "wordcloud";
  }
  if (normalized && isKnownCommand(normalized)) return "command_registry";
  return "";
}

function buildInterjectionDiagnosis(ctx, state) {
  if (ctx.message_type !== "group") {
    return { applicable: false, reason: "private_message" };
  }
  const decision = buildInterjectionDecision(ctx.text, {
    isAtMe: ctx.isAtMe,
    previewSent: false,
    groupId: ctx.group_id,
    userId: ctx.user_id,
    hasImages: ctx.images.length > 0,
    random: () => 1,
    now: Date.now(),
  }, state);
  return {
    applicable: true,
    kind: classifyInterjectionTrigger(ctx.text, { hasImages: ctx.images.length > 0 }),
    decision: {
      ok: decision.ok,
      reason: decision.reason,
      probability: decision.probability,
    },
  };
}

function buildReplyPlan(result, ctx) {
  const blocked = blockedReplyPlan(result);
  if (blocked) return blocked;
  if (result.command.wouldHandle) {
    return { action: "command_reply", reason: result.command.route || "known_command" };
  }
  if (ctx.message_type === "private") return privateReplyPlan(ctx);
  if (ctx.message_type === "group") return groupReplyPlan(result, ctx);
  return { action: "ignore", reason: "unknown_message_type" };
}

function blockedReplyPlan(result) {
  if (result.gates.allowed) return null;
  return { action: "ignore", reason: result.gates.blockedReasons[0] || "blocked" };
}

function privateReplyPlan(ctx) {
  if (ctx.files.length) return { action: "private_file_ai_reply", reason: "private_file" };
  if (ctx.text || ctx.images.length) return { action: "private_ai_reply", reason: "private_allowed" };
  return { action: "ignore", reason: "empty_private_message" };
}

function groupReplyPlan(result, ctx) {
  if (ctx.isAtMe) return { action: "group_ai_reply", reason: "mentioned_bot" };
  if (ctx.files.length && !ctx.text && !ctx.images.length) {
    return { action: "group_file_notice", reason: "pure_file_message" };
  }
  return {
    action: result.interjection?.decision?.ok ? "random_interjection" : "ignore",
    reason: result.interjection?.decision?.reason || "not_mentioned",
  };
}

function buildStaticInterjectionState() {
  return {
    lastGroupAt: new Map(),
    lastUserAt: new Map(),
    groupMessagesSinceInterjection: new Map([["default", 3]]),
  };
}
