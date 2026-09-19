import { getActiveMemoryContext } from "../../memory-profile.mjs";
import { resolveMentionDisplayName } from "../../mentions/index.mjs";
import { computeRelationship, scopeRelationshipUser } from "../../relationship.mjs";
import { getRelationshipShortComment } from "../../relationship-comment.mjs";
import { buildRelationshipSummary } from "../../relationship-commands.mjs";
import { getUserMemoryGeneration } from "../../memory-profile/generation.mjs";

export function buildRelationshipCommandReply(cmd, options) {
  const { relation, target, displayUser } = buildRelationshipData(options);
  return buildRelationshipSummary(relation, cmd, {
    nicknames: displayUser?.nicknames || [],
    subjectName: target.isSelf ? "" : target.displayName,
  });
}

export async function buildRelationshipCommandReplyAsync(cmd, options) {
  const { relation, target, user, displayUser } = buildRelationshipData(options);
  const generation = getUserMemoryGeneration(target.uid);
  const shortComment = relation ? await getRelationshipShortComment(relation, {
    user,
    uid: target.uid,
    groupId: options.groupId,
    now: options.now,
    callMiMo: options.callMiMo,
    callDeepSeek: options.callDeepSeek,
  }) : "";
  if (generation !== getUserMemoryGeneration(target.uid)) return "资料已更新，请重新查询。";
  return buildRelationshipSummary(relation, cmd, {
    nicknames: displayUser?.nicknames || [],
    subjectName: target.isSelf ? "" : target.displayName,
    shortComment,
  });
}

function buildRelationshipData(options) {
  const target = resolveRelationshipTarget(options);
  const uid = target.uid;
  const user = options.users?.[uid] || null;
  const isGroup = Boolean(options.groupId && String(options.groupId) !== "private");
  const context = options.memoryContext || getActiveMemoryContext(uid, options.groupId, { groupOnly: isGroup });
  const memoryContext = isGroup ? { ...context, userProfile: null } : context;
  const displayUser = isGroup ? scopeRelationshipUser(user, options.groupId) : user;
  const relation = displayUser ? computeRelationship(displayUser, {
    currentGroupId: options.groupId,
    currentGroupChats: options.groupChats || [],
    memoryContext,
  }) : null;
  return { relation, target, user, displayUser };
}

function resolveRelationshipTarget(options = {}) {
  const selfUid = String(options.userId || "");
  const mention = firstMentionedUser(options);
  if (!mention) return { uid: selfUid, isSelf: true, displayName: "" };
  const uid = String(mention.qq || "");
  return {
    uid,
    isSelf: uid === selfUid,
    displayName: resolveMentionDisplayName(uid, {
      ...options,
      mention,
    }),
  };
}

function firstMentionedUser(options) {
  const mentions = Array.isArray(options.mentionedUsers)
    ? options.mentionedUsers
    : [];
  return mentions.find(item => !item.isBot && !item.isAll) || null;
}
